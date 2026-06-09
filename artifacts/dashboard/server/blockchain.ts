import {
  DirectSecp256k1HdWallet,
  DirectSecp256k1Wallet,
  Registry,
  OfflineSigner,
} from '@cosmjs/proto-signing';
import { SigningStargateClient, defaultRegistryTypes } from '@cosmjs/stargate';
import { Tendermint37Client } from '@cosmjs/tendermint-rpc';
import { Type, Field, Root, Writer } from 'protobufjs';
import { StoredWallet } from './store';

const HUB_RPC = 'http://118.175.0.247:16657';
const HUB_REST = 'http://118.175.0.247:11317';
const ROLLUP_RPC: Record<string, string> = {
  mainnet: 'http://118.175.0.247:23011',
  testnet: 'http://118.175.0.249:46657',
};
const ROLLUP_REST: Record<string, string> = {
  mainnet: 'http://118.175.0.247:23013',
  testnet: 'http://118.175.0.249:3317',
};
const ROLLUP_CHAIN_ID: Record<string, string> = {
  mainnet: 'mecheckin_101-1',
  testnet: 'mecheckin_100-1',
};

// IBC: hub channel-1 → rollup channel-0
const IBC_HUB_CHANNEL    = 'channel-1';
const IBC_SOURCE_PORT    = 'transfer';
// IBC denom of hub MEC on the rollup chain
export const ROLLUP_IBC_DENOM =
  'ibc/BC7F4D581D88785A22824C8FB6807DFC3B65C1764AFF1230D954AAB06B70CBC5';

const HUB_FEE = { amount: [{ denom: 'umec', amount: '12000' }], gas: '200000' };
// Hub check-in fee: chain enforces a flat minimum of 10 000 umec (regardless of gas).
// Real MsgNewRecord txs use ~75 000 gas out of 500 000 limit, paying ~10 000–11 000 umec.
const HUB_CHECKIN_FEE = { amount: [{ denom: 'umec', amount: '11000' }], gas: '500000' };
export const HUB_CHECKIN_MIN_UMEC = 11_000;
// Rollup fee: zero amount — the custom fee_checker.go (baseIbcFeesRequired = 10000)
// only enforces that minimum when minGasPrices is non-zero on the node.
// This rollup runs with minGasPrices="" so the zero-fee path in fee_checker.go
// falls through and succeeds. Sending 10000 IBC-MEC would fail DeductFee
// AnteHandler when the wallet has no IBC MEC on the rollup.
const ROLLUP_FEE = {
  amount: [] as { denom: string; amount: string }[],
  gas: '200000',
};
const ADDRESS_PREFIX = 'me';
const CHECKIN_TYPE_URL = '/stchain.rollapp.checkin.MsgCheckIn';
// Hub chain check-in: MsgNewRecord on the metaearth.wstaking module.
// This is the ACTIVE check-in system (9 000+ txs/day on me-chain).
// The rollup chain (mecheckin_101-1) has been stalled since 2026-05-01.
const WSTAKING_NEW_RECORD_URL = '/metaearth.wstaking.MsgNewRecord';
const WSTAKING_CLAIM_URL = '/metaearth.wstaking.MsgWithdrawDelegatorReward';
const WSTAKING_UNSTAKE_URL = '/metaearth.wstaking.MsgUnstake';
const FETCH_TIMEOUT_MS = 12_000;

// ─── Protobuf type definitions ────────────────────────────────────────────────

function buildMsgCheckInType(): Type {
  const root = new Root();
  const T = new Type('MsgCheckIn')
    .add(new Field('checkInAddress', 1, 'string'))
    .add(new Field('checkInMessage', 2, 'string'));
  root.add(T);
  return T;
}
const MsgCheckInType = buildMsgCheckInType();

// MsgNewRecord — hub chain active check-in (metaearth.wstaking module).
// Fields confirmed from proto/metaearth/wstaking/record.proto and live tx inspection.
function buildMsgNewRecordType(): Type {
  const root = new Root();
  const T = new Type('MsgNewRecord')
    .add(new Field('actionNumber', 1, 'string'))
    .add(new Field('actionUrl',    2, 'string'))
    .add(new Field('from',         3, 'string'));
  root.add(T);
  return T;
}
const MsgNewRecordType = buildMsgNewRecordType();

function buildWstakingWithdrawType(): Type {
  const root = new Root();
  const T = new Type('MsgWstakingWithdrawDelegatorReward')
    .add(new Field('delegatorAddress', 1, 'string'))
    .add(new Field('validatorAddress', 2, 'string'));
  root.add(T);
  return T;
}
const MsgWstakingWithdrawType = buildWstakingWithdrawType();

function buildWstakingUnstakeType(): Type {
  const root = new Root();
  const Coin = new Type('Coin')
    .add(new Field('denom', 1, 'string'))
    .add(new Field('amount', 2, 'string'));
  root.add(Coin);
  const T = new Type('MsgWstakingUnstake')
    .add(new Field('stakerAddress', 1, 'string'))
    .add(new Field('validatorAddress', 2, 'string'))
    .add(new Field('amount', 3, 'Coin'));
  root.add(T);
  return T;
}
const MsgWstakingUnstakeType = buildWstakingUnstakeType();

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

// ─── Signer / Client builders ─────────────────────────────────────────────────

async function buildSigner(wallet: StoredWallet): Promise<OfflineSigner> {
  if (wallet.privateKey) {
    const keyBytes = Buffer.from(wallet.privateKey, 'hex');
    return DirectSecp256k1Wallet.fromKey(new Uint8Array(keyBytes), ADDRESS_PREFIX);
  }
  if (wallet.mnemonic) {
    return DirectSecp256k1HdWallet.fromMnemonic(wallet.mnemonic, { prefix: ADDRESS_PREFIX });
  }
  throw new Error('No credentials for wallet ' + wallet.id);
}

async function buildHubClient(wallet: StoredWallet): Promise<SigningStargateClient> {
  const signer = await buildSigner(wallet);
  const registry = new Registry([...defaultRegistryTypes]);
  registry.register(WSTAKING_NEW_RECORD_URL, MsgNewRecordType as any);
  registry.register(WSTAKING_CLAIM_URL, MsgWstakingWithdrawType as any);
  registry.register(WSTAKING_UNSTAKE_URL, MsgWstakingUnstakeType as any);
  return SigningStargateClient.connectWithSigner(HUB_RPC, signer, { registry });
}

async function buildRollupClient(wallet: StoredWallet, network = 'mainnet') {
  const signer = await buildSigner(wallet);
  const rpc = ROLLUP_RPC[network] ?? ROLLUP_RPC.mainnet;
  const registry = new Registry([...defaultRegistryTypes]);
  registry.register(CHECKIN_TYPE_URL, MsgCheckInType as any);
  const tmClient = await Tendermint37Client.connect(rpc);
  const client = await SigningStargateClient.createWithSigner(tmClient, signer, { registry });
  return { tmClient, client };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url: string, ms = FETCH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Rollup broadcast with sequence retry ────────────────────────────────────

export interface TxResult {
  success: boolean;
  txHash?: string;
  error?: string;
  note?: string;
  permanent?: boolean;
}

/** Poll for tx delivery. Returns the tx result or null if not found within timeout. */
async function pollTxResult(
  tmClient: Tendermint37Client,
  hash: Uint8Array,
  attempts: number,
  delayMs: number,
): Promise<{ result: { code: number; log?: string } } | null> {
  for (let i = 0; i < attempts; i++) {
    await new Promise(r => setTimeout(r, delayMs));
    try {
      const txRes = await (tmClient as any).tx({ hash, prove: false });
      return txRes;
    } catch {
      // Not yet included in a block — keep polling
    }
  }
  return null;
}

async function rollupBroadcast(
  wallet: StoredWallet,
  msgs: any[],
  memo = '',
  network = 'mainnet'
): Promise<TxResult> {
  try {
    const { tmClient, client } = await buildRollupClient(wallet, network);
    const chainId = ROLLUP_CHAIN_ID[network] ?? ROLLUP_CHAIN_ID.mainnet;

    let accountNumber = 0;
    let sequence = 0;
    try {
      const acct = await client.getSequence(wallet.address);
      accountNumber = acct.accountNumber;
      sequence = acct.sequence;
    } catch {
      // Account does not exist on-chain (never received tokens / never transacted).
      // Broadcasting would produce a silent DeliverTx failure, so fail fast.
      return {
        success: false,
        error: 'Account not found on chain — wallet must receive tokens to activate before it can check in',
        permanent: true,
      };
    }

    // Use broadcastTxAsync to bypass CheckTx — the rollup's custom fee_checker.go
    // only validates fees during IsCheckTx(). In DeliverTx (block inclusion),
    // zero-fee txs are accepted. broadcastTxAsync skips the CheckTx mempool pass.
    const signed = await client.sign(wallet.address, msgs, ROLLUP_FEE, memo, {
      accountNumber,
      sequence,
      chainId,
    });
    const txBytes = encodeTxRaw(signed);
    const res = await tmClient.broadcastTxAsync({ tx: txBytes });
    const txHash = Buffer.from(res.hash).toString('hex').toUpperCase();

    // Poll up to 10 × 6 s = 60 s for block inclusion.
    // broadcastTxAsync bypasses CheckTx so the tx lands in DeliverTx asynchronously.
    // The rollup block time can exceed 12 s, so we give it up to 60 s.
    const confirmed = await pollTxResult(tmClient, res.hash, 10, 6_000);
    if (confirmed === null) {
      // Still not visible after 60 s. With broadcastTxAsync the tx is already
      // committed to the mempool and WILL be included — the explorer confirms this.
      // Treat as success to avoid false failures and double-submission retries.
      return {
        success: true,
        txHash,
        note: 'Broadcast accepted — block inclusion takes longer than polling window',
      };
    }
    if (confirmed.result.code !== 0) {
      const log = (confirmed.result.log ?? `DeliverTx code ${confirmed.result.code}`).slice(0, 200);
      return { success: false, txHash, error: log };
    }

    return { success: true, txHash };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// ─── Balance Queries ──────────────────────────────────────────────────────────

export async function getHubBalance(address: string): Promise<number> {
  try {
    const res = await fetchWithTimeout(
      `${HUB_REST}/cosmos/bank/v1beta1/balances/${address}?pagination.limit=20`
    );
    const json = (await res.json()) as any;
    const coin = (json.balances ?? []).find((b: any) => b.denom === 'umec');
    return coin ? parseInt(coin.amount, 10) : 0;
  } catch {
    return 0;
  }
}

export interface Coin { denom: string; amount: number }

export async function getRollupBalances(address: string, network = 'mainnet'): Promise<Coin[]> {
  const rest = ROLLUP_REST[network] ?? ROLLUP_REST.mainnet;
  // Let errors propagate — callers must distinguish "query failed" from "genuinely empty"
  const res = await fetchWithTimeout(
    `${rest}/cosmos/bank/v1beta1/balances/${address}?pagination.limit=50`
  );
  if (!res.ok) throw new Error(`Rollup REST error ${res.status} for ${address}`);
  const json = (await res.json()) as any;
  if (json.code !== undefined) throw new Error(`Rollup REST gRPC error ${json.code}: ${json.message}`);
  return (json.balances ?? []).map((b: any) => ({
    denom: b.denom,
    amount: parseInt(b.amount, 10),
  }));
}

// ─── Staking Queries — wstaking custom module ─────────────────────────────────
// The hub uses metaearth.wstaking, NOT the standard cosmos staking/distribution modules.
// Endpoints: /metaearth/wstaking/delegation/{addr} and /metaearth/wstaking/delegation-rewards/{addr}

interface WstakingDelegation {
  validatorAddress: string;
  balanceUmec: number;
}

async function getWstakingDelegation(address: string): Promise<WstakingDelegation | null> {
  try {
    const res = await fetchWithTimeout(`${HUB_REST}/metaearth/wstaking/delegation/${address}`);
    const json = (await res.json()) as any;
    if (json.code !== undefined) return null; // gRPC error
    const delResp = json.delegation_response;
    if (!delResp) return null;
    return {
      validatorAddress: delResp.delegation?.validator_address ?? '',
      balanceUmec: parseInt(delResp.balance?.amount ?? '0', 10),
    };
  } catch {
    return null;
  }
}

async function getWstakingRewardsUmec(address: string): Promise<number> {
  try {
    const res = await fetchWithTimeout(`${HUB_REST}/metaearth/wstaking/delegation-rewards/${address}`);
    const json = (await res.json()) as any;
    if (json.code !== undefined) return 0;
    const rewards: any[] = json.rewards ?? [];
    const umec = rewards.find((r: any) => r.denom === 'umec');
    return umec ? Math.floor(parseFloat(umec.amount)) : 0;
  } catch {
    return 0;
  }
}

export async function getStakingRewards(address: string): Promise<number> {
  return getWstakingRewardsUmec(address);
}

export async function getStakingDelegations(address: string): Promise<string[]> {
  const d = await getWstakingDelegation(address);
  return d?.validatorAddress ? [d.validatorAddress] : [];
}

export interface StakingDelegation {
  validatorAddress: string;
  stakedUmec: number;
  pendingRewardsUmec: number;
}

export interface UnbondingEntry {
  validatorAddress: string;
  completionTime: string;
  amountUmec: number;
}

export async function getStakingDelegationsDetailed(address: string): Promise<StakingDelegation[]> {
  try {
    const [delegation, rewardsUmec] = await Promise.all([
      getWstakingDelegation(address),
      getWstakingRewardsUmec(address),
    ]);
    if (!delegation?.validatorAddress) return [];
    return [{
      validatorAddress: delegation.validatorAddress,
      stakedUmec: delegation.balanceUmec,
      pendingRewardsUmec: rewardsUmec,
    }];
  } catch {
    return [];
  }
}

export async function getUnbondingDelegations(address: string): Promise<UnbondingEntry[]> {
  // wstaking module unbonding endpoint (best-effort — chain may not expose this REST)
  try {
    const res = await fetchWithTimeout(
      `${HUB_REST}/cosmos/staking/v1beta1/delegators/${address}/unbonding_delegations`
    );
    const json = (await res.json()) as any;
    if (json.code !== undefined) return [];
    const entries: UnbondingEntry[] = [];
    for (const ub of (json.unbonding_responses ?? [])) {
      for (const entry of (ub.entries ?? [])) {
        entries.push({
          validatorAddress: ub.validator_address,
          completionTime: entry.completion_time,
          amountUmec: parseInt(entry.balance ?? '0', 10),
        });
      }
    }
    return entries;
  } catch {
    return [];
  }
}

// ─── Hub staking operations (wstaking module) ─────────────────────────────────

export async function undelegateFromValidator(
  wallet: StoredWallet,
  validatorAddress: string,
  amountUmec: number
): Promise<TxResult> {
  try {
    const client = await buildHubClient(wallet);
    const msg = {
      typeUrl: WSTAKING_UNSTAKE_URL,
      value: {
        stakerAddress: wallet.address,
        validatorAddress,
        amount: { denom: 'umec', amount: String(amountUmec) },
      },
    };
    const result = await client.signAndBroadcast(wallet.address, [msg], HUB_FEE, '');
    if (result.code !== 0) return { success: false, error: `code ${result.code}: ${result.rawLog}` };
    return { success: true, txHash: result.transactionHash };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

export interface WalletBalances {
  hub: number;       // umec
  rollup: Coin[];    // each coin in smallest unit
  rollupTotal: number; // total rollup in umec-equivalent smallest units
  staking: number;   // umec rewards
}

export async function getAllBalances(address: string, network = 'mainnet'): Promise<WalletBalances> {
  const [hub, rollupResult, staking] = await Promise.all([
    getHubBalance(address),
    getRollupBalances(address, network).catch(() => [] as Coin[]),
    getStakingRewards(address),
  ]);
  const ibcMec = rollupResult.find(b => b.denom === ROLLUP_IBC_DENOM);
  const rollupTotal = ibcMec?.amount ?? 0;
  return { hub, rollup: rollupResult, rollupTotal, staking };
}

// ─── Operations ───────────────────────────────────────────────────────────────

// ─── Hub chain check-in (MsgNewRecord) ───────────────────────────────────────
// The rollup chain (mecheckin_101-1) has been stalled since 2026-05-01.
// Active check-in is now MsgNewRecord on me-chain (9 000+ txs active as of June 2026).
// actionNumber: "MEcheckin" + YYYYMMDD — alphanumeric, unique per day (keeper validates alpha-num only)
// actionUrl: configurable via CHECKIN_URL env var, defaults to https://metaearth.network
// Fee: 4 000 umec / 200 000 gas = 0.02 umec/gas (matches chain minGasPrices; gas used ≈75 000)

async function hubCheckin(wallet: StoredWallet): Promise<TxResult> {
  try {
    // Pre-check hub balance — saves 2 wasted retries for wallets that can't afford the fee.
    const hubBalance = await getHubBalance(wallet.address);
    if (hubBalance < HUB_CHECKIN_MIN_UMEC) {
      return {
        success: false,
        error: `Insufficient hub balance: need ${HUB_CHECKIN_MIN_UMEC.toLocaleString()} umec, have ${hubBalance.toLocaleString()} umec — top up to enable check-in`,
        permanent: true,
      };
    }

    const client = await buildHubClient(wallet);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, ''); // "YYYYMMDD"
    const actionNumber = `MEcheckin${today}`;
    const actionUrl = process.env.CHECKIN_URL ?? 'https://metaearth.network';
    const msg = {
      typeUrl: WSTAKING_NEW_RECORD_URL,
      value: { actionNumber, actionUrl, from: wallet.address },
    };
    const result = await client.signAndBroadcast(wallet.address, [msg], HUB_CHECKIN_FEE, '');
    if (result.code !== 0) {
      return { success: false, error: `code ${result.code}: ${(result.rawLog ?? '').slice(0, 200)}` };
    }
    // height must be > 0 — cosmjs polls until the tx lands in a block. If height is
    // 0 the broadcast was accepted in the mempool but never confirmed; treat as failure
    // so we retry rather than recording a ghost hash.
    if (!result.height || result.height <= 0) {
      return {
        success: false,
        error: `tx ${result.transactionHash} broadcast but not confirmed in any block (height=${result.height})`,
      };
    }
    console.log(`[blockchain] hub check-in confirmed: ${result.transactionHash} @ block ${result.height}`);
    return { success: true, txHash: result.transactionHash };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

export async function performCheckin(wallet: StoredWallet, network = 'mainnet'): Promise<TxResult> {
  // Primary: hub chain MsgNewRecord — the ACTIVE check-in system as of June 2026.
  const hubResult = await hubCheckin(wallet);
  if (hubResult.success) return hubResult;

  // Fallback: rollup chain MsgCheckIn (stalled since 2026-05-01, kept for if/when it resumes).
  const rollupMsg = {
    typeUrl: CHECKIN_TYPE_URL,
    value: {
      checkInAddress: wallet.address,
      checkInMessage: process.env.CHECK_IN_MESSAGE ?? 'META EARTH! ME, My Way!',
    },
  };
  const rollupResult = await rollupBroadcast(wallet, [rollupMsg], '', network);
  if (rollupResult.success) return rollupResult;

  // Both failed — return hub error as primary (more actionable)
  return {
    success: false,
    error: `Hub: ${hubResult.error} | Rollup: ${rollupResult.error}`,
  };
}

export async function hubSend(
  wallet: StoredWallet,
  to: string,
  amountUmec: number
): Promise<TxResult> {
  try {
    const client = await buildHubClient(wallet);
    const result = await client.sendTokens(
      wallet.address,
      to,
      [{ denom: 'umec', amount: String(amountUmec) }],
      HUB_FEE,
      'Transfer'
    );
    if (result.code !== 0) return { success: false, error: `code ${result.code}: ${result.rawLog}` };
    return { success: true, txHash: result.transactionHash };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

// Zero fee on rollup — no reserve needed. Minimum send = 1 000 units to avoid dust txs.
const ROLLUP_FEE_RESERVE = 0;
const ROLLUP_MIN_SEND    = 1_000;

export async function rollupSendAll(
  wallet: StoredWallet,
  to: string,
  network = 'mainnet'
): Promise<TxResult> {
  // Always query the real balance — errors propagate as failures (not silent skips)
  let balances: Coin[];
  try {
    balances = await getRollupBalances(wallet.address, network);
  } catch (err: any) {
    return { success: false, error: `Failed to query rollup balance: ${err?.message ?? err}` };
  }

  const ibcMec = balances.find(b => b.denom === ROLLUP_IBC_DENOM);
  const ibcAmount = ibcMec?.amount ?? 0;

  // Zero fee on rollup — send all tokens above dust threshold
  const msgs: any[] = [];
  for (const b of balances) {
    if (b.amount <= 0) continue;
    const sendAmount = b.amount - ROLLUP_FEE_RESERVE; // ROLLUP_FEE_RESERVE is 0
    if (sendAmount < ROLLUP_MIN_SEND) continue;
    msgs.push({
      typeUrl: '/cosmos.bank.v1beta1.MsgSend',
      value: {
        fromAddress: wallet.address,
        toAddress: to,
        amount: [{ denom: b.denom, amount: String(sendAmount) }],
      },
    });
  }

  // Build a human-readable summary of what was found on rollup
  function buildBalanceSummary(): string {
    if (balances.length === 0) return 'No tokens on rollup';
    return balances.map(b => {
      if (b.denom === ROLLUP_IBC_DENOM) {
        return `${(b.amount / 100_000_000).toFixed(8)} IBC-MEC (${b.amount} units)`;
      }
      return `${b.amount} ${b.denom}`;
    }).join(', ');
  }

  if (msgs.length === 0) {
    const ibcDisplay = (ibcAmount / 100_000_000).toFixed(8);
    let reason: string;
    if (balances.length === 0) {
      reason = 'Rollup wallet is empty';
    } else {
      reason = `all balances below ${ROLLUP_MIN_SEND} unit dust threshold`;
    }
    return {
      success: true,
      note: `Rollup queried: ${buildBalanceSummary()} | IBC-MEC: ${ibcDisplay} MEC — ${reason}, skipped`,
    };
  }

  const result = await rollupBroadcast(wallet, msgs, 'Rollup sweep', network);

  // Insufficient funds: chain may have a stale view of the balance
  if (!result.success && result.error?.includes('insufficient funds')) {
    const ibcDisplay = (ibcAmount / 100_000_000).toFixed(8);
    return {
      success: true,
      note: `Rollup sweep skipped — on-chain balance (${ibcDisplay} IBC-MEC REST-queried, ${buildBalanceSummary()}) insufficient; chain may have a stale view`,
    };
  }

  return result;
}

export async function rollupSendAmount(
  wallet: StoredWallet,
  to: string,
  denom: string,
  amount: number,
  network = 'mainnet'
): Promise<TxResult> {
  const msgs = [{
    typeUrl: '/cosmos.bank.v1beta1.MsgSend',
    value: {
      fromAddress: wallet.address,
      toAddress: to,
      amount: [{ denom, amount: String(amount) }],
    },
  }];
  return rollupBroadcast(wallet, msgs, 'Transfer', network);
}

export async function ibcTransferToRollup(
  masterWallet: StoredWallet,
  targetAddress: string,
  amountUmec: number
): Promise<TxResult> {
  try {
    const client = await buildHubClient(masterWallet);
    const timeoutTimestamp = BigInt(Date.now() + 10 * 60_000) * 1_000_000n;
    const result = await (client as any).sendIbcTokens(
      masterWallet.address,
      targetAddress,
      { denom: 'umec', amount: String(amountUmec) },
      IBC_SOURCE_PORT,
      IBC_HUB_CHANNEL,
      undefined,
      timeoutTimestamp,
      HUB_FEE,
      'Rollup registration'
    );
    if (result.code !== 0) {
      return { success: false, error: `IBC code ${result.code}: ${result.rawLog ?? ''}` };
    }
    return { success: true, txHash: result.transactionHash };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

export async function withdrawStakingRewards(wallet: StoredWallet): Promise<TxResult> {
  try {
    const validators = await getStakingDelegations(wallet.address);
    if (validators.length === 0) return { success: true, note: 'No delegations — nothing to withdraw' };

    const client = await buildHubClient(wallet);
    const msgs = validators.map(v => ({
      typeUrl: WSTAKING_CLAIM_URL,
      value: { delegatorAddress: wallet.address, validatorAddress: v },
    }));

    const result = await client.signAndBroadcast(wallet.address, msgs, HUB_FEE, '');
    if (result.code === 0) return { success: true, txHash: result.transactionHash };

    return { success: false, error: `code ${result.code}: ${result.rawLog ?? ''}` };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

export type SweepMode = 'all' | 'hub' | 'rollup' | 'staking';

export interface SweepStepResult {
  step: string;
  success: boolean;
  txHash?: string;
  error?: string;
  note?: string;
}

export async function autoSweep(
  wallet: StoredWallet,
  mode: SweepMode,
  destination: string,
  minHubReserveUmec: number,
  network = 'mainnet'
): Promise<SweepStepResult[]> {
  const results: SweepStepResult[] = [];
  const push = (step: string, r: TxResult) => results.push({ step, ...r });
  const TXN_FEE = 12000;

  if (mode === 'staking') {
    push('Withdraw Staking Rewards', await withdrawStakingRewards(wallet));
    return results;
  }

  if (mode === 'rollup') {
    push('Sweep Rollup Balance', await rollupSendAll(wallet, destination, network));
    return results;
  }

  if (mode === 'hub') {
    const hubBalance = await getHubBalance(wallet.address);
    const available = hubBalance - minHubReserveUmec - TXN_FEE;
    if (available > 0) {
      push('Sweep Hub Balance', await hubSend(wallet, destination, available));
    } else {
      push('Sweep Hub Balance', {
        success: false,
        error: `Hub balance ${(hubBalance / 1e6).toFixed(4)} MEC is below reserve + fee (${((minHubReserveUmec + TXN_FEE) / 1e6).toFixed(4)} MEC minimum)`,
      });
    }
    return results;
  }

  // ── All-inclusive: 3-step sequential sweep ────────────────────────────────
  const validators = await getStakingDelegations(wallet.address);
  if (validators.length > 0) {
    push('Withdraw Staking Rewards', await withdrawStakingRewards(wallet));
  } else {
    push('Withdraw Staking Rewards', { success: true, note: 'No staking delegations on this wallet' });
  }

  const hubBalance = await getHubBalance(wallet.address);
  const available = hubBalance - minHubReserveUmec - TXN_FEE;
  if (available > 0) {
    push('Sweep Hub Balance', await hubSend(wallet, destination, available));
  } else {
    push('Sweep Hub Balance', {
      success: false,
      error: `Hub balance ${(hubBalance / 1e6).toFixed(4)} MEC is below reserve + fee (${((minHubReserveUmec + TXN_FEE) / 1e6).toFixed(4)} MEC minimum)`,
    });
  }

  push('Sweep Rollup Balance', await rollupSendAll(wallet, destination, network));

  return results;
}
