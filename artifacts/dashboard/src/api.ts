import type { Wallet, BalanceEntry, CheckInResult, SweepWalletResult, SweepMode, TxResult } from './types';

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
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
    // Normalise line endings before JSON serialisation to avoid control-char parse errors
    const text = rawText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    return request<{ imported: number; skipped: number; errors: string[] }>('/api/wallets/import', {
      method: 'POST',
      body: JSON.stringify({ text }),
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

  // Check-in
  checkin: (ids: string[]) =>
    request<CheckInResult[]>('/api/checkin', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

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

  // Export (returns URL for download)
  exportUrl: (format: 'csv' | 'json', category: 'all' | 'verified' | 'unverified') =>
    `/api/export?format=${format}&category=${category}`,
};
