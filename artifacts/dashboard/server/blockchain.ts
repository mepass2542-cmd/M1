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
  testnet: 'http://118.175.0.249:46660',
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
// Rollup requires IBC MEC fee (10 000 units minimum, wallets funded via IBC bridge)
const ROLLUP_FEE = {
  amount: [{ denom: ROLLUP_IBC_DENOM, amount: '10000' }],
  gas: '200000',
};
const ADDRESS_PREFIX = 'me';
const CHECKIN_TYPE_URL = '/stchain.rollapp.checkin.MsgCheckIn';
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
    } catch { /* new account, default 0 */ }

    for (let attempt = 0; attempt < 3; attempt++) {
      const signed = await client.sign(wallet.address, msgs, ROLLUP_FEE, memo, {
        accountNumber,
        sequence,
        chainId,
      });
      const txBytes = encodeTxRaw(signed);
      const res = await tmClient.broadcastTxSync({ tx: txBytes });
      const txHash = Buffer.from(res.hash).toString('hex').toUpperCase();

      if (res.code === 0) return { success: true, txHash };

      const log = res.log ?? '';

      // Sequence mismatch — parse expected sequence and retry immediately
      if (res.code === 32) {
        const match = log.match(/expected (\d+)/);
        if (match) { sequence = parseInt(match[1], 10); continue; }
      }

      // code 9: account not registered on rollup
      if (res.code === 9) {
        return {
          success: false, permanent: true,
          error: `Wallet not registered on rollup chain (${wallet.address.slice(0, 16)}…) — fund via IBC first`,
        };
      }
      // code 13: insufficient fee — wallet needs more IBC MEC on rollup
      if (res.code === 13) {
        return {
          success: false, permanent: true,
          error: `Insufficient rollup fee — wallet needs IBC MEC on rollup (bridge MEC from hub). log: ${log}`,
        };
      }

      return { success: false, error: `code ${res.code}: ${log}` };
    }
    return { success: false, error: 'Sequence retry limit exceeded' };
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

export async function performCheckin(wallet: StoredWallet, network = 'mainnet'): Promise<TxResult> {
  const msg = {
    typeUrl: CHECKIN_TYPE_URL,
    value: {
      checkInAddress: wallet.address,
      checkInMessage: process.env.CHECK_IN_MESSAGE ?? 'META EARTH! ME, My Way!',
    },
  };
  return rollupBroadcast(wallet, [msg], '', network);
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

// Fee reservation = 10 000 units (kept to cover the sweep tx fee)
// Minimum *sendable* amount after fee reservation = 1 000 units (0.001 MEC) — avoids dust txs
// Total balance must therefore exceed 11 000 units (0.011 MEC) to trigger a sweep
const ROLLUP_FEE_RESERVE = 10_000;
const ROLLUP_MIN_SEND    =  1_000;

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

  // Find IBC MEC balance for display
  const ibcMec = balances.find(b => b.denom === ROLLUP_IBC_DENOM);
  const ibcAmount = ibcMec?.amount ?? 0;

  const msgs: any[] = [];
  for (const b of balances) {
    if (b.amount <= 0) continue;
    // IBC MEC: keep fee reserve, send the rest. Other denoms: send everything.
    const sendAmount = b.denom === ROLLUP_IBC_DENOM
      ? b.amount - ROLLUP_FEE_RESERVE
      : b.amount;
    // Only include coins with at least 0.01 MEC (10 000 units) to send
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

  // Confirmed low balance — show both queried total and sendable amount for clarity
  if (msgs.length === 0) {
    const totalDisplay   = (ibcAmount / 1_000_000).toFixed(4);
    const sendable       = Math.max(0, ibcAmount - ROLLUP_FEE_RESERVE);
    const sendableDisplay = (sendable / 1_000_000).toFixed(4);
    return {
      success: true,
      note: `Rollup balance ${totalDisplay} MEC queried; sendable after fee reserve: ${sendableDisplay} MEC (${sendable} units) — below 0.001 MEC dust threshold, skipped`,
    };
  }

  const result = await rollupBroadcast(wallet, msgs, 'Rollup sweep', network);

  // code 5 = chain confirms insufficient funds (balance may be slightly stale) — skip gracefully
  if (!result.success && result.error?.includes('insufficient funds')) {
    const totalDisplay = (ibcAmount / 1_000_000).toFixed(4);
    return {
      success: true,
      note: `Rollup sweep skipped — on-chain balance (${totalDisplay} MEC REST-queried) insufficient; chain may have a stale view`,
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
