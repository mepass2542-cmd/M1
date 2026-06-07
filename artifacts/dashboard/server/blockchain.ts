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

const HUB_FEE = { amount: [{ denom: 'umec', amount: '12000' }], gas: '200000' };
const ROLLUP_FEE = { amount: [] as { denom: string; amount: string }[], gas: '200000' };
const ADDRESS_PREFIX = 'me';
const CHECKIN_TYPE_URL = '/stchain.rollapp.checkin.MsgCheckIn';
const FETCH_TIMEOUT_MS = 12_000;

// IBC: hub channel-1 → rollup channel-0
const IBC_HUB_CHANNEL    = 'channel-1';
const IBC_SOURCE_PORT    = 'transfer';
// IBC denom of hub MEC on the rollup chain
export const ROLLUP_IBC_DENOM =
  'ibc/BC7F4D581D88785A22824C8FB6807DFC3B65C1764AFF1230D954AAB06B70CBC5';

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

function buildMsgCheckInType(): Type {
  const root = new Root();
  const T = new Type('MsgCheckIn')
    .add(new Field('checkInAddress', 1, 'string'))
    .add(new Field('checkInMessage', 2, 'string'));
  root.add(T);
  return T;
}
const MsgCheckInType = buildMsgCheckInType();

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
  return SigningStargateClient.connectWithSigner(HUB_RPC, signer);
}

async function buildRollupClient(wallet: StoredWallet, network = 'mainnet') {
  const signer = await buildSigner(wallet);
  const rpc = ROLLUP_RPC[network] ?? ROLLUP_RPC.mainnet;
  // Include ALL default Cosmos types (MsgSend, etc.) PLUS the custom MsgCheckIn
  const registry = new Registry([...defaultRegistryTypes]);
  registry.register(CHECKIN_TYPE_URL, MsgCheckInType as any);
  const tmClient = await Tendermint37Client.connect(rpc);
  const client = await SigningStargateClient.createWithSigner(tmClient, signer, { registry });
  return { tmClient, client };
}

// ─── Rollup broadcast with sequence retry ────────────────────────────────────

export interface TxResult {
  success: boolean;
  txHash?: string;
  error?: string;
  note?: string;
  /** True when the error is permanent and retrying will not help */
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

      // Permanent errors — do not retry, return immediately
      // code 9: account does not exist on chain (never funded/registered)
      // code 13: insufficient fees (wallet has no balance to pay fee on rollup)
      if (res.code === 9) {
        return {
          success: false, permanent: true,
          error: `Wallet not registered on rollup chain (${wallet.address.slice(0, 16)}…) — needs funding first`,
        };
      }
      if (res.code === 13) {
        return {
          success: false, permanent: true,
          error: `Rollup requires minimum fee but wallet has no rollup balance — fund this wallet first`,
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
  try {
    const rest = ROLLUP_REST[network] ?? ROLLUP_REST.mainnet;
    const res = await fetchWithTimeout(
      `${rest}/cosmos/bank/v1beta1/balances/${address}?pagination.limit=50`
    );
    const json = (await res.json()) as any;
    return (json.balances ?? []).map((b: any) => ({
      denom: b.denom,
      amount: parseInt(b.amount, 10),
    }));
  } catch {
    return [];
  }
}

export async function getStakingRewards(address: string): Promise<number> {
  try {
    const res = await fetchWithTimeout(
      `${HUB_REST}/cosmos/distribution/v1beta1/delegators/${address}/rewards`
    );
    const json = (await res.json()) as any;

    // Happy path — aggregated total is present
    if (!json.code && Array.isArray(json.total)) {
      const total = json.total.find((c: any) => c.denom === 'umec');
      if (total) return Math.floor(parseFloat(total.amount));
      // total array present but no umec entry — sum per-validator rewards in same payload
      let sum = 0;
      for (const v of (json.rewards ?? [])) {
        const coin = (v.reward ?? []).find((c: any) => c.denom === 'umec');
        if (coin) sum += parseFloat(coin.amount);
      }
      return Math.floor(sum);
    }

    // Aggregated endpoint returned a gRPC error (e.g. code 5 — one validator has no
    // distribution info yet). Fall back to querying each validator individually.
    return await getStakingRewardsPerValidator(address);
  } catch {
    return 0;
  }
}

async function getStakingRewardsPerValidator(address: string): Promise<number> {
  try {
    const delegRes = await fetchWithTimeout(
      `${HUB_REST}/cosmos/staking/v1beta1/delegations/${address}`
    );
    const delegJson = (await delegRes.json()) as any;
    const validators: string[] = (delegJson.delegation_responses ?? [])
      .map((d: any) => d.delegation?.validator_address)
      .filter(Boolean);

    let sum = 0;
    for (const v of validators) {
      try {
        const r = await fetchWithTimeout(
          `${HUB_REST}/cosmos/distribution/v1beta1/delegators/${address}/rewards/${v}`,
          6_000
        );
        const rj = (await r.json()) as any;
        if (rj.code !== undefined) continue; // this validator has no distribution info yet
        const coin = (rj.rewards ?? []).find((c: any) => c.denom === 'umec');
        if (coin) sum += parseFloat(coin.amount);
      } catch { /* skip this validator */ }
    }
    return Math.floor(sum);
  } catch {
    return 0;
  }
}

export async function getStakingDelegations(address: string): Promise<string[]> {
  try {
    const res = await fetchWithTimeout(
      `${HUB_REST}/cosmos/staking/v1beta1/delegations/${address}`
    );
    const json = (await res.json()) as any;
    return (json.delegation_responses ?? [])
      .map((d: any) => d.delegation?.validator_address)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export interface WalletBalances {
  hub: number;       // umec
  rollup: Coin[];    // each coin in smallest unit
  rollupTotal: number; // total rollup in umec-equivalent smallest units
  staking: number;   // umec rewards
}

export async function getAllBalances(address: string, network = 'mainnet'): Promise<WalletBalances> {
  const [hub, rollup, staking] = await Promise.all([
    getHubBalance(address),
    getRollupBalances(address, network),
    getStakingRewards(address),
  ]);
  // Only count the IBC MEC denom — other rollup-native tokens use different
  // denominations and must NOT be summed into the MEC balance display.
  const ibcMec = rollup.find(b => b.denom === ROLLUP_IBC_DENOM);
  const rollupTotal = ibcMec?.amount ?? 0;
  return { hub, rollup, rollupTotal, staking };
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

export async function rollupSendAll(
  wallet: StoredWallet,
  to: string,
  network = 'mainnet'
): Promise<TxResult> {
  const balances = await getRollupBalances(wallet.address, network);
  const nonZero = balances.filter(b => b.amount > 0);
  if (nonZero.length === 0) return { success: true, note: 'No rollup balance — nothing to sweep' };

  const msgs = nonZero.map(b => ({
    typeUrl: '/cosmos.bank.v1beta1.MsgSend',
    value: {
      fromAddress: wallet.address,
      toAddress: to,
      amount: [{ denom: b.denom, amount: String(b.amount) }],
    },
  }));
  return rollupBroadcast(wallet, msgs, 'Rollup sweep', network);
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
    // Timeout: 10 minutes from now in nanoseconds
    const timeoutTimestamp = BigInt(Date.now() + 10 * 60_000) * 1_000_000n;
    // sendIbcTokens: senderAddress, recipientAddress, transferAmount, sourcePort,
    //                sourceChannel, timeoutHeight, timeoutTimestamp, fee, memo
    const result = await (client as any).sendIbcTokens(
      masterWallet.address,
      targetAddress,
      { denom: 'umec', amount: String(amountUmec) },
      IBC_SOURCE_PORT,
      IBC_HUB_CHANNEL,
      undefined,           // no height timeout — use timestamp only
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
      typeUrl: '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward',
      value: { delegatorAddress: wallet.address, validatorAddress: v },
    }));

    // Try all validators in one batch first (efficient)
    const result = await client.signAndBroadcast(wallet.address, msgs, HUB_FEE, '');
    if (result.code === 0) return { success: true, txHash: result.transactionHash };

    const log = result.rawLog ?? '';

    // "no delegation distribution info" — one or more validators haven't distributed yet.
    // Fall back to individual per-validator withdrawals, skipping the ones with no rewards.
    if (log.includes('no delegation distribution info')) {
      return await withdrawStakingRewardsIndividually(wallet, validators, client);
    }

    return { success: false, error: `code ${result.code}: ${log}` };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
}

async function withdrawStakingRewardsIndividually(
  wallet: StoredWallet,
  validators: string[],
  client: SigningStargateClient
): Promise<TxResult> {
  const hashes: string[] = [];
  let noInfoCount = 0;

  for (const v of validators) {
    try {
      const msg = {
        typeUrl: '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward',
        value: { delegatorAddress: wallet.address, validatorAddress: v },
      };
      const r = await client.signAndBroadcast(wallet.address, [msg], HUB_FEE, '');
      if (r.code === 0) {
        hashes.push(r.transactionHash);
      } else if ((r.rawLog ?? '').includes('no delegation distribution info')) {
        noInfoCount++;
      }
      // brief pause so next tx picks up incremented sequence from the chain
      await new Promise(res => setTimeout(res, 800));
    } catch { /* skip this validator */ }
  }

  if (hashes.length > 0) {
    const note = noInfoCount > 0
      ? `${noInfoCount} validator(s) had no rewards yet — skipped`
      : undefined;
    return { success: true, txHash: hashes[0], note };
  }
  if (noInfoCount === validators.length) {
    return { success: true, note: 'No rewards to withdraw yet — validators have not distributed any rewards' };
  }
  return { success: false, error: 'All per-validator reward withdrawals failed' };
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

  // ── Staking-only ──────────────────────────────────────────────────────────
  if (mode === 'staking') {
    push('Withdraw Staking Rewards', await withdrawStakingRewards(wallet));
    return results;
  }

  // ── Rollup-only ───────────────────────────────────────────────────────────
  if (mode === 'rollup') {
    push('Sweep Rollup Balance', await rollupSendAll(wallet, destination, network));
    return results;
  }

  // ── Hub-only ──────────────────────────────────────────────────────────────
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
  //
  // Step 1: Withdraw staking rewards
  //   Always attempts withdrawal if delegations exist — does NOT gate on the
  //   reported reward amount because the hub's rewards query API is unreliable
  //   (returns code 13 runtime error). The on-chain execution works regardless.
  //
  const validators = await getStakingDelegations(wallet.address);
  if (validators.length > 0) {
    push('Withdraw Staking Rewards', await withdrawStakingRewards(wallet));
    // Staking rewards have now landed in hub wallet (signAndBroadcast waits for block)
  } else {
    push('Withdraw Staking Rewards', { success: true, note: 'No staking delegations on this wallet' });
  }

  // Step 2: Sweep hub — re-query AFTER reward withdrawal so balance includes landed rewards
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

  // Step 3: Sweep rollup (separate chain — runs independently of hub steps)
  push('Sweep Rollup Balance', await rollupSendAll(wallet, destination, network));

  return results;
}
