import {
  DirectSecp256k1HdWallet,
  DirectSecp256k1Wallet,
  Registry,
  OfflineSigner,
} from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';
import { Tendermint37Client } from '@cosmjs/tendermint-rpc';
import { Type, Field, Root, Writer } from 'protobufjs';
import { log, logError } from './logger';
import { WalletInfo } from './wallet';

/**
 * ─── ROLLUP (mecheckin_101-1) ─────────────────────────────────────────────────
 * The "Daily Check-IN" transaction lives on the rollup chain.
 *
 * Type URL confirmed by decoding real on-chain blocks:
 *   /stchain.rollapp.checkin.MsgCheckIn
 *
 * The rollup enforces a minimum gas price of 0.001 umec but accepts
 * transactions with an EMPTY fee array — no IBC bridging required.
 */
const ROLLUP_RPC: Record<string, string> = {
  mainnet: 'http://118.175.0.247:23011',
  testnet: 'http://118.175.0.249:46657',
};

const ROLLUP_CHAIN_ID: Record<string, string> = {
  mainnet: 'mecheckin_101-1',
  testnet: 'mecheckin_100-1',
};

const ADDRESS_PREFIX = 'me';

const MSG_TYPE_URL = '/stchain.rollapp.checkin.MsgCheckIn';

/** Zero-fee — rollup accepts txs with no fee coins. */
const ROLLUP_FEE = { amount: [] as { denom: string; amount: string }[], gas: '200000' };

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

/**
 * The check-in message. Override with CHECK_IN_MESSAGE env var.
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
 * Perform a daily check-in (MsgCheckIn) for a single wallet on the rollup chain.
 * No IBC bridge needed — the rollup accepts zero-fee transactions.
 */
export async function performCheckin(
  wallet: WalletInfo,
  network: string = 'mainnet'
): Promise<{ success: boolean; txHash?: string; error?: string }> {
  const checkInMessage = getCheckInMessage();
  const rpcUrl = ROLLUP_RPC[network] ?? ROLLUP_RPC.mainnet;
  const chainId = ROLLUP_CHAIN_ID[network] ?? 'mecheckin_101-1';

  log(`Starting daily check-in for ${wallet.label} (${wallet.address})`);
  log(`  message: ${checkInMessage}`);
  log(`  chain:   ${chainId} (rollup)`);
  log(`  rpc:     ${rpcUrl}`);

  try {
    const signer = await buildSigner(wallet);

    const registry = new Registry();
    registry.register(MSG_TYPE_URL, MsgCheckInType as any);

    const tmClient = await Tendermint37Client.connect(rpcUrl);
    const client = await SigningStargateClient.createWithSigner(tmClient, signer, { registry });

    let accountNumber = 0;
    let sequence = 0;
    try {
      const acct = await client.getSequence(wallet.address);
      accountNumber = acct.accountNumber;
      sequence = acct.sequence;
      log(`${wallet.label}: accountNumber=${accountNumber}, sequence=${sequence}`);
    } catch {
      log(`${wallet.label}: account not yet on rollup — using accountNumber=0, sequence=0`);
    }

    const msg = {
      typeUrl: MSG_TYPE_URL,
      value: {
        checkInAddress: wallet.address,
        checkInMessage,
      },
    };

    // Try broadcasting, retrying once if the chain reports a sequence mismatch
    // (the mempool may have pending txs with sequences ahead of committed state).
    for (let attempt = 0; attempt < 3; attempt++) {
      const signerData = { accountNumber, sequence, chainId };
      const signed = await client.sign(wallet.address, [msg], ROLLUP_FEE, '', signerData);
      const txBytes = encodeTxRaw(signed);

      // Use broadcastTxSync — returns after mempool check, avoids long commit waits.
      const syncRes = await tmClient.broadcastTxSync({ tx: txBytes });
      const txHash = Buffer.from(syncRes.hash).toString('hex').toUpperCase();

      if (syncRes.code === 0) {
        log(`${wallet.label} check-in SUCCESS. TX: ${txHash}`);
        return { success: true, txHash };
      }

      const errLog = syncRes.log ?? syncRes.codespace ?? '';

      // Code 32 = sequence mismatch — parse the expected sequence and retry.
      if (syncRes.code === 32) {
        const match = errLog.match(/expected (\d+)/);
        if (match) {
          const expected = parseInt(match[1], 10);
          log(`${wallet.label}: sequence mismatch (got ${sequence}, expected ${expected}) — retrying with ${expected}`);
          sequence = expected;
          continue;
        }
      }

      logError(`${wallet.label} check-in FAILED (code ${syncRes.code}): ${errLog}`);
      return { success: false, error: `code ${syncRes.code}: ${errLog}` };
    }

    return { success: false, error: 'sequence retry limit exceeded' };

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
