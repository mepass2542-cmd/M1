import { useState, useEffect, useCallback } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import type { Wallet } from '../types';

function fmtUmec(n: number) {
  if (n === 0) return '0';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(3) + ' MEC';
  return (n / 1_000_000).toFixed(6) + ' MEC';
}

function shortAddr(a: string) {
  return a.slice(0, 10) + '…' + a.slice(-6);
}

export function WalletsTab() {
  const { wallets, setWallets, balances, setBalance } = useApp();
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');
  const [showImport, setShowImport] = useState(false);
  const [importResult, setImportResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null);
  const [loadingBalances, setLoadingBalances] = useState(false);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const loadWallets = useCallback(async () => {
    const ws = await api.getWallets();
    setWallets(ws);
  }, [setWallets]);

  useEffect(() => { loadWallets(); }, [loadWallets]);

  const refreshAllBalances = async () => {
    setLoadingBalances(true);
    try {
      const entries = await api.getBalances();
      entries.forEach(e => setBalance(e.id, e.balances));
    } finally {
      setLoadingBalances(false);
    }
  };

  const refreshOne = async (id: string) => {
    setRefreshingId(id);
    try {
      const b = await api.getBalance(id);
      setBalance(id, b);
    } finally {
      setRefreshingId(null);
    }
  };

  const handleImport = async () => {
    if (!importText.trim()) return;
    setImporting(true);
    setImportResult(null);
    try {
      const r = await api.importWallets(importText);
      setImportResult(r);
      if (r.imported > 0) await loadWallets();
    } finally {
      setImporting(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Remove this wallet from the dashboard?')) return;
    await api.deleteWallet(id);
    await loadWallets();
  };

  const copyAddr = (addr: string) => {
    navigator.clipboard.writeText(addr);
    setCopied(addr);
    setTimeout(() => setCopied(null), 1500);
  };

  const totalHub = wallets.reduce((s, w) => s + (balances[w.id]?.hub ?? 0), 0);
  const totalRollup = wallets.reduce((s, w) => s + (balances[w.id]?.rollupTotal ?? 0), 0);
  const totalStaking = wallets.reduce((s, w) => s + (balances[w.id]?.staking ?? 0), 0);

  return (
    <div className="space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {[
          { label: 'Total Wallets', value: wallets.length, color: 'text-blue-400' },
          { label: 'Hub Balance', value: fmtUmec(totalHub), color: 'text-emerald-400' },
          { label: 'Rollup Balance', value: fmtUmec(totalRollup), color: 'text-purple-400' },
          { label: 'Staking Rewards', value: fmtUmec(totalStaking), color: 'text-amber-400' },
        ].map(s => (
          <div key={s.label} className="bg-slate-800 rounded-lg p-4 border border-slate-700">
            <p className="text-xs text-slate-400 mb-1">{s.label}</p>
            <p className={`text-lg font-bold ${s.color}`}>{s.value}</p>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => { setShowImport(true); setImportResult(null); setImportText(''); }}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
        >
          + Import Wallets
        </button>
        <button
          onClick={refreshAllBalances}
          disabled={loadingBalances || wallets.length === 0}
          className="px-4 py-2 bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-white rounded-lg text-sm font-medium transition-colors"
        >
          {loadingBalances ? '⏳ Refreshing…' : '⟳ Refresh All Balances'}
        </button>
      </div>

      {/* Wallet Table */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 bg-slate-900/50">
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">#</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">Label</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">Address</th>
                <th className="text-left px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">Type</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">Hub</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">Rollup</th>
                <th className="text-right px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">Staking</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">Status</th>
                <th className="text-center px-4 py-3 text-xs font-medium text-slate-400 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody>
              {wallets.length === 0 && (
                <tr>
                  <td colSpan={9} className="text-center py-12 text-slate-500">
                    No wallets yet — click <strong className="text-slate-300">Import Wallets</strong> to add some.
                  </td>
                </tr>
              )}
              {wallets.map((w, i) => {
                const b = balances[w.id];
                return (
                  <tr key={w.id} className="border-b border-slate-700/50 hover:bg-slate-700/30 transition-colors">
                    <td className="px-4 py-3 text-slate-500 text-xs">{i + 1}</td>
                    <td className="px-4 py-3 font-medium text-slate-200">{w.label}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => copyAddr(w.address)}
                        className="font-mono text-xs text-slate-300 hover:text-blue-400 transition-colors"
                        title={w.address}
                      >
                        {copied === w.address ? '✓ Copied!' : shortAddr(w.address)}
                      </button>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${w.type === 'mnemonic' ? 'bg-blue-500/20 text-blue-300' : 'bg-orange-500/20 text-orange-300'}`}>
                        {w.type === 'mnemonic' ? 'Mnemonic' : 'Private Key'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-emerald-400">
                      {b ? fmtUmec(b.hub) : <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-purple-400">
                      {b ? fmtUmec(b.rollupTotal) : <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-amber-400">
                      {b ? fmtUmec(b.staking) : <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-xs px-2 py-0.5 rounded-full ${w.verified ? 'bg-green-500/20 text-green-300' : 'bg-slate-600/50 text-slate-400'}`}>
                        {w.verified ? 'Verified' : 'Unverified'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex items-center justify-center gap-1">
                        <button
                          onClick={() => refreshOne(w.id)}
                          disabled={refreshingId === w.id}
                          className="p-1.5 rounded text-slate-400 hover:text-blue-400 hover:bg-blue-400/10 transition-colors disabled:opacity-40"
                          title="Refresh balance"
                        >
                          {refreshingId === w.id ? '⏳' : '⟳'}
                        </button>
                        <button
                          onClick={() => handleDelete(w.id)}
                          className="p-1.5 rounded text-slate-400 hover:text-red-400 hover:bg-red-400/10 transition-colors"
                          title="Remove wallet"
                        >
                          ✕
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* Import Modal */}
      {showImport && (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
          <div className="bg-slate-800 rounded-xl border border-slate-700 w-full max-w-2xl shadow-2xl">
            <div className="flex items-center justify-between p-5 border-b border-slate-700">
              <h2 className="text-base font-semibold text-white">Import Wallets</h2>
              <button onClick={() => setShowImport(false)} className="text-slate-400 hover:text-white transition-colors">✕</button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-sm text-slate-400">
                Paste one entry per line. Supports <strong className="text-slate-200">12/24-word mnemonics</strong> and <strong className="text-slate-200">64-character hex private keys</strong> (with or without 0x prefix). Duplicates are skipped automatically.
              </p>
              <textarea
                value={importText}
                onChange={e => setImportText(e.target.value)}
                rows={10}
                placeholder={"word1 word2 word3 ... word12\nword1 word2 ... word24\n0xabcdef1234...64chars\nabcdef1234...64chars"}
                className="w-full bg-slate-900 text-slate-200 text-sm font-mono rounded-lg border border-slate-600 p-3 resize-none focus:outline-none focus:border-blue-500 placeholder:text-slate-600"
              />
              {importResult && (
                <div className={`rounded-lg p-3 text-sm ${importResult.imported > 0 ? 'bg-green-500/10 border border-green-500/30 text-green-300' : 'bg-amber-500/10 border border-amber-500/30 text-amber-300'}`}>
                  ✓ Imported <strong>{importResult.imported}</strong> wallet(s), skipped <strong>{importResult.skipped}</strong>.
                  {importResult.errors.length > 0 && (
                    <ul className="mt-1 text-xs text-red-300 list-disc list-inside">
                      {importResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                    </ul>
                  )}
                </div>
              )}
              <div className="flex gap-2 justify-end">
                <button onClick={() => setShowImport(false)} className="px-4 py-2 text-sm rounded-lg bg-slate-700 hover:bg-slate-600 text-slate-200 transition-colors">
                  Close
                </button>
                <button
                  onClick={handleImport}
                  disabled={importing || !importText.trim()}
                  className="px-4 py-2 text-sm rounded-lg bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-medium transition-colors"
                >
                  {importing ? 'Importing…' : 'Import'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
