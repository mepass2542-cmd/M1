import { useState, useEffect } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import type { CheckInResult } from '../types';

function shortAddr(a: string) {
  return a.slice(0, 10) + '…' + a.slice(-6);
}

export function CheckInTab() {
  const { wallets, setWallets } = useApp();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<CheckInResult[]>([]);
  const [log, setLog] = useState<string[]>([]);

  useEffect(() => {
    api.getWallets().then(setWallets);
  }, [setWallets]);

  const toggleAll = () => {
    if (selected.size === wallets.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(wallets.map(w => w.id)));
    }
  };

  const toggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const runCheckin = async () => {
    if (selected.size === 0) return;
    setRunning(true);
    setResults([]);
    setLog([`[${new Date().toLocaleTimeString()}] Starting check-in for ${selected.size} wallet(s)…`]);

    try {
      const ids = [...selected];
      const res = await api.checkin(ids);
      setResults(res);
      res.forEach(r => {
        const line = r.success
          ? `✅ ${r.label} (${shortAddr(r.address)}) — TX: ${r.txHash}`
          : `❌ ${r.label} (${shortAddr(r.address)}) — ${r.error}`;
        setLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ${line}`]);
      });
      const ok = res.filter(r => r.success).length;
      setLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] Done: ${ok}/${res.length} succeeded.`]);
    } catch (e: any) {
      setLog(prev => [...prev, `[${new Date().toLocaleTimeString()}] ❌ Error: ${e.message}`]);
    } finally {
      setRunning(false);
    }
  };

  const allSelected = wallets.length > 0 && selected.size === wallets.length;
  const succeeded = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;

  return (
    <div className="space-y-4 max-w-3xl">
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-700">
          <h2 className="text-sm font-semibold text-white">Select Wallets</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={toggleAll}
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors"
            >
              {allSelected ? 'Deselect All' : 'Select All'} ({wallets.length})
            </button>
          </div>
        </div>

        {wallets.length === 0 ? (
          <p className="text-center py-10 text-slate-500 text-sm">No wallets imported yet.</p>
        ) : (
          <div className="divide-y divide-slate-700/50 max-h-96 overflow-y-auto">
            {wallets.map(w => {
              const r = results.find(r => r.id === w.id);
              return (
                <label key={w.id} className="flex items-center gap-3 px-5 py-3 hover:bg-slate-700/30 cursor-pointer transition-colors">
                  <input
                    type="checkbox"
                    checked={selected.has(w.id)}
                    onChange={() => toggle(w.id)}
                    className="rounded border-slate-600 bg-slate-700 text-blue-500 focus:ring-blue-500"
                  />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-200">{w.label}</p>
                    <p className="text-xs text-slate-500 font-mono">{w.address}</p>
                  </div>
                  {r && (
                    <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${r.success ? 'bg-green-500/20 text-green-300' : 'bg-red-500/20 text-red-300'}`}>
                      {r.success ? `✓ ${r.txHash?.slice(0, 8)}…` : '✕ Failed'}
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        )}

        <div className="px-5 py-4 border-t border-slate-700 flex items-center gap-3">
          <button
            onClick={runCheckin}
            disabled={running || selected.size === 0}
            className="px-5 py-2 bg-green-600 hover:bg-green-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {running ? '⏳ Running…' : `▶ Run Check-In (${selected.size})`}
          </button>
          {results.length > 0 && (
            <span className="text-xs text-slate-400">
              {succeeded} succeeded · {failed} failed
            </span>
          )}
        </div>
      </div>

      {/* Log */}
      {log.length > 0 && (
        <div className="bg-slate-900 rounded-xl border border-slate-700 p-4">
          <p className="text-xs font-semibold text-slate-400 mb-2 uppercase tracking-wider">Activity Log</p>
          <div className="space-y-1 max-h-64 overflow-y-auto">
            {log.map((line, i) => (
              <p key={i} className={`text-xs font-mono ${line.includes('✅') ? 'text-green-400' : line.includes('❌') ? 'text-red-400' : 'text-slate-400'}`}>
                {line}
              </p>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
