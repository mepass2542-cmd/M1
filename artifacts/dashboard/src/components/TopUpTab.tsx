import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import type { TopupConfig, TopupRunSummary, TopupLogEntry } from '../types';

function umecToMec(u: number) { return (u / 1_000_000).toFixed(4); }
function relTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function fmtTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

const THRESHOLD_PRESETS = [
  { label: '15k (1 tx)', value: 15000 },
  { label: '25k (2 tx)', value: 25000 },
  { label: '50k (4 tx)', value: 50000 },
  { label: '100k (8 tx)', value: 100000 },
];
const TOPUP_PRESETS = [
  { label: '0.05 MEC', value: 50000 },
  { label: '0.1 MEC', value: 100000 },
  { label: '0.5 MEC', value: 500000 },
  { label: '1 MEC', value: 1000000 },
];

export function TopUpTab() {
  const { wallets } = useApp();
  const [view, setView] = useState<'config' | 'history'>('config');

  const [cfg, setCfg] = useState<TopupConfig>({
    enabled: false,
    masterWalletId: null,
    thresholdUmec: 25000,
    topupAmountUmec: 100000,
    runBeforeCheckin: true,
  });
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState<string | null>(null);

  const [running, setRunning] = useState(false);
  const [summary, setSummary] = useState<TopupRunSummary | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const [history, setHistory] = useState<TopupLogEntry[]>([]);
  const [histLoading, setHistLoading] = useState(false);

  const loadConfig = useCallback(async () => {
    try { setCfg(await api.getTopupConfig()); } catch { }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const saveConfig = async (patch: Partial<TopupConfig>) => {
    const next = { ...cfg, ...patch };
    setCfg(next);
    setSaving(true); setSaveMsg(null);
    try {
      const saved = await api.setTopupConfig(next);
      setCfg(saved);
      setSaveMsg('Saved.');
      setTimeout(() => setSaveMsg(null), 2000);
    } catch (e: any) {
      setSaveMsg('Error: ' + (e.message ?? 'Save failed'));
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true); setSummary(null); setRunError(null);
    try {
      const s = await api.runTopup();
      setSummary(s);
    } catch (e: any) {
      setRunError(e.message ?? 'Top-up failed');
    } finally {
      setRunning(false);
    }
  };

  const loadHistory = async () => {
    setHistLoading(true);
    try { setHistory(await api.getTopupHistory(200)); }
    catch { }
    finally { setHistLoading(false); }
  };

  useEffect(() => {
    if (view === 'history') loadHistory();
  }, [view]);

  const masterWallet = wallets.find(w => w.id === cfg.masterWalletId);
  const nonMasterWallets = wallets.filter(w => w.id !== cfg.masterWalletId);

  return (
    <div className="space-y-4 max-w-2xl">

      {/* Tab switcher */}
      <div className="flex gap-1 bg-slate-800/60 p-1 rounded-lg border border-slate-700">
        {(['config', 'history'] as const).map(v => (
          <button key={v} onClick={() => setView(v)}
            className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors ${
              view === v ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {v === 'config' ? '⚙️ Configuration' : '📋 History'}
          </button>
        ))}
      </div>

      {/* ── CONFIG VIEW ─────────────────────────────────────────────────── */}
      {view === 'config' && (
        <div className="space-y-4">

          {/* Enable / status banner */}
          <div className={`rounded-xl border px-5 py-4 flex items-center gap-4 ${
            cfg.enabled
              ? 'bg-green-500/10 border-green-500/30'
              : 'bg-slate-800/50 border-slate-700'
          }`}>
            <span className="text-3xl">{cfg.enabled ? '💰' : '💤'}</span>
            <div className="flex-1">
              <p className={`text-sm font-semibold ${cfg.enabled ? 'text-green-300' : 'text-slate-400'}`}>
                Auto Top-Up is {cfg.enabled ? 'enabled' : 'disabled'}
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                {cfg.enabled
                  ? `Tops up wallets below ${umecToMec(cfg.thresholdUmec)} MEC → sends ${umecToMec(cfg.topupAmountUmec)} MEC each${cfg.runBeforeCheckin ? ' · runs before every check-in' : ''}`
                  : 'Enable to automatically top up wallet fee balances before check-ins.'}
              </p>
            </div>
            <button
              onClick={() => saveConfig({ enabled: !cfg.enabled })}
              disabled={saving}
              className={`px-4 py-2 text-xs font-medium rounded-lg transition-colors ${
                cfg.enabled
                  ? 'bg-slate-700 hover:bg-slate-600 text-white'
                  : 'bg-green-600 hover:bg-green-500 text-white'
              }`}
            >
              {cfg.enabled ? 'Disable' : 'Enable'}
            </button>
          </div>

          {/* Master wallet */}
          <div className="bg-slate-800 rounded-xl border border-slate-700 p-5 space-y-3">
            <div>
              <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Master Wallet <span className="text-red-400">*</span>
              </label>
              <p className="text-xs text-slate-500 mt-0.5">
                This wallet pays the fee and sends MEC to low-balance wallets. Keep it funded.
              </p>
            </div>
            <select
              value={cfg.masterWalletId ?? ''}
              onChange={e => saveConfig({ masterWalletId: e.target.value || null })}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
            >
              <option value="">— select master wallet —</option>
              {wallets.map(w => (
                <option key={w.id} value={w.id}>{w.label} ({w.address.slice(0, 12)}…)</option>
              ))}
            </select>
            {masterWallet && (
              <div className="flex items-center gap-2 text-xs text-slate-500 bg-slate-900/50 rounded-lg px-3 py-2">
                <span className="text-blue-400">🔑</span>
                <span className="font-mono text-slate-400">{masterWallet.address}</span>
              </div>
            )}
            {!masterWallet && cfg.enabled && (
              <p className="text-xs text-amber-400">⚠️ Select a master wallet to activate auto top-up.</p>
            )}
          </div>

          {/* Threshold + Top-up amount */}
          <div className="grid grid-cols-2 gap-4">
            <div className="bg-slate-800 rounded-xl border border-slate-700 p-4 space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Top-Up Trigger</label>
                <p className="text-xs text-slate-500 mt-0.5">Top up if hub balance is below this</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {THRESHOLD_PRESETS.map(p => (
                  <button key={p.value}
                    onClick={() => saveConfig({ thresholdUmec: p.value })}
                    className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${
                      cfg.thresholdUmec === p.value
                        ? 'bg-blue-600 border-blue-500 text-white'
                        : 'bg-slate-700 border-slate-600 text-slate-300 hover:border-blue-500'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <input
                type="number"
                value={cfg.thresholdUmec}
                onChange={e => setCfg(c => ({ ...c, thresholdUmec: parseInt(e.target.value) || 0 }))}
                onBlur={() => saveConfig({ thresholdUmec: cfg.thresholdUmec })}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
              />
              <p className="text-xs text-slate-500">{umecToMec(cfg.thresholdUmec)} MEC threshold</p>
            </div>

            <div className="bg-slate-800 rounded-xl border border-slate-700 p-4 space-y-3">
              <div>
                <label className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Top-Up Amount</label>
                <p className="text-xs text-slate-500 mt-0.5">How much to send per wallet per top-up</p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {TOPUP_PRESETS.map(p => (
                  <button key={p.value}
                    onClick={() => saveConfig({ topupAmountUmec: p.value })}
                    className={`px-2.5 py-1 text-xs rounded-lg border transition-colors ${
                      cfg.topupAmountUmec === p.value
                        ? 'bg-blue-600 border-blue-500 text-white'
                        : 'bg-slate-700 border-slate-600 text-slate-300 hover:border-blue-500'
                    }`}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <input
                type="number"
                value={cfg.topupAmountUmec}
                onChange={e => setCfg(c => ({ ...c, topupAmountUmec: parseInt(e.target.value) || 0 }))}
                onBlur={() => saveConfig({ topupAmountUmec: cfg.topupAmountUmec })}
                className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
              />
              <p className="text-xs text-slate-500">{umecToMec(cfg.topupAmountUmec)} MEC per wallet</p>
            </div>
          </div>

          {/* Run before check-in toggle */}
          <div className="bg-slate-800 rounded-xl border border-slate-700 px-5 py-4 flex items-center gap-4">
            <div className="flex-1">
              <p className="text-sm font-medium text-slate-200">Run automatically before check-ins</p>
              <p className="text-xs text-slate-500 mt-0.5">
                When enabled, the scheduler tops up all low-balance wallets before running daily check-ins — guaranteeing every wallet has enough fee balance.
              </p>
            </div>
            <button
              onClick={() => saveConfig({ runBeforeCheckin: !cfg.runBeforeCheckin })}
              disabled={saving}
              className={`relative w-11 h-6 rounded-full transition-colors shrink-0 ${
                cfg.runBeforeCheckin ? 'bg-blue-600' : 'bg-slate-600'
              }`}
            >
              <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform ${
                cfg.runBeforeCheckin ? 'translate-x-5' : 'translate-x-0'
              }`} />
            </button>
          </div>

          {saveMsg && (
            <div className={`text-xs rounded-lg px-3 py-2 ${
              saveMsg.startsWith('Error')
                ? 'bg-red-500/10 text-red-300 border border-red-500/30'
                : 'bg-green-500/10 text-green-300 border border-green-500/30'
            }`}>
              {saveMsg}
            </div>
          )}

          {/* Manual run */}
          <div className="bg-slate-800 rounded-xl border border-slate-700 p-5 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-semibold text-slate-200">Run Top-Up Now</p>
                <p className="text-xs text-slate-500 mt-0.5">
                  Check all {nonMasterWallets.length} wallets and top up any below the threshold.
                </p>
              </div>
              <button
                onClick={runNow}
                disabled={running || !cfg.masterWalletId}
                className="px-4 py-2 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition-colors whitespace-nowrap"
              >
                {running ? '⏳ Running…' : '▶ Run Now'}
              </button>
            </div>

            {runError && (
              <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-300">
                ❌ {runError}
              </div>
            )}

            {summary && !runError && (
              <div className="space-y-3">
                {/* Summary banner */}
                <div className={`rounded-lg px-4 py-3 flex items-center gap-3 ${
                  summary.failed > 0
                    ? 'bg-amber-500/10 border border-amber-500/30'
                    : 'bg-green-500/10 border border-green-500/30'
                }`}>
                  <span className="text-xl">{summary.failed > 0 ? '⚠️' : '✅'}</span>
                  <div className="flex-1 text-sm">
                    <p className={`font-semibold ${summary.failed > 0 ? 'text-amber-300' : 'text-green-300'}`}>
                      {summary.toppedUp > 0
                        ? `Topped up ${summary.toppedUp} wallet${summary.toppedUp !== 1 ? 's' : ''}`
                        : 'All wallets already have enough balance'}
                      {summary.failed > 0 && ` · ${summary.failed} failed`}
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      Master: {summary.masterLabel}
                      {' · '}Before: {umecToMec(summary.masterBalanceBefore)} MEC
                      {' → '}After: {umecToMec(summary.masterBalanceAfter)} MEC
                      {summary.skipped > 0 && ` · ${summary.skipped} already OK`}
                    </p>
                  </div>
                </div>

                {/* Per-wallet results */}
                <div className="divide-y divide-slate-700/40 rounded-lg border border-slate-700 overflow-hidden">
                  {summary.results.map(r => (
                    <div key={r.walletId} className="flex items-center gap-3 px-4 py-2.5">
                      <span className="text-sm shrink-0">
                        {r.skipped ? '○' : r.success ? '✅' : '❌'}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-300">{r.label}</p>
                        {r.txHash && (
                          <p className="text-xs text-slate-500 font-mono">{r.txHash.slice(0, 20)}…</p>
                        )}
                        {r.error && (
                          <p className="text-xs text-red-400 truncate">{r.error}</p>
                        )}
                      </div>
                      <div className="text-right text-xs text-slate-500 shrink-0">
                        {r.skipped
                          ? <span className="text-slate-500">{umecToMec(r.balanceBefore)} MEC ✓</span>
                          : r.success
                          ? <span className="text-green-400">+{umecToMec(summary.results.find(x => x.walletId === r.walletId) ? r.balanceBefore : 0)} MEC sent</span>
                          : <span className="text-red-400">was {umecToMec(r.balanceBefore)} MEC</span>
                        }
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Info box */}
          <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg px-4 py-3 text-xs text-slate-400 space-y-1">
            <p><span className="text-slate-300 font-medium">How it works:</span> Before each scheduled check-in, the bot checks every wallet's hub balance. Any wallet below <span className="text-blue-400">{umecToMec(cfg.thresholdUmec)} MEC</span> receives <span className="text-blue-400">{umecToMec(cfg.topupAmountUmec)} MEC</span> from the master wallet. The hub fee is 12,000 umec (0.012 MEC) per check-in.</p>
            <p>Each top-up transaction costs the master wallet {umecToMec(cfg.topupAmountUmec + 12000)} MEC ({umecToMec(cfg.topupAmountUmec)} sent + 0.0120 MEC fee). With {nonMasterWallets.length} wallets, a full top-up costs at most {umecToMec((cfg.topupAmountUmec + 12000) * nonMasterWallets.length)} MEC.</p>
          </div>
        </div>
      )}

      {/* ── HISTORY VIEW ────────────────────────────────────────────────── */}
      {view === 'history' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-500">Last 200 top-up transactions</p>
            <button onClick={loadHistory} className="text-xs text-blue-400 hover:text-blue-300">↻ Refresh</button>
          </div>
          {histLoading ? (
            <p className="text-center py-10 text-slate-500 text-sm animate-pulse">Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-center py-10 text-slate-500 text-sm">No top-ups yet — run the top-up to see history here.</p>
          ) : (
            <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
              <div className="divide-y divide-slate-700/40 max-h-[500px] overflow-y-auto">
                {history.map(h => (
                  <div key={h.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="text-sm shrink-0">{h.success ? '✅' : '❌'}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-slate-300">{h.wallet_label}</p>
                      {h.tx_hash && (
                        <p className="text-xs text-slate-500 font-mono">{h.tx_hash.slice(0, 20)}…</p>
                      )}
                      {h.error && (
                        <p className="text-xs text-red-400 truncate">{h.error}</p>
                      )}
                    </div>
                    <div className="text-right text-xs text-slate-500 shrink-0 space-y-0.5">
                      <p className="text-blue-400">+{umecToMec(h.amount_umec)} MEC</p>
                      <p>{fmtTime(h.executed_at)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
