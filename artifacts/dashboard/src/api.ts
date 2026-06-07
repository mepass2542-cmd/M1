import type {
  Wallet, BalanceEntry, CheckInResult, SweepWalletResult, SweepMode, TxResult,
  SchedulerState, WalletCheckinStats, CheckinLogEntry,
  TopupConfig, TopupRunSummary, TopupLogEntry,
  WalletStakingInfo,
} from './types';

async function request<T>(url: string, init?: RequestInit & { headers?: Record<string, string> }): Promise<T> {
  const { headers: extraHeaders, ...rest } = init ?? {};
  const res = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders,
    },
    ...rest,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((err as any).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}

export const api = {
  // Wallets
  getWallets: () => request<Wallet[]>('/api/wallets'),

  importWallets: (rawText: string) => {
    const text = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
    const data = btoa(unescape(encodeURIComponent(text)));
    return request<{ imported: number; skipped: number; errors: string[] }>('/api/wallets/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ data }).toString(),
    });
  },

  deleteWallet: (id: string) =>
    request<{ removed: boolean }>(`/api/wallets/${id}`, { method: 'DELETE' }),

  renameWallet: (id: string, label: string) =>
    request<{ ok: boolean }>(`/api/wallets/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ label }),
    }),

  // Balances
  getBalance: (id: string) =>
    request<BalanceEntry['balances']>(`/api/wallets/${id}/balance`),

  getBalances: (ids?: string[]) =>
    request<BalanceEntry[]>('/api/balances', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  // Manual check-in (selected wallets)
  checkin: (ids: string[]) =>
    request<CheckInResult[]>('/api/checkin', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  // Scheduler
  getSchedule: () => request<SchedulerState>('/api/checkin/schedule'),
  triggerSchedule: () => request<{ started: boolean }>('/api/checkin/run', { method: 'POST' }),
  getCheckinStats: () => request<WalletCheckinStats[]>('/api/checkin/stats'),
  getCheckinHistory: (limit = 100) =>
    request<CheckinLogEntry[]>(`/api/checkin/history?limit=${limit}`),

  // Transfer
  transfer: (params: {
    fromId: string;
    to: string;
    chain: 'hub' | 'rollup';
    amountUmec: number;
    denom?: string;
  }) =>
    request<TxResult>('/api/transfer', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  // Sweep
  sweep: (params: {
    ids: string[];
    mode: SweepMode;
    destination: string;
    minHubReserve: number;
  }) =>
    request<SweepWalletResult[]>('/api/sweep', {
      method: 'POST',
      body: JSON.stringify(params),
    }),

  // Staking
  getStaking: (walletId: string) =>
    request<WalletStakingInfo>(`/api/staking/${walletId}`),

  claimRewards: (walletId: string) =>
    request<TxResult>('/api/staking/claim', {
      method: 'POST',
      body: JSON.stringify({ walletId }),
    }),

  undelegate: (walletId: string, validatorAddress: string, amountUmec: number) =>
    request<TxResult>('/api/staking/undelegate', {
      method: 'POST',
      body: JSON.stringify({ walletId, validatorAddress, amountUmec }),
    }),

  // Export
  exportUrl: (format: 'csv' | 'json', category: 'all' | 'verified' | 'unverified') =>
    `/api/export?format=${format}&category=${category}`,

  // Top-Up
  getTopupConfig: () => request<TopupConfig>('/api/topup/config'),
  setTopupConfig: (cfg: Partial<TopupConfig>) =>
    request<TopupConfig>('/api/topup/config', {
      method: 'POST',
      body: JSON.stringify(cfg),
    }),
  runTopup: () => request<TopupRunSummary>('/api/topup/run', { method: 'POST' }),
  getTopupHistory: (limit = 100) =>
    request<TopupLogEntry[]>(`/api/topup/history?limit=${limit}`),
};
