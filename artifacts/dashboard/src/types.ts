export interface Wallet {
  id: string;
  label: string;
  address: string;
  type: 'mnemonic' | 'privatekey';
  verified: boolean;
  createdAt: string;
  hasCredentials: boolean;
}

export interface Coin {
  denom: string;
  amount: number;
}

export interface WalletBalances {
  hub: number;
  rollup: Coin[];
  rollupTotal: number;
  staking: number;
}

export interface BalanceEntry {
  id: string;
  address: string;
  balances: WalletBalances;
}

export interface TxResult {
  success: boolean;
  txHash?: string;
  error?: string;
  note?: string;
}

export interface CheckInResult extends TxResult {
  id: string;
  address: string;
  label: string;
}

export interface SweepStepResult {
  step: string;
  success: boolean;
  txHash?: string;
  error?: string;
  note?: string;
}

export interface SweepWalletResult {
  id: string;
  address: string;
  label: string;
  steps: SweepStepResult[];
}

export type SweepMode = 'all' | 'hub' | 'rollup' | 'staking';
export type ExportFormat = 'csv' | 'json';
export type ExportCategory = 'all' | 'verified' | 'unverified';

// ── Scheduler types ──────────────────────────────────────────────────────────

export interface SchedulerRunResult {
  walletId: string;
  label: string;
  success: boolean;
  txHash?: string;
  error?: string;
}

export interface SchedulerState {
  cronExpr: string;
  lastRunAt: string | null;
  isRunning: boolean;
  lastResults: SchedulerRunResult[];
}

export interface WalletCheckinStats {
  wallet_id: string;
  label: string;
  address: string;
  streak: number;
  last_success_at: string | null;
  checked_in_today: boolean;
}

export interface CheckinLogEntry {
  id: number;
  wallet_id: string;
  label: string;
  address: string;
  executed_at: string;
  success: boolean;
  tx_hash: string | null;
  error: string | null;
}

// ── Staking types ────────────────────────────────────────────────────────────

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

export interface WalletStakingInfo {
  id: string;
  label: string;
  address: string;
  delegations: StakingDelegation[];
  unbonding: UnbondingEntry[];
  totalStakedUmec: number;
  totalRewardsUmec: number;
}

// ── Top-Up types ─────────────────────────────────────────────────────────────

export interface TopupConfig {
  enabled: boolean;
  masterWalletId: string | null;
  thresholdUmec: number;
  topupAmountUmec: number;
  runBeforeCheckin: boolean;
  /** IBC bridge: fund wallets on the rollup chain so they can pay check-in fees */
  ibcEnabled: boolean;
  ibcThresholdUmec: number;
  ibcAmountUmec: number;
}

export interface TopupResult {
  walletId: string;
  label: string;
  address: string;
  // Hub top-up fields
  balanceBefore: number;
  success: boolean;
  txHash?: string;
  error?: string;
  skipped?: boolean;
  // IBC registration fields
  ibcBalanceBefore?: number;
  ibcSuccess?: boolean;
  ibcTxHash?: string;
  ibcError?: string;
  ibcSkipped?: boolean;
}

export interface TopupRunSummary {
  results: TopupResult[];
  toppedUp: number;
  skipped: number;
  failed: number;
  ibcSent: number;
  ibcSkipped: number;
  ibcFailed: number;
  masterBalanceBefore: number;
  masterBalanceAfter: number;
  masterLabel: string;
}

export interface TopupLogEntry {
  id: number;
  wallet_id: string;
  wallet_label: string;
  executed_at: string;
  success: boolean;
  tx_hash: string | null;
  error: string | null;
  amount_umec: number;
  balance_before: number;
  tx_type: 'hub' | 'ibc';
}
