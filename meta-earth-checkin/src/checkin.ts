import {
  DirectSecp256k1HdWallet,
  DirectSecp256k1Wallet,
  Registry,
  OfflineSigner,
} from '@cosmjs/proto-signing';
import { SigningStargateClient, defaultRegistryTypes } from '@cosmjs/stargate';
import { Type, Field, Root } from 'protobufjs';
import { log, logError } from './logger';
import { WalletInfo } from './wallet';

// ── Chain config ───────────────────────────────────────────────────────────────
// Daily check-in goes to the me-hub (me-chain) — the hub is LIVE (block 13345451+).
// MsgCheckIn gets freeGas = true in fee_deduct.go line 100-101, so fee is zero.
// broadcastTxSync works fine — no custom CheckTx parser for checkin msgs.
const HUB_RPC: Record<string, string> = {
  mainnet: 'http://118.175.0.247:16657',
  testnet: 'http://118.175.0.249:16657',
};
const HUB_CHAIN_ID: Record<string, string> = {
  mainnet: 'me-chain',
  testnet: 'me-chain-testnet',
};
const ADDRESS_PREFIX = 'me';

// ── Check-in type ──────────────────────────────────────────────────────────────
// /mechain.checkin.MsgCheckIn — 3 fields, confirmed from:
//   repos/meta-earth/proto/mechain/checkin/tx.proto
//   repos/meta-earth/x/checkin/types/tx.pb.go
const CHECKIN_TYPE_URL = '/mechain.checkin.MsgCheckIn';

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

// Hub MsgCheckIn gets freeGas in fee_deduct.go (lines 100-101).
// Must still provide a positive gas limit (chain rejects gas=0 at block height > 0).
const HUB_FEE = {
  amount: [] as { denom: string; amount: string }[],
  gas: '200000',
};

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
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const rpc     = HUB_RPC[network]     ?? HUB_RPC.mainnet;
  const chainId = HUB_CHAIN_ID[network] ?? HUB_CHAIN_ID.mainnet;
  const message  = process.env.CHECK_IN_MESSAGE  ?? 'ME, My Way!';
  const timezone = process.env.CHECK_IN_TIMEZONE ?? 'UTC';

  log(`Starting daily check-in for ${wallet.label} (${wallet.address})`);
  log(`  chain    : ${chainId} (hub — live, freeGas for MsgCheckIn)`);
  log(`  typeUrl  : ${CHECKIN_TYPE_URL}`);
  log(`  message  : ${message}`);
  log(`  timezone : ${timezone}`);
  log(`  rpc      : ${rpc}`);
  log(`  fee      : zero amount, gas 200000, broadcastTxSync`);

  try {
    const signer = await buildSigner(wallet);
    const registry = new Registry([...defaultRegistryTypes]);
    registry.register(CHECKIN_TYPE_URL, MsgCheckInType as any);

    const client = await SigningStargateClient.connectWithSigner(rpc, signer, {
      registry,
    });

    const msg = {
      typeUrl: CHECKIN_TYPE_URL,
      value: MsgCheckInType.fromObject({
        checkInAddress:  wallet.address,
        checkInMessage:  message,
        checkInTimezone: timezone,
      }),
    };

    const result = await client.signAndBroadcast(wallet.address, [msg], HUB_FEE, '');

    if (result.code !== 0) {
      return { success: false, error: `code ${result.code}: ${result.rawLog ?? ''}` };
    }

    log(`${wallet.label} check-in confirmed on hub. TX: ${result.transactionHash}`);
    return { success: true, txHash: result.transactionHash };
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
