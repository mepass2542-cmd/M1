import { useState, useEffect } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import type { SweepWalletResult, SweepMode } from '../types';

const UMEC_PER_MEC = 1_000_000;

const MODES: { id: SweepMode; label: string; desc: string }[] = [
  { id: 'all', label: '🔄 All-Inclusive', desc: 'Withdraw staking rewards → sweep hub balance (minus reserve) → sweep rollup tokens.' },
  { id: 'hub', label: '🔵 Hub Only', desc: 'Send hub MEC to destination, keeping min reserve for fees.' },
  { id: 'rollup', label: '🟣 Rollup Only', desc: 'Send all rollup tokens to destination address (zero fee).' },
  { id: 'staking', label: '🏆 Staking Only', desc: 'Withdraw delegation rewards from hub validators.' },
];

function shortAddr(a: string) {
  return a ? a.slice(0, 10) + '…' + a.slice(-6) : '';
}

function mecToUmec(mec: string): number {
  const v = parseFloat(mec);
  return isNaN(v) ? 0 : Math.floor(v * UMEC_PER_MEC);
}

export function SweepTab() {
  const { wallets, setWallets } = useApp();
  const [mode, setMode] = useState<SweepMode>('all');
  const [destination, setDestination] = useState('');
  const [minReserveMec, setMinReserveMec] = useState('0.05'); // 50,000 umec default
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<SweepWalletResult[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.getWallets().then(ws => {
      setWallets(ws);
      setSelected(new Set(ws.map(w => w.id)));
    }).catch(() => {});
  }, [setWallets]);

  const allSelected = wallets.length > 0 && selected.size === wallets.length;

  const toggleWallet = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(wallets.map(w => w.id)));
    }
  };

  const needsDestination = mode !== 'staking';

  const runSweep = async () => {
    setError(null);
    if (needsDestination && !destination.trim()) { setError('Enter a destination address.'); return; }
    if (selected.size === 0) { setError('Select at least one wallet.'); return; }
    const minReserveUmec = mecToUmec(minReserveMec);
    const confirmMsg = mode === 'staking'
      ? `Withdraw staking rewards for ${selected.size} wallet(s)?`
      : `Run ${mode === 'all' ? 'all-inclusive' : mode + '-only'} sweep for ${selected.size} wallet(s)?\n\nDestination: ${shortAddr(destination)}\nMin reserve: ${minReserveMec} MEC`;
    if (!confirm(confirmMsg)) return;

    setRunning(true);
    setResults([]);
    try {
      const r = await api.sweep({
        ids: [...selected],
        mode,
        destination: destination.trim(),
        minHubReserve: minReserveUmec,
      });
      setResults(r);
    } catch (e: any) {
      setError('Sweep error: ' + e.message);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4 max-w-3xl">
      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg px-4 py-3 text-sm text-red-300 flex items-center gap-2">
          <span>⚠️ {error}</span>
          <button onClick={() => setError(null)} className="ml-auto">✕</button>
        </div>
      )}

      {/* Config Panel */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 p-5 space-y-5">
        <h2 className="text-sm font-semibold text-white">Auto-Sweeper Configuration</h2>

        {/* Mode */}
        <div className="space-y-2">
          <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">Sweep Mode</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {MODES.map(m => (
              <button
                key={m.id}
                onClick={() => setMode(m.id)}
                className={`text-left px-4 py-3 rounded-lg border transition-colors ${
                  mode === m.id
                    ? 'border-blue-500 bg-blue-500/10'
                    : 'border-slate-600 bg-slate-900 hover:border-slate-500'
                }`}
              >
                <p className={`text-sm font-medium ${mode === m.id ? 'text-blue-300' : 'text-slate-200'}`}>{m.label}</p>
                <p className="text-xs text-slate-500 mt-0.5">{m.desc}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Destination */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
            Destination Address{!needsDestination && <span className="ml-2 text-amber-400 normal-case font-normal">(not required for Staking-Only)</span>}
          </label>
          <div className="flex gap-2">
            <input
              value={destination}
              onChange={e => setDestination(e.target.value)}
              placeholder="me1… (master/consolidation address)"
              className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 font-mono focus:outline-none focus:border-blue-500 placeholder:text-slate-600"
            />
            <select
              onChange={e => { if (e.target.value) setDestination(wallets.find(w => w.id === e.target.value)?.address ?? ''); }}
              className="bg-slate-900 border border-slate-600 rounded-lg px-2 py-2 text-xs text-slate-300 focus:outline-none focus:border-blue-500"
              defaultValue=""
            >
              <option value="">My wallets</option>
              {wallets.map(w => (
                <option key={w.id} value={w.id}>{w.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Min Reserve */}
        {(mode === 'all' || mode === 'hub') && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">
              Min Hub Reserve (MEC)
            </label>
            <input
              type="number"
              value={minReserveMec}
              onChange={e => setMinReserveMec(e.target.value)}
              min={0.012}
              step={0.001}
              className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 font-mono focus:outline-none focus:border-blue-500"
            />
            <p className="text-xs text-slate-500">
              MEC kept on hub for future fees. ≈{mecToUmec(minReserveMec).toLocaleString()} umec.
              Default 0.05 MEC covers ~4 hub transactions.
            </p>
          </div>
        )}
      </div>

      {/* Wallet Selection */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-700">
          <span className="text-xs font-medium text-slate-400 uppercase tracking-wider">
            Wallets to Sweep ({selected.size}/{wallets.length})
          </span>
          <button onClick={toggleSelectAll} className="text-xs text-blue-400 hover:text-blue-300 transition-colors">
            {allSelected ? 'Deselect All' : 'Select All'}
          </button>
        </div>
        <div className="divide-y divide-slate-700/50 max-h-48 overflow-y-auto">
          {wallets.map(w => (
            <label key={w.id} className="flex items-center gap-3 px-5 py-2.5 hover:bg-slate-700/30 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.has(w.id)}
                onChange={() => toggleWallet(w.id)}
                className="rounded border-slate-600 bg-slate-700 text-blue-500"
              />
              <span className="text-sm text-slate-200 flex-1">{w.label}</span>
              <span className="text-xs text-slate-500 font-mono">{shortAddr(w.address)}</span>
            </label>
          ))}
          {wallets.length === 0 && (
            <p className="text-center py-6 text-slate-500 text-sm">No wallets imported yet.</p>
          )}
        </div>
      </div>

      <button
        onClick={runSweep}
        disabled={running || selected.size === 0 || (needsDestination && !destination.trim())}
        className="w-full py-3 bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
      >
        {running ? '⏳ Sweeping — this may take a minute…' : `🔄 Run ${MODES.find(m => m.id === mode)?.label ?? 'Sweep'} (${selected.size} wallet${selected.size !== 1 ? 's' : ''})`}
      </button>

      {/* Results */}
      {results.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Sweep Results</p>
          {results.map(r => (
            <div key={r.id} className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
              <div className="px-4 py-3 bg-slate-900/50 border-b border-slate-700 flex items-center gap-2">
                <span className="text-sm font-medium text-slate-200">{r.label}</span>
                <span className="text-xs text-slate-500 font-mono">{shortAddr(r.address)}</span>
                <span className={`ml-auto text-xs px-2 py-0.5 rounded-full ${r.steps.some(s => s.success) ? 'bg-green-500/20 text-green-300' : 'bg-red-500/20 text-red-300'}`}>
                  {r.steps.filter(s => s.success).length}/{r.steps.length} steps OK
                </span>
              </div>
              <div className="divide-y divide-slate-700/30">
                {r.steps.map((s, i) => (
                  <div key={i} className="px-4 py-2.5 flex items-start gap-2">
                    <span className="text-sm mt-0.5 shrink-0">{s.success ? '✅' : s.note ? '⚠️' : '❌'}</span>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-medium text-slate-300">{s.step}</p>
                      {s.txHash && <p className="text-xs text-slate-500 font-mono mt-0.5 break-all">TX: {s.txHash}</p>}
                      {s.error && <p className="text-xs text-red-400 mt-0.5">{s.error}</p>}
                      {s.note && <p className="text-xs text-amber-400 mt-0.5">{s.note}</p>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
