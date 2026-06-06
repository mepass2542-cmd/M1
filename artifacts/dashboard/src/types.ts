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
