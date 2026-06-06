import {
  DirectSecp256k1HdWallet,
  DirectSecp256k1Wallet,
  Registry,
  OfflineSigner,
} from '@cosmjs/proto-signing';
import { SigningStargateClient } from '@cosmjs/stargate';
import { Tendermint37Client } from '@cosmjs/tendermint-rpc';
import { Type, Field, Root, Writer } from 'protobufjs';
import { StoredWallet } from './store';

const HUB_RPC = 'http://118.175.0.247:16657';
const HUB_REST = 'http://118.175.0.247:11317';
const HUB_CHAIN_ID = 'me-chain';
const HUB_FEE = { amount: [{ denom: 'umec', amount: '12000' }], gas: '200000' };

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
const ROLLUP_FEE = { amount: [] as { denom: string; amount: string }[], gas: '200000' };
const ADDRESS_PREFIX = 'me';
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
  const registry = new Registry();
  registry.register(CHECKIN_TYPE_URL, MsgCheckInType as any);
  const tmClient = await Tendermint37Client.connect(rpc);
  const client = await SigningStargateClient.createWithSigner(tmClient, signer, { registry });
  return { tmClient, client };
}

export interface TxResult {
  success: boolean;
  txHash?: string;
  error?: string;
  note?: string;
}

async function rollupBroadcast(
  wallet: StoredWallet,
  msgs: any[],
  memo = '',
  network = 'mainnet'
): Promise<TxResult> {
  const { tmClient, client } = await buildRollupClient(wallet, network);
  const chainId = ROLLUP_CHAIN_ID[network] ?? ROLLUP_CHAIN_ID.mainnet;

  let accountNumber = 0;
  let sequence = 0;
  try {
    const acct = await client.getSequence(wallet.address);
    accountNumber = acct.accountNumber;
    sequence = acct.sequence;
  } catch { /* new account, default to 0 */ }

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
    if (res.code === 32) {
      const match = log.match(/expected (\d+)/);
      if (match) {
        sequence = parseInt(match[1], 10);
        continue;
      }
    }
    return { success: false, error: `code ${res.code}: ${log}` };
  }
  return { success: false, error: 'Sequence retry limit exceeded' };
}

// ─── Balance Queries ──────────────────────────────────────────────────────────

export async function getHubBalance(address: string): Promise<number> {
  try {
    const res = await fetch(`${HUB_REST}/cosmos/bank/v1beta1/balances/${address}?pagination.limit=20`);
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
    const res = await fetch(`${rest}/cosmos/bank/v1beta1/balances/${address}?pagination.limit=50`);
    const json = (await res.json()) as any;
    return (json.balances ?? []).map((b: any) => ({ denom: b.denom, amount: parseInt(b.amount, 10) }));
  } catch {
    return [];
  }
}

export async function getStakingRewards(address: string): Promise<number> {
  try {
    const res = await fetch(`${HUB_REST}/cosmos/distribution/v1beta1/delegators/${address}/rewards`);
    const json = (await res.json()) as any;
    const total = (json.total ?? []).find((c: any) => c.denom === 'umec');
    return total ? Math.floor(parseFloat(total.amount)) : 0;
  } catch {
    return 0;
  }
}

export async function getStakingDelegations(address: string): Promise<string[]> {
  try {
    const res = await fetch(`${HUB_REST}/cosmos/staking/v1beta1/delegations/${address}`);
    const json = (await res.json()) as any;
    return (json.delegation_responses ?? [])
      .map((d: any) => d.delegation?.validator_address)
      .filter(Boolean);
  } catch {
    return [];
  }
}

export interface WalletBalances {
  hub: number;
  rollup: Coin[];
  rollupTotal: number;
  staking: number;
}

export async function getAllBalances(address: string, network = 'mainnet'): Promise<WalletBalances> {
  const [hub, rollup, staking] = await Promise.all([
    getHubBalance(address),
    getRollupBalances(address, network),
    getStakingRewards(address),
  ]);
  const rollupTotal = rollup.reduce((s, b) => s + b.amount, 0);
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
  if (nonZero.length === 0) return { success: false, note: 'No rollup balance to sweep' };

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

export async function withdrawStakingRewards(wallet: StoredWallet): Promise<TxResult> {
  try {
    const validators = await getStakingDelegations(wallet.address);
    if (validators.length === 0) return { success: true, note: 'No delegations — nothing to withdraw' };

    const client = await buildHubClient(wallet);
    const msgs = validators.map(v => ({
      typeUrl: '/cosmos.distribution.v1beta1.MsgWithdrawDelegatorReward',
      value: { delegatorAddress: wallet.address, validatorAddress: v },
    }));
    const result = await client.signAndBroadcast(wallet.address, msgs, HUB_FEE, '');
    if (result.code !== 0) return { success: false, error: `code ${result.code}: ${result.rawLog}` };
    return { success: true, txHash: result.transactionHash };
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

  if (mode === 'all' || mode === 'staking') {
    const r = await withdrawStakingRewards(wallet);
    push('Withdraw Staking Rewards', r);
  }

  if (mode === 'all' || mode === 'rollup') {
    const r = await rollupSendAll(wallet, destination, network);
    push('Sweep Rollup Balance', r);
  }

  if (mode === 'all' || mode === 'hub') {
    const hubBalance = await getHubBalance(wallet.address);
    const txFee = 12000;
    const available = hubBalance - minHubReserveUmec - txFee;
    if (available > 0) {
      const r = await hubSend(wallet, destination, available);
      push('Sweep Hub Balance', r);
    } else {
      push('Sweep Hub Balance', {
        success: false,
        error: `Hub balance ${hubBalance.toLocaleString()} umec is below reserve (${minHubReserveUmec.toLocaleString()} + ${txFee.toLocaleString()} fee)`,
      });
    }
  }

  return results;
}
