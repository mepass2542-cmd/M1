import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import type { WalletStakingInfo, TxResult } from '../types';

const UMEC_PER_MEC = 1_000_000;

function fmtMec(umec: number): string {
  if (umec === 0) return '0 MEC';
  const mec = umec / UMEC_PER_MEC;
  return mec >= 1 ? mec.toFixed(4) + ' MEC' : mec.toFixed(6) + ' MEC';
}

function shortVal(addr: string) {
  return addr.slice(0, 14) + '…' + addr.slice(-6);
}

function shortAddr(addr: string) {
  return addr.slice(0, 10) + '…' + addr.slice(-6);
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

interface TxStatus {
  loading: boolean;
  result: TxResult | null;
}

interface UndelegateModal {
  walletId: string;
  validatorAddress: string;
  maxUmec: number;
  amountMec: string;
}

export function StakingTab() {
  const { wallets } = useApp();
  const [stakingInfo, setStakingInfo] = useState<Record<string, WalletStakingInfo>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimStatus, setClaimStatus] = useState<Record<string, TxStatus>>({});
  const [undelegateModal, setUndelegateModal] = useState<UndelegateModal | null>(null);
  const [undelegating, setUndelegating] = useState(false);
  const [undelegateResult, setUndelegateResult] = useState<TxResult | null>(null);

  const loadAll = useCallback(async () => {
    if (wallets.length === 0) return;
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.all(wallets.map(w => api.getStaking(w.id)));
      const map: Record<string, WalletStakingInfo> = {};
      results.forEach(info => { map[info.id] = info; });
      setStakingInfo(map);
    } catch (e: any) {
      setError('Failed to load staking info: ' + e.message);
    } finally {
      setLoading(false);
    }
  }, [wallets]);

  useEffect(() => { loadAll(); }, [loadAll]);

  const claimRewards = async (walletId: string) => {
    if (!confirm('Claim all pending staking rewards for this wallet?')) return;
    setClaimStatus(prev => ({ ...prev, [walletId]: { loading: true, result: null } }));
    try {
      const result = await api.claimRewards(walletId);
      setClaimStatus(prev => ({ ...prev, [walletId]: { loading: false, result } }));
      if (result.success) {
        setTimeout(() => loadAll(), 3000);
      }
    } catch (e: any) {
      setClaimStatus(prev => ({
        ...prev,
        [walletId]: { loading: false, result: { success: false, error: e.message } },
      }));
    }
  };

  const openUndelegate = (walletId: string, validatorAddress: string, maxUmec: number) => {
    setUndelegateResult(null);
    setUndelegateModal({ walletId, validatorAddress, maxUmec, amountMec: (maxUmec / UMEC_PER_MEC).toFixed(6) });
  };

  const submitUndelegate = async () => {
    if (!undelegateModal) return;
    const amountMec = parseFloat(undelegateModal.amountMec);
    if (isNaN(amountMec) || amountMec <= 0) {
      setUndelegateResult({ success: false, error: 'Enter a valid amount greater than 0.' });
      return;
    }
    const amountUmec = Math.floor(amountMec * UMEC_PER_MEC);
    if (amountUmec > undelegateModal.maxUmec) {
      setUndelegateResult({ success: false, error: `Amount exceeds staked balance (${fmtMec(undelegateModal.maxUmec)}).` });
      return;
    }
    if (!confirm(
      `Undelegate ${fmtMec(amountUmec)} from ${shortVal(undelegateModal.validatorAddress)}?\n\nTokens will be locked for the unbonding period (~21 days) before returning to your hub wallet.`
    )) return;

    setUndelegating(true);
    setUndelegateResult(null);
    try {
      const result = await api.undelegate(undelegateModal.walletId, undelegateModal.validatorAddress, amountUmec);
      setUndelegateResult(result);
      if (result.success) {
        setTimeout(() => {
          setUndelegateModal(null);
          loadAll();
        }, 3000);
      }
    } catch (e: any) {
      setUndelegateResult({ success: false, error: e.message });
    } finally {
      setUndelegating(false);
    }
  };

  const totalStaked = Object.values(stakingInfo).reduce((s, i) => s + i.totalStakedUmec, 0);
  const totalRewards = Object.values(stakingInfo).reduce((s, i) => s + i.totalRewardsUmec, 0);
  const totalUnbonding = Object.values(stakingInfo).reduce(
    (s, i) => s + i.unbonding.reduce((u, e) => u + e.amountUmec, 0), 0
  );

  return (
    <div className="space-y-4 max-w-4xl">
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-300 flex items-center gap-2">
          <span>⚠️ {error}</span>
          <button onClick={() => setError(null)} className="ml-auto">✕</button>
        </div>
      )}

      {/* Summary stats */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <p className="text-xs text-slate-400 mb-1">Total Staked</p>
          <p className="text-lg font-bold text-amber-400">{fmtMec(totalStaked)}</p>
        </div>
        <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <p className="text-xs text-slate-400 mb-1">Pending Rewards</p>
          <p className="text-lg font-bold text-green-400">{fmtMec(totalRewards)}</p>
        </div>
        <div className="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <p className="text-xs text-slate-400 mb-1">Unbonding</p>
          <p className="text-lg font-bold text-orange-400">{fmtMec(totalUnbonding)}</p>
        </div>
      </div>

      <div className="flex gap-2">
        <button
          onClick={loadAll}
          disabled={loading || wallets.length === 0}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {loading ? '⏳ Loading…' : '⟳ Refresh'}
        </button>
      </div>

      {wallets.length === 0 && (
        <div className="text-center py-12 text-slate-500 text-sm">
          No wallets imported yet — go to the Wallets tab to import some.
        </div>
      )}

      {/* Per-wallet staking panels */}
      {wallets.map(w => {
        const info = stakingInfo[w.id];
        const claim = claimStatus[w.id];
        const hasCredentials = w.hasCredentials;

        return (
          <div key={w.id} className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
            {/* Wallet header */}
            <div className="flex items-center gap-3 px-5 py-3 bg-slate-900/60 border-b border-slate-700">
              <div className="flex-1 min-w-0">
                <p className="text-sm font-semibold text-white">{w.label}</p>
                <p className="text-xs text-slate-500 font-mono">{shortAddr(w.address)}</p>
              </div>
              {info && (
                <div className="flex items-center gap-4 text-xs">
                  <span className="text-amber-400">Staked: <span className="font-mono">{fmtMec(info.totalStakedUmec)}</span></span>
                  <span className="text-green-400">Rewards: <span className="font-mono">{fmtMec(info.totalRewardsUmec)}</span></span>
                </div>
              )}
              {info && info.totalRewardsUmec > 0 && hasCredentials && (
                <button
                  onClick={() => claimRewards(w.id)}
                  disabled={claim?.loading}
                  className="px-3 py-1.5 bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition-colors whitespace-nowrap"
                >
                  {claim?.loading ? '⏳ Claiming…' : '💰 Claim Rewards'}
                </button>
              )}
            </div>

            {/* Claim result banner */}
            {claim?.result && (
              <div className={`px-5 py-2 text-xs flex items-center gap-2 ${claim.result.success ? 'bg-green-500/10 text-green-300' : 'bg-red-500/10 text-red-300'}`}>
                <span>{claim.result.success ? '✅' : '❌'}</span>
                {claim.result.success ? (
                  <span>Rewards claimed! {claim.result.txHash && <span className="font-mono opacity-70">TX: {claim.result.txHash}</span>}</span>
                ) : (
                  <span>{claim.result.error ?? claim.result.note}</span>
                )}
              </div>
            )}

            {/* Loading skeleton */}
            {!info && loading && (
              <div className="px-5 py-6 text-center text-slate-500 text-sm">Loading staking data…</div>
            )}

            {/* No delegations */}
            {info && info.delegations.length === 0 && info.unbonding.length === 0 && (
              <div className="px-5 py-6 text-center text-slate-500 text-sm">
                No active delegations on this wallet.
              </div>
            )}

            {/* Delegations table */}
            {info && info.delegations.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-700/50 bg-slate-900/30">
                      <th className="text-left px-5 py-2 text-xs font-medium text-slate-400 uppercase tracking-wider">Validator</th>
                      <th className="text-right px-4 py-2 text-xs font-medium text-slate-400 uppercase tracking-wider">Staked</th>
                      <th className="text-right px-4 py-2 text-xs font-medium text-slate-400 uppercase tracking-wider">Pending Rewards</th>
                      {hasCredentials && <th className="text-center px-4 py-2 text-xs font-medium text-slate-400 uppercase tracking-wider">Actions</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {info.delegations.map(d => (
                      <tr key={d.validatorAddress} className="border-b border-slate-700/30 hover:bg-slate-700/20 transition-colors">
                        <td className="px-5 py-3">
                          <span className="font-mono text-xs text-slate-300" title={d.validatorAddress}>{shortVal(d.validatorAddress)}</span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-amber-400">{fmtMec(d.stakedUmec)}</td>
                        <td className="px-4 py-3 text-right font-mono text-xs text-green-400">{fmtMec(d.pendingRewardsUmec)}</td>
                        {hasCredentials && (
                          <td className="px-4 py-3 text-center">
                            <button
                              onClick={() => openUndelegate(w.id, d.validatorAddress, d.stakedUmec)}
                              className="px-2.5 py-1 bg-orange-600/80 hover:bg-orange-500 text-white text-xs font-medium rounded transition-colors"
                            >
                              Undelegate
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Unbonding entries */}
            {info && info.unbonding.length > 0 && (
              <div className="border-t border-slate-700/50">
                <p className="px-5 py-2 text-xs font-semibold text-orange-400 uppercase tracking-wider">Unbonding</p>
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-700/30 bg-slate-900/20">
                      <th className="text-left px-5 py-2 text-xs font-medium text-slate-400 uppercase tracking-wider">Validator</th>
                      <th className="text-right px-4 py-2 text-xs font-medium text-slate-400 uppercase tracking-wider">Amount</th>
                      <th className="text-right px-4 py-2 text-xs font-medium text-slate-400 uppercase tracking-wider">Completes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {info.unbonding.map((u, i) => (
                      <tr key={i} className="border-b border-slate-700/20 hover:bg-slate-700/20 transition-colors">
                        <td className="px-5 py-2.5">
                          <span className="font-mono text-xs text-slate-400" title={u.validatorAddress}>{shortVal(u.validatorAddress)}</span>
                        </td>
                        <td className="px-4 py-2.5 text-right font-mono text-xs text-orange-400">{fmtMec(u.amountUmec)}</td>
                        <td className="px-4 py-2.5 text-right text-xs text-slate-400">{fmtTime(u.completionTime)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        );
      })}

      {/* Undelegate Modal */}
      {undelegateModal && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-xl border border-slate-700 w-full max-w-md shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-slate-700">
              <h2 className="text-base font-semibold text-white">Undelegate Tokens</h2>
              <button onClick={() => setUndelegateModal(null)} className="text-slate-400 hover:text-white transition-colors">✕</button>
            </div>
            <div className="p-5 space-y-4">
              <div className="bg-slate-900/60 rounded-lg p-3 space-y-1">
                <p className="text-xs text-slate-400">Validator</p>
                <p className="text-xs font-mono text-slate-300 break-all">{undelegateModal.validatorAddress}</p>
              </div>

              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg px-4 py-3 text-xs text-amber-300">
                ⚠️ Undelegated tokens are locked for the unbonding period (~21 days) before returning to your hub wallet. You will not earn rewards during this time.
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
                  Amount to Undelegate (MEC)
                </label>
                <input
                  type="number"
                  value={undelegateModal.amountMec}
                  onChange={e => setUndelegateModal(prev => prev ? { ...prev, amountMec: e.target.value } : null)}
                  min={0}
                  step={0.000001}
                  max={undelegateModal.maxUmec / UMEC_PER_MEC}
                  className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 font-mono focus:outline-none focus:border-blue-500"
                />
                <p className="text-xs text-slate-500">
                  Max: {fmtMec(undelegateModal.maxUmec)}
                  <button
                    onClick={() => setUndelegateModal(prev => prev ? { ...prev, amountMec: (prev.maxUmec / UMEC_PER_MEC).toFixed(6) } : null)}
                    className="ml-2 text-blue-400 hover:text-blue-300"
                  >
                    Use max
                  </button>
                </p>
              </div>

              {undelegateResult && (
                <div className={`rounded-lg px-4 py-3 text-sm ${undelegateResult.success ? 'bg-green-500/10 border border-green-500/30 text-green-300' : 'bg-red-500/10 border border-red-500/30 text-red-300'}`}>
                  {undelegateResult.success ? (
                    <span>✅ Undelegation submitted! {undelegateResult.txHash && <span className="font-mono text-xs opacity-70">TX: {undelegateResult.txHash}</span>}</span>
                  ) : (
                    <span>❌ {undelegateResult.error}</span>
                  )}
                </div>
              )}

              <div className="flex gap-2 justify-end pt-1">
                <button
                  onClick={() => setUndelegateModal(null)}
                  className="px-4 py-2 text-sm rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={submitUndelegate}
                  disabled={undelegating}
                  className="px-4 py-2 text-sm rounded-lg bg-orange-600 hover:bg-orange-500 disabled:opacity-40 text-white font-medium transition-colors"
                >
                  {undelegating ? '⏳ Submitting…' : 'Undelegate'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
