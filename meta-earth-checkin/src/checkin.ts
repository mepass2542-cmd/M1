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
// Source: repos/meta-earth-js-sdk/src/config/define.ts (MAIN_NET_CONFIG / TEST_NET_CONFIG)
// netType=rollapp_checkin confirmed from successful tx explorer link
const ROLLUP_RPC: Record<string, string> = {
  mainnet: 'http://118.175.0.247:23011',
  testnet: 'http://118.175.0.249:46657',
};
const ROLLUP_CHAIN_ID: Record<string, string> = {
  mainnet: 'mecheckin_101-1',
  testnet: 'mecheckin_100-1',
};
const ADDRESS_PREFIX = 'me';

// ── stchain.rollapp.checkin.MsgCheckIn ────────────────────────────────────────
// Confirmed from live mempool decode: all real Meta Earth check-in txs use this
// type URL with exactly 2 fields. No timezone field on the rollup chain.
//
// Fields (2):
//   checkInAddress (1) — wallet address
//   checkInMessage (2) — check-in message string
//
// Fee: IBC MEC denom with amount "0", gas 500000
//   Real txs include the IBC denom even at zero amount. Empty amount array []
//   produces a different encoding that shows as "ShowE" instead of "Daily Sign-in".
//   Gas limit matches real txs: 500000.
//
// Broadcast: broadcastTxAsync — bypasses CheckTx so txs enter mempool.
const CHECKIN_TYPE_URL = '/stchain.rollapp.checkin.MsgCheckIn';

// IBC-bridged MEC denom on the rollup (confirmed from real mempool tx)
const ROLLUP_IBC_DENOM =
  'ibc/BC7F4D581D88785A22824C8FB6807DFC3B65C1764AFF1230D954AAB06B70CBC5';

// Configurable check-in message — Meta Earth app uses "META EARTH! ME, My Way!"
const CHECK_IN_MESSAGE = process.env.CHECK_IN_MESSAGE ?? 'META EARTH! ME, My Way!';

// Fee matches real check-in txs: IBC denom with amount "0", gas 500000
const CHECKIN_FEE = {
  amount: [{ denom: ROLLUP_IBC_DENOM, amount: '0' }],
  gas: '500000',
};

// ── Protobuf type (3 fields — from mechain/checkin/tx.proto) ─────────────────
function buildMsgCheckInType(): Type {
  const root = new Root();
  const T = new Type('MsgCheckIn')
    .add(new Field('checkInAddress',  1, 'string'))
    .add(new Field('checkInMessage',  2, 'string'))
    .add(new Field('checkInTimezone', 3, 'string'));
  root.add(T);
  return T;
}
const MsgCheckInType = buildMsgCheckInType();

// ── Raw tx encoder ─────────────────────────────────────────────────────────────
function encodeTxRaw(txRaw: {
  bodyBytes: Uint8Array;
  authInfoBytes: Uint8Array;
  signatures: Uint8Array[];
}): Uint8Array {
  const w = new Writer();
  if (txRaw.bodyBytes?.length) w.uint32(10).bytes(txRaw.bodyBytes);
  if (txRaw.authInfoBytes?.length) w.uint32(18).bytes(txRaw.authInfoBytes);
  for (const sig of txRaw.signatures ?? []) w.uint32(26).bytes(sig);
  return w.finish();
}

// ── Signer builder ────────────────────────────────────────────────────────────
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

// ── Check-in ──────────────────────────────────────────────────────────────────

export async function performCheckin(
  wallet: WalletInfo,
  network = 'mainnet',
): Promise<{ success: boolean; txHash?: string; error?: string; note?: string }> {
  const rpc = ROLLUP_RPC[network] ?? ROLLUP_RPC.mainnet;
  const chainId = ROLLUP_CHAIN_ID[network] ?? ROLLUP_CHAIN_ID.mainnet;

  log(`Starting daily check-in for ${wallet.label} (${wallet.address})`);
  log(`  module   : mechain.checkin.MsgCheckIn`);
  log(`  rpc      : ${rpc}`);
  log(`  message  : ${CHECK_IN_MESSAGE}`);
  log(`  timezone : ${CHECK_IN_TIMEZONE}`);
  log(`  fee      : zero (amount: [], gas: 200000)`);
  log(`  broadcast: broadcastTxAsync`);

  try {
    const signer = await buildSigner(wallet);
    const registry = new Registry([...defaultRegistryTypes]);
    registry.register(CHECKIN_TYPE_URL, MsgCheckInType as any);
    const tmClient = await Tendermint37Client.connect(rpc);
    const client = await SigningStargateClient.createWithSigner(tmClient, signer, { registry });

    let accountNumber = 0;
    let sequence = 0;
    try {
      const acct = await client.getSequence(wallet.address);
      accountNumber = acct.accountNumber;
      sequence = acct.sequence;
    } catch {
      return {
        success: false,
        error: 'Account not found on chain — wallet must receive tokens to activate before it can check in',
      };
    }

    const msg = {
      typeUrl: CHECKIN_TYPE_URL,
      value: MsgCheckInType.fromObject({
        checkInAddress:  wallet.address,
        checkInMessage:  CHECK_IN_MESSAGE,
        checkInTimezone: CHECK_IN_TIMEZONE,
      }),
    };

    const signed = await client.sign(wallet.address, [msg], CHECKIN_FEE, '', {
      accountNumber,
      sequence,
      chainId,
    });
    const txBytes = encodeTxRaw(signed);
    const res = await tmClient.broadcastTxAsync({ tx: txBytes });
    const txHash = Buffer.from(res.hash).toString('hex').toUpperCase();

    // broadcastTxAsync = mempool acceptance is sufficient.
    // The rollup stopped producing blocks 2026-05-01; the Meta Earth backend
    // records check-ins from mempool — no need to poll for block inclusion.
    log(`${wallet.label} check-in broadcast accepted. TX: ${txHash}`);
    return { success: true, txHash };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ── Batch runner ──────────────────────────────────────────────────────────────

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
