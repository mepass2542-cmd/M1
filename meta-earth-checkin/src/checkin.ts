import {
  DirectSecp256k1HdWallet,
  DirectSecp256k1Wallet,
  Registry,
  OfflineSigner,
} from '@cosmjs/proto-signing';
import { SigningStargateClient, defaultRegistryTypes } from '@cosmjs/stargate';
import { Tendermint37Client } from '@cosmjs/tendermint-rpc';
import { Type, Field, Root, Writer } from 'protobufjs';
import { log, logError } from './logger';
import { WalletInfo } from './wallet';

// ── Chain config ───────────────────────────────────────────────────────────────
// Daily check-in goes to the ROLLUP chain via broadcastTxAsync (mempool only).
// The rollup stopped producing blocks 2026-05-01, but the Meta Earth backend
// records check-ins from mempool acceptance. Confirmed from live mempool +
// explorer log (block 20275303, type stchain.rollapp.checkin.MsgCheckIn).
const ROLLUP_RPC: Record<string, string> = {
  mainnet: 'http://118.175.0.247:23011',
  testnet: 'http://118.175.0.249:46657',
};
const ROLLUP_CHAIN_ID: Record<string, string> = {
  mainnet: 'mecheckin_101-1',
  testnet: 'mecheckin_100-1',
};
const ADDRESS_PREFIX = 'me';

// ── Check-in type ──────────────────────────────────────────────────────────────
// Confirmed from live rollup mempool tx decode (2026-06-10):
//   Type URL: /stchain.rollapp.checkin.MsgCheckIn
//   Field 1: checkInAddress (wallet address)
//   Field 2: checkInMessage ("META EARTH! ME, My Way!")
//   2 fields only — verified by decoding raw protobuf bytes from live mempool txs.
const CHECKIN_TYPE_URL = '/stchain.rollapp.checkin.MsgCheckIn';

function buildMsgCheckInType(): Type {
  const root = new Root();
  const T = new Type('MsgCheckIn')
    .add(new Field('checkInAddress', 1, 'string'))
    .add(new Field('checkInMessage', 2, 'string'));
  root.add(T);
  return T;
}
const MsgCheckInType = buildMsgCheckInType();

// Zero-amount fee — rollup fee_checker.go has no minimum fee for DeliverTx.
// broadcastTxAsync bypasses CheckTx so zero-fee txs are accepted by the mempool.
const ROLLUP_FEE = {
  amount: [] as { denom: string; amount: string }[],
  gas: '200000',
};

// ── Minimal TxRaw encoder ────────────────────────────────────────────────────
function encodeTxRaw(txRaw: {
  bodyBytes: Uint8Array;
  authInfoBytes: Uint8Array;
  signatures: Uint8Array[];
}): Uint8Array {
  const w = new Writer();
  if (txRaw.bodyBytes?.length)     w.uint32(10).bytes(txRaw.bodyBytes);
  if (txRaw.authInfoBytes?.length) w.uint32(18).bytes(txRaw.authInfoBytes);
  for (const sig of txRaw.signatures ?? []) w.uint32(26).bytes(sig);
  return w.finish();
}

// ── Signer builder ───────────────────────────────────────────────────────────
async function buildSigner(wallet: WalletInfo): Promise<OfflineSigner> {
  if (wallet.privateKey) {
    const keyBytes = Buffer.from(wallet.privateKey, 'hex');
    return DirectSecp256k1Wallet.fromKey(new Uint8Array(keyBytes), ADDRESS_PREFIX);
  }
  if (wallet.mnemonic) {
    return DirectSecp256k1HdWallet.fromMnemonic(wallet.mnemonic, { prefix: ADDRESS_PREFIX });
  }
  throw new Error(`${wallet.label}: no mnemonic or private key available`);
}

// ── Check-in ─────────────────────────────────────────────────────────────────

export async function performCheckin(
  wallet: WalletInfo,
  network = 'mainnet',
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const rpc     = ROLLUP_RPC[network]     ?? ROLLUP_RPC.mainnet;
  const chainId = ROLLUP_CHAIN_ID[network] ?? ROLLUP_CHAIN_ID.mainnet;
  const message = process.env.CHECK_IN_MESSAGE ?? 'META EARTH! ME, My Way!';

  log(`Starting daily check-in for ${wallet.label} (${wallet.address})`);
  log(`  chain    : ${chainId} (rollup — mempool accepted by Meta Earth backend)`);
  log(`  typeUrl  : ${CHECKIN_TYPE_URL}`);
  log(`  message  : ${message}`);
  log(`  rpc      : ${rpc}`);
  log(`  fee      : zero, gas 200000, broadcastTxAsync`);

  try {
    const signer = await buildSigner(wallet);
    const registry = new Registry([...defaultRegistryTypes]);
    registry.register(CHECKIN_TYPE_URL, MsgCheckInType as any);

    const tmClient = await Tendermint37Client.connect(rpc);
    const client = await SigningStargateClient.createWithSigner(tmClient, signer, {
      registry,
      prefix: ADDRESS_PREFIX,
    });

    // Try to get sequence — if account not found, use 0/0 (rollup blocks not
    // produced so DeliverTx never runs; async mempool acceptance is all we need).
    let accountNumber = 0;
    let sequence = 0;
    try {
      const acct = await client.getSequence(wallet.address);
      accountNumber = acct.accountNumber;
      sequence = acct.sequence;
    } catch {
      log(`  account  : not found on rollup — using seq 0/0 (async broadcast only)`);
    }

    const msg = {
      typeUrl: CHECKIN_TYPE_URL,
      value: MsgCheckInType.fromObject({
        checkInAddress: wallet.address,
        checkInMessage: message,
      }),
    };

    const signed = await client.sign(wallet.address, [msg], ROLLUP_FEE, '', {
      accountNumber,
      sequence,
      chainId,
    });
    const txBytes = encodeTxRaw(signed);
    const res = await tmClient.broadcastTxAsync({ tx: txBytes });
    const txHash = Buffer.from(res.hash).toString('hex').toUpperCase();

    log(`${wallet.label} check-in accepted by rollup mempool. TX: ${txHash}`);
    return { success: true, txHash };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ── Batch runner ─────────────────────────────────────────────────────────────

export async function runCheckinForAll(
  wallets: WalletInfo[],
  network = 'mainnet',
): Promise<void> {
  log(`=== Daily check-in for ${wallets.length} wallet(s) on ${network} ===`);

  const results: Array<{
    wallet: string;
    success: boolean;
    txHash?: string;
    error?: string;
  }> = [];

  for (const wallet of wallets) {
    const result = await performCheckin(wallet, network);
    results.push({ wallet: wallet.label, ...result });
    if (wallets.length > 1) await sleep(2000);
  }

  const succeeded = results.filter(r => r.success).length;
  const failed    = results.filter(r => !r.success).length;
  log(`=== Done: ${succeeded} succeeded, ${failed} failed ===`);

  if (failed > 0) {
    results
      .filter(r => !r.success)
      .forEach(f => logError(`  Failed: ${f.wallet} — ${f.error}`));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
