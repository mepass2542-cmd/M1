import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import type { CheckInResult, SchedulerState, WalletCheckinStats, CheckinLogEntry } from '../types';

function shortAddr(a: string) { return a ? a.slice(0, 10) + '…' + a.slice(-6) : ''; }
function relTime(iso: string | null): string {
  if (!iso) return 'never';
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function timeUntil(iso: string | null): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return 'any moment';
  const m = Math.floor(diff / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem > 0 ? `in ${h}h ${rem}m` : `in ${h}h`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}
function streakEmoji(n: number) {
  if (n >= 30) return '🔥';
  if (n >= 7)  return '⚡';
  if (n >= 1)  return '✅';
  return '○';
}

export function CheckInTab() {
  const { wallets, setWallets } = useApp();
  const [view, setView] = useState<'scheduler' | 'manual' | 'history'>('scheduler');

  // ── Scheduler state ──────────────────────────────────────────────────────
  const [schedule, setSchedule] = useState<SchedulerState | null>(null);
  const [stats, setStats] = useState<WalletCheckinStats[]>([]);
  const [triggering, setTriggering] = useState(false);
  const [triggerMsg, setTriggerMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Manual check-in state ────────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<CheckInResult[]>([]);
  const [manualError, setManualError] = useState<string | null>(null);
  const [manualLog, setManualLog] = useState<string[]>([]);

  // ── History state ────────────────────────────────────────────────────────
  const [history, setHistory] = useState<CheckinLogEntry[]>([]);
  const [histLoading, setHistLoading] = useState(false);

  const loadSchedule = useCallback(async () => {
    try {
      const [s, st] = await Promise.all([api.getSchedule(), api.getCheckinStats()]);
      setSchedule(s);
      setStats(st);
    } catch { /* ignore */ }
  }, []);

  const loadWallets = useCallback(async () => {
    try { const ws = await api.getWallets(); setWallets(ws); } catch { }
  }, [setWallets]);

  useEffect(() => {
    loadWallets();
    loadSchedule();
  }, [loadWallets, loadSchedule]);

  // Poll every 4s while running, every 30s otherwise
  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    const interval = schedule?.isRunning ? 4000 : 30000;
    pollRef.current = setInterval(loadSchedule, interval);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [schedule?.isRunning, loadSchedule]);

  const triggerNow = async () => {
    setTriggering(true);
    setTriggerMsg(null);
    try {
      await api.triggerSchedule();
      setTriggerMsg('Check-in started for all wallets — results will appear below.');
      await loadSchedule();
    } catch (e: any) {
      setTriggerMsg('Error: ' + (e.message ?? 'Failed to trigger'));
    } finally {
      setTriggering(false);
    }
  };

  const loadHistory = async () => {
    setHistLoading(true);
    try { setHistory(await api.getCheckinHistory(200)); } catch { }
    finally { setHistLoading(false); }
  };

  useEffect(() => {
    if (view === 'history') loadHistory();
  }, [view]);

  // ── Manual check-in helpers ──────────────────────────────────────────────
  const toggleAll = () => {
    if (selected.size === wallets.length && wallets.length > 0) setSelected(new Set());
    else setSelected(new Set(wallets.map(w => w.id)));
  };
  const toggle = (id: string) => setSelected(prev => {
    const next = new Set(prev); next.has(id) ? next.delete(id) : next.add(id); return next;
  });
  const addLog = (line: string) =>
    setManualLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${line}`]);

  const runManual = async () => {
    if (selected.size === 0) return;
    setRunning(true); setResults([]); setManualError(null); setManualLog([]);
    addLog(`Starting check-in for ${selected.size} wallet(s)…`);

    try {
      await api.checkin([...selected]); // now returns { started: true } immediately
    } catch (e: any) {
      const msg = e.message ?? String(e);
      if (msg.includes('409') || /already running/i.test(msg)) {
        setManualError('A check-in is already in progress — results will appear in the Auto-Scheduler tab.');
      } else {
        setManualError(msg); addLog('❌ ' + msg);
      }
      setRunning(false);
      return;
    }

    // Poll /api/checkin/schedule every 2 s; stream per-wallet results as they arrive.
    let prevCount = 0;
    const poll = setInterval(async () => {
      try {
        const s = await api.getSchedule();
        setSchedule(s);
        const newEntries = (s.lastResults ?? []).slice(prevCount);
        newEntries.forEach((r: any) => addLog(r.success
          ? `✅ ${r.label} — TX: ${r.txHash ?? ''}`
          : `❌ ${r.label} — ${r.error ?? 'failed'}`));
        prevCount = (s.lastResults ?? []).length;

        if (!s.isRunning) {
          clearInterval(poll);
          const mapped = (s.lastResults ?? []).map((r: any) => ({
            id: r.walletId, label: r.label, success: r.success,
            txHash: r.txHash, error: r.error,
          })) as CheckInResult[];
          setResults(mapped);
          addLog(`Done: ${mapped.filter(r => r.success).length}/${mapped.length} succeeded.`);
          setRunning(false);
          loadSchedule();
        }
      } catch { /* ignore transient poll errors */ }
    }, 2000);
  };

  // ── Computed ─────────────────────────────────────────────────────────────
  const checkedToday = stats.filter(s => s.checked_in_today).length;
  const totalWallets = stats.length;
  const maxStreak    = stats.reduce((m, s) => Math.max(m, s.streak), 0);
  const allOkToday   = totalWallets > 0 && checkedToday === totalWallets;

  return (
    <div className="space-y-4 max-w-3xl">

      {/* Tab switcher */}
      <div className="flex gap-1 bg-slate-800/60 p-1 rounded-lg border border-slate-700">
        {(['scheduler', 'manual', 'history'] as const).map(v => (
          <button key={v} onClick={() => setView(v)}
            className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors capitalize ${
              view === v ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {v === 'scheduler' ? '🕐 Auto-Scheduler' : v === 'manual' ? '▶ Manual' : '📋 History'}
          </button>
        ))}
      </div>

      {/* ── SCHEDULER VIEW ─────────────────────────────────────────────── */}
      {view === 'scheduler' && (
        <div className="space-y-4">

          {/* Status banner */}
          <div className={`rounded-xl border px-5 py-4 flex items-center gap-4 ${
            allOkToday
              ? 'bg-green-500/10 border-green-500/30'
              : 'bg-amber-500/10 border-amber-500/30'
          }`}>
            <span className="text-3xl">{allOkToday ? '✅' : schedule?.isRunning ? '⏳' : '⚠️'}</span>
            <div className="flex-1">
              <p className={`text-sm font-semibold ${allOkToday ? 'text-green-300' : 'text-amber-300'}`}>
                {schedule?.isRunning
                  ? 'Check-in running now…'
                  : allOkToday
                  ? `All ${totalWallets} wallets checked in today ✓`
                  : `${checkedToday}/${totalWallets} wallets checked in today`}
              </p>
              <p className="text-xs text-slate-400 mt-0.5">
                Cron: <code className="text-blue-400">{schedule?.cronExpr ?? '—'}</code> UTC
                {' · '}Last run: <span className="text-slate-300">{relTime(schedule?.lastRunAt ?? null)}</span>
                {' · '}Next run: <span className="text-blue-300 font-medium">{timeUntil(schedule?.nextRunAt ?? null)}</span>
                {' · '}Best streak: <span className="text-amber-400">{maxStreak} day{maxStreak !== 1 ? 's' : ''}</span>
              </p>
            </div>
            <button
              onClick={triggerNow}
              disabled={triggering || schedule?.isRunning}
              className="px-4 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-xs font-medium rounded-lg transition-colors whitespace-nowrap"
            >
              {triggering || schedule?.isRunning ? '⏳ Running…' : '▶ Run Now'}
            </button>
          </div>

          {triggerMsg && (
            <div className={`text-xs rounded-lg px-3 py-2 ${
              triggerMsg.startsWith('Error') ? 'bg-red-500/10 text-red-300 border border-red-500/30'
              : 'bg-blue-500/10 text-blue-300 border border-blue-500/30'
            }`}>
              {triggerMsg}
            </div>
          )}

          {/* Scheduler info */}
          <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg px-4 py-3 text-xs text-slate-400 space-y-1">
            <p><span className="text-slate-300 font-medium">Always-on, never misses a streak:</span></p>
            <ul className="list-disc list-inside space-y-0.5 pl-1">
              <li><span className="text-slate-300">Daily cron</span> — runs at your <code className="text-blue-400">CRON_SCHEDULE</code> (default 09:00 UTC) for every wallet</li>
              <li><span className="text-slate-300">Startup catch-up</span> — on server restart, any wallet that missed today is checked in immediately</li>
              <li><span className="text-slate-300">Watchdog</span> — scans every 5 minutes; any wallet that hasn't checked in today is checked in automatically</li>
              <li><span className="text-slate-300">New wallet auto-check-in</span> — when you import wallets they are checked in instantly, today's streak starts right away</li>
            </ul>
            <p className="pt-0.5">Set <code className="text-blue-400">CRON_SCHEDULE</code> in Replit Secrets to change timing (e.g. <code className="text-slate-300">0 6 * * *</code> for 06:00 UTC).</p>
          </div>

          {/* Per-wallet streak table */}
          <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-700 flex items-center gap-2">
              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider flex-1">
                Wallet Streaks
              </p>
              <button onClick={loadSchedule} className="text-xs text-slate-500 hover:text-slate-300">↻ Refresh</button>
            </div>
            <div className="divide-y divide-slate-700/40 max-h-96 overflow-y-auto">
              {stats.length === 0 && (
                <p className="text-center py-8 text-slate-500 text-sm">No wallets yet.</p>
              )}
              {stats.map(s => (
                <div key={s.wallet_id} className="flex items-center gap-3 px-5 py-3">
                  <span className="text-lg w-7 text-center">{streakEmoji(s.streak)}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-200 truncate">{s.label}</p>
                    <p className="text-xs text-slate-500 font-mono">{shortAddr(s.address)}</p>
                  </div>
                  <div className="text-right shrink-0 space-y-0.5">
                    <p className="text-sm font-semibold text-amber-400">
                      {s.streak} day{s.streak !== 1 ? 's' : ''}
                    </p>
                    <p className="text-xs text-slate-500">
                      {s.checked_in_today
                        ? <span className="text-green-400">✓ today</span>
                        : s.last_success_at
                        ? relTime(s.last_success_at)
                        : 'never'}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Last run results */}
          {(schedule?.lastResults?.length ?? 0) > 0 && (
            <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
              <p className="px-5 py-3 text-xs font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-700">
                Last Run Results ({relTime(schedule!.lastRunAt)})
              </p>
              <div className="divide-y divide-slate-700/40 max-h-64 overflow-y-auto">
                {schedule!.lastResults.map(r => (
                  <div key={r.walletId} className="flex items-center gap-3 px-5 py-2.5">
                    <span className="text-sm">{r.success ? '✅' : '❌'}</span>
                    <span className="text-sm text-slate-300 flex-1">{r.label}</span>
                    {r.txHash && (
                      <span className="text-xs text-slate-500 font-mono">{r.txHash.slice(0, 14)}…</span>
                    )}
                    {r.error && !r.success && (
                      <span className="text-xs text-red-400 max-w-xs truncate">{r.error}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── MANUAL VIEW ────────────────────────────────────────────────── */}
      {view === 'manual' && (
        <div className="space-y-4">
          {manualError && (
            <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-300 flex items-center gap-2">
              <span>⚠️ {manualError}</span>
              <button onClick={() => setManualError(null)} className="ml-auto">✕</button>
            </div>
          )}

          <div className="bg-slate-800/50 border border-slate-700/50 rounded-lg px-4 py-3 text-xs text-slate-400">
            <strong className="text-slate-300">Manual check-in:</strong> Broadcasts <code className="text-blue-400">MsgCheckIn</code> immediately for selected wallets on the rollup chain. Zero fee. The auto-scheduler handles daily runs automatically.
          </div>

          <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
              <h2 className="text-sm font-semibold text-white">
                Select Wallets <span className="text-slate-500 font-normal">({selected.size}/{wallets.length})</span>
              </h2>
              <button onClick={toggleAll} className="text-xs text-blue-400 hover:text-blue-300">
                {selected.size === wallets.length && wallets.length > 0 ? 'Deselect All' : 'Select All'}
              </button>
            </div>
            {wallets.length === 0 ? (
              <p className="text-center py-10 text-slate-500 text-sm">No wallets imported yet.</p>
            ) : (
              <div className="divide-y divide-slate-700/50 max-h-80 overflow-y-auto">
                {wallets.map(w => {
                  const r = results.find(r => r.id === w.id);
                  const stat = stats.find(s => s.wallet_id === w.id);
                  return (
                    <label key={w.id} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-700/30 cursor-pointer">
                      <input type="checkbox" checked={selected.has(w.id)} onChange={() => toggle(w.id)}
                        className="rounded border-slate-600 bg-slate-700 text-blue-500" />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-slate-200">{w.label}</p>
                        <p className="text-xs text-slate-500 font-mono truncate">{w.address}</p>
                      </div>
                      <div className="shrink-0 text-right space-y-0.5">
                        {stat && (
                          <p className="text-xs text-amber-400">{streakEmoji(stat.streak)} {stat.streak}d streak</p>
                        )}
                        {r && (
                          <span className={`text-xs px-2 py-0.5 rounded-full ${r.success ? 'bg-green-500/20 text-green-300' : 'bg-red-500/20 text-red-300'}`}>
                            {r.success ? `✓ ${r.txHash?.slice(0, 8)}…` : '✕ Failed'}
                          </span>
                        )}
                        {running && selected.has(w.id) && !r && (
                          <span className="text-xs text-slate-400 animate-pulse">pending…</span>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            )}
            <div className="px-5 py-4 border-t border-slate-700 flex items-center gap-3">
              <button onClick={runManual} disabled={running || selected.size === 0}
                className="px-5 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors">
                {running ? '⏳ Broadcasting…' : `▶ Run Check-In (${selected.size} wallet${selected.size !== 1 ? 's' : ''})`}
              </button>
              {results.length > 0 && (
                <span className="text-xs text-slate-400">
                  <span className="text-green-400">{results.filter(r => r.success).length} OK</span>
                  {results.filter(r => !r.success).length > 0 && (
                    <span className="text-red-400 ml-2">{results.filter(r => !r.success).length} failed</span>
                  )}
                </span>
              )}
              {manualLog.length > 0 && (
                <button onClick={() => { setManualLog([]); setResults([]); }} className="ml-auto text-xs text-slate-500 hover:text-slate-300">Clear</button>
              )}
            </div>
          </div>

          {manualLog.length > 0 && (
            <div className="bg-slate-900 rounded-xl border border-slate-700 p-4">
              <p className="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">Log</p>
              <div className="space-y-1 max-h-56 overflow-y-auto">
                {manualLog.map((line, i) => (
                  <p key={i} className={`text-xs font-mono ${
                    line.includes('✅') ? 'text-green-400'
                    : line.includes('❌') ? 'text-red-400'
                    : line.includes('Done:') ? 'text-blue-400'
                    : 'text-slate-400'
                  }`}>{line}</p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── HISTORY VIEW ───────────────────────────────────────────────── */}
      {view === 'history' && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-500">Last 200 check-in attempts (auto-scheduled + manual)</p>
            <button onClick={loadHistory} className="text-xs text-blue-400 hover:text-blue-300">↻ Refresh</button>
          </div>
          {histLoading ? (
            <p className="text-center py-10 text-slate-500 text-sm animate-pulse">Loading…</p>
          ) : history.length === 0 ? (
            <p className="text-center py-10 text-slate-500 text-sm">No history yet — check-ins will appear here.</p>
          ) : (
            <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
              <div className="divide-y divide-slate-700/40 max-h-[500px] overflow-y-auto">
                {history.map(h => (
                  <div key={h.id} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="text-sm shrink-0">{h.success ? '✅' : '❌'}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-slate-300 truncate">{h.label}</p>
                      {h.tx_hash && (
                        <p className="text-xs text-slate-500 font-mono">{h.tx_hash.slice(0, 20)}…</p>
                      )}
                      {h.error && (
                        <p className="text-xs text-red-400 truncate">{h.error}</p>
                      )}
                    </div>
                    <p className="text-xs text-slate-500 shrink-0 text-right">
                      {fmtTime(h.executed_at)}
                    </p>
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
