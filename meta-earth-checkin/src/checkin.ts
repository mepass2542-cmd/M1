import {
  DirectSecp256k1HdWallet,
  DirectSecp256k1Wallet,
  Registry,
  OfflineSigner,
} from '@cosmjs/proto-signing';
import { SigningStargateClient, StargateClient } from '@cosmjs/stargate';
import { Type, Field, Root, Writer } from 'protobufjs';
import { log, logError } from './logger';
import { WalletInfo } from './wallet';

/**
 * ─── ROLLUP (mecheckin_101-1) ─────────────────────────────────────────────────
 * The "Daily Check-IN" transaction lives on the rollup, NOT on me-hub.
 *
 * Type URL confirmed by decoding real on-chain blocks:
 *   /stchain.rollapp.checkin.MsgCheckIn
 * (the meta-earth repo uses mechain.checkin, which is NOT what the deployed binary uses)
 *
 * Fee denom is IBC-bridged MEC via me-hub channel-0:
 *   ibc/BC7F4D581D88785A22824C8FB6807DFC3B65C1764AFF1230D954AAB06B70CBC5
 *   = SHA256("transfer/channel-0/umec") on the rollup side
 */
const ROLLUP_RPC: Record<string, string> = {
  mainnet: 'http://118.175.0.247:23011',
  testnet: 'http://118.175.0.249:46657',
};

const ROLLUP_REST: Record<string, string> = {
  mainnet: 'http://118.175.0.247:23013',
  testnet: 'http://118.175.0.249:46660',
};

const ROLLUP_CHAIN_ID: Record<string, string> = {
  mainnet: 'mecheckin_101-1',
  testnet: 'mecheckin_100-1',
};

/**
 * ─── ME-HUB ───────────────────────────────────────────────────────────────────
 * Used only for bridging MEC → rollup via IBC.
 */
const HUB_RPC = 'http://118.175.0.247:16657';
const HUB_CHAIN_ID = 'me-chain';
/** Fixed hub fee — chain enforces 10,000 umec minimum; 12,000 is safe. */
const HUB_FEE = { amount: [{ denom: 'umec', amount: '12000' }], gas: '500000' };

const ADDRESS_PREFIX = 'me';

/** Type URL confirmed from real on-chain block decoding. */
const MSG_TYPE_URL = '/stchain.rollapp.checkin.MsgCheckIn';

/**
 * IBC denom for MEC on the rollup.
 * = SHA256("transfer/channel-0/umec") — verified against channel-0 on me-hub.
 */
const ROLLUP_FEE_DENOM =
  'ibc/BC7F4D581D88785A22824C8FB6807DFC3B65C1764AFF1230D954AAB06B70CBC5';

/** Fee per check-in on the rollup (confirmed from real txs). */
const ROLLUP_CHECKIN_FEE_AMOUNT = 10_000;

/**
 * If rollup IBC denom balance drops below this, auto-bridge from hub.
 * 5 × check-in fee = covers 5 days before bridging again.
 */
const BRIDGE_THRESHOLD = ROLLUP_CHECKIN_FEE_AMOUNT * 5;

/**
 * Amount of umec to bridge in one go (covers ~30 check-ins).
 * Must be less than available hub balance minus hub fee.
 */
const BRIDGE_AMOUNT = ROLLUP_CHECKIN_FEE_AMOUNT * 30; // 300,000 umec

function buildMsgCheckInType(): Type {
  const root = new Root();
  const MsgCheckIn = new Type('MsgCheckIn')
    .add(new Field('checkInAddress', 1, 'string'))
    .add(new Field('checkInMessage', 2, 'string'));
  root.add(MsgCheckIn);
  return MsgCheckIn;
}

const MsgCheckInType = buildMsgCheckInType();

/**
 * Manually encode a TxRaw protobuf (avoids cosmjs-types import resolution issues).
 * TxRaw wire format:
 *   1: body_bytes      (bytes)
 *   2: auth_info_bytes (bytes)
 *   3: signatures      (repeated bytes)
 */
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

const ROLLUP_FEE = {
  amount: [{ denom: ROLLUP_FEE_DENOM, amount: String(ROLLUP_CHECKIN_FEE_AMOUNT) }],
  gas: '200000',
};

/**
 * The check-in slogan. Confirmed from real on-chain transactions.
 * Override with CHECK_IN_MESSAGE env var.
 */
function getCheckInMessage(): string {
  return process.env.CHECK_IN_MESSAGE || 'META EARTH! ME, My Way!';
}

/**
 * Build an OfflineSigner for the given WalletInfo.
 */
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

/**
 * Query the wallet's rollup IBC denom balance via REST.
 * Returns the balance amount in the rollup IBC denom (0 if none).
 */
async function getRollupIbcBalance(
  address: string,
  network: string
): Promise<number> {
  const restUrl = ROLLUP_REST[network] ?? ROLLUP_REST.mainnet;
  try {
    const res = await fetch(
      `${restUrl}/cosmos/bank/v1beta1/balances/${address}?pagination.limit=50`
    );
    const json = (await res.json()) as {
      balances?: Array<{ denom: string; amount: string }>;
    };
    const coin = (json.balances ?? []).find((b) => b.denom === ROLLUP_FEE_DENOM);
    return coin ? parseInt(coin.amount, 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * Query the wallet's hub umec balance via REST.
 */
async function getHubUmecBalance(address: string): Promise<number> {
  try {
    const res = await fetch(
      `http://118.175.0.247:11317/cosmos/bank/v1beta1/balances/${address}?pagination.limit=20`
    );
    const json = (await res.json()) as {
      balances?: Array<{ denom: string; amount: string }>;
    };
    const coin = (json.balances ?? []).find((b) => b.denom === 'umec');
    return coin ? parseInt(coin.amount, 10) : 0;
  } catch {
    return 0;
  }
}

/**
 * Bridge MEC from me-hub → rollup via IBC channel-0.
 * Uses sendIbcTokens from cosmjs/stargate.
 *
 * Returns true if bridge tx succeeded.
 */
async function bridgeMecToRollup(
  wallet: WalletInfo,
  amountUmec: number
): Promise<boolean> {
  log(`${wallet.label}: Bridging ${amountUmec} umec from me-hub → rollup via channel-0`);

  const hubUmec = await getHubUmecBalance(wallet.address);
  log(`${wallet.label}: Hub umec balance: ${hubUmec}`);

  const needed = amountUmec + parseInt(HUB_FEE.amount[0].amount, 10);
  if (hubUmec < needed) {
    logError(
      `${wallet.label}: Hub balance too low to bridge. Have ${hubUmec} umec, need ${needed} (${amountUmec} bridge + ${HUB_FEE.amount[0].amount} fee).`
    );
    return false;
  }

  try {
    const signer = await buildSigner(wallet);
    const hubClient = await SigningStargateClient.connectWithSigner(HUB_RPC, signer);

    const timeoutTimestamp = BigInt(Date.now() + 15 * 60 * 1000) * BigInt(1_000_000);

    const result = await hubClient.sendIbcTokens(
      wallet.address,
      wallet.address,
      { denom: 'umec', amount: String(amountUmec) },
      'transfer',
      'channel-0',
      undefined,
      Number(timeoutTimestamp),
      HUB_FEE,
      'Bridge MEC for daily check-in'
    );

    if (result.code !== 0) {
      logError(`${wallet.label}: Bridge failed (code ${result.code}): ${result.rawLog}`);
      return false;
    }

    log(`${wallet.label}: Bridge tx submitted. TX: ${result.transactionHash}`);
    log(`${wallet.label}: Waiting 15s for IBC relay...`);
    await sleep(15_000);
    return true;
  } catch (err: any) {
    logError(`${wallet.label}: Bridge error: ${err?.message ?? err}`);
    return false;
  }
}

/**
 * Perform a daily check-in (MsgCheckIn) for a single wallet on the rollup chain.
 * Auto-bridges MEC from hub if rollup IBC balance is too low.
 */
export async function performCheckin(
  wallet: WalletInfo,
  network: string = 'mainnet'
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const checkInMessage = getCheckInMessage();

  log(`Starting daily check-in for ${wallet.label} (${wallet.address})`);
  log(`  message: ${checkInMessage}`);
  log(`  chain:   ${ROLLUP_CHAIN_ID[network] ?? 'mecheckin_101-1'} (rollup)`);

  const rpcUrl = ROLLUP_RPC[network] ?? ROLLUP_RPC.mainnet;

  try {
    // ── Step 1: Ensure rollup IBC balance is sufficient ─────────────────────
    const ibcBalance = await getRollupIbcBalance(wallet.address, network);
    log(`${wallet.label}: Rollup IBC balance: ${ibcBalance} (need ${ROLLUP_CHECKIN_FEE_AMOUNT})`);

    if (ibcBalance < ROLLUP_CHECKIN_FEE_AMOUNT) {
      log(`${wallet.label}: Balance too low — attempting auto-bridge from hub`);
      const bridgeAmount = Math.max(BRIDGE_AMOUNT, ROLLUP_CHECKIN_FEE_AMOUNT * 2);
      const bridged = await bridgeMecToRollup(wallet, bridgeAmount);
      if (!bridged) {
        return {
          success: false,
          error: `Rollup IBC balance insufficient (${ibcBalance}) and bridge failed. Bridge MEC from me-hub manually.`,
        };
      }
      const newBalance = await getRollupIbcBalance(wallet.address, network);
      log(`${wallet.label}: Rollup IBC balance after bridge: ${newBalance}`);
      if (newBalance < ROLLUP_CHECKIN_FEE_AMOUNT) {
        return {
          success: false,
          error: `Rollup IBC balance still insufficient after bridge (${newBalance}). IBC relay may be slow — retry in a few minutes.`,
        };
      }
    } else if (ibcBalance < BRIDGE_THRESHOLD) {
      log(`${wallet.label}: Balance low (${ibcBalance}) — auto-bridging ${BRIDGE_AMOUNT} umec in background`);
      bridgeMecToRollup(wallet, BRIDGE_AMOUNT).catch((e) =>
        logError(`${wallet.label}: Background bridge error: ${e?.message}`)
      );
    }

    // ── Step 2: Build and send the check-in transaction ──────────────────────
    const signer = await buildSigner(wallet);

    const registry = new Registry();
    registry.register(MSG_TYPE_URL, MsgCheckInType as any);

    const client = await SigningStargateClient.connectWithSigner(rpcUrl, signer, { registry });

    const msg = {
      typeUrl: MSG_TYPE_URL,
      value: {
        checkInAddress: wallet.address,
        checkInMessage,
      },
    };

    let accountNumber = 0;
    let sequence = 0;
    try {
      const acct = await client.getSequence(wallet.address);
      accountNumber = acct.accountNumber;
      sequence = acct.sequence;
    } catch {
      log(`${wallet.label}: account not yet on rollup — using sequence=0`);
    }

    const chainId = ROLLUP_CHAIN_ID[network] ?? 'mecheckin_101-1';
    const signerData = { accountNumber, sequence, chainId };
    const signed = await client.sign(wallet.address, [msg], ROLLUP_FEE, 'Daily Check-IN', signerData);
    const txBytes = encodeTxRaw(signed);
    const result = await client.broadcastTx(txBytes);

    if (result.code !== 0) {
      const raw = result.rawLog ?? '';
      logError(`${wallet.label} check-in FAILED (code ${result.code}): ${raw}`);
      return { success: false, error: `code ${result.code}: ${raw}` };
    }

    log(`${wallet.label} check-in SUCCESS. TX: ${result.transactionHash}`);
    return { success: true, txHash: result.transactionHash };

  } catch (err: any) {
    const message: string = err?.message ?? String(err);
    logError(`${wallet.label} check-in FAILED: ${message}`);
    return { success: false, error: message };
  }
}

/**
 * Run check-in for ALL wallets sequentially.
 */
export async function runCheckinForAll(
  wallets: WalletInfo[],
  network: string = 'mainnet'
): Promise<void> {
  log(`=== Daily check-in for ${wallets.length} wallet(s) on ${network} ===`);

  const results: Array<{ wallet: string; success: boolean; error?: string }> = [];

  for (const wallet of wallets) {
    const result = await performCheckin(wallet, network);
    results.push({ wallet: wallet.label, ...result });
    if (wallets.length > 1) await sleep(2000);
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  log(`=== Done: ${succeeded} succeeded, ${failed} failed ===`);

  if (failed > 0) {
    results
      .filter((r) => !r.success)
      .forEach((f) => logError(`Failed: ${f.wallet} — ${f.error}`));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── One-off run ───────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    require('dotenv').config();
    const { loadAllWallets } = require('./wallet');
    const network = process.env.NETWORK || 'mainnet';
    const wallets = await loadAllWallets();
    await runCheckinForAll(wallets, network);
    process.exit(0);
  })();
}
