import { useState, useEffect } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import type { ExportFormat, ExportCategory } from '../types';

export function ExportTab() {
  const { wallets, setWallets } = useApp();
  const [format, setFormat] = useState<ExportFormat>('csv');
  const [category, setCategory] = useState<ExportCategory>('all');

  useEffect(() => {
    api.getWallets().then(setWallets);
  }, [setWallets]);

  const count = {
    all: wallets.length,
    verified: wallets.filter(w => w.verified).length,
    unverified: wallets.filter(w => !w.verified).length,
  };

  const handleDownload = () => {
    window.location.href = api.exportUrl(format, category);
  };

  return (
    <div className="max-w-xl space-y-4">
      <div className="bg-slate-800 rounded-xl border border-slate-700 p-5 space-y-5">
        <h2 className="text-sm font-semibold text-white">Export Wallet Data</h2>

        <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-3 text-xs text-amber-300">
          ⚠️ <strong>Security notice:</strong> Exported files contain private keys and mnemonic phrases. Store them securely and never share them.
        </div>

        {/* Format */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">Format</label>
          <div className="flex gap-2">
            {(['csv', 'json'] as ExportFormat[]).map(f => (
              <button
                key={f}
                onClick={() => setFormat(f)}
                className={`px-5 py-2 rounded-lg text-sm font-medium transition-colors ${
                  format === f ? 'bg-blue-600 text-white' : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >
                {f.toUpperCase()}
              </button>
            ))}
          </div>
        </div>

        {/* Category */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">Category</label>
          <div className="grid grid-cols-3 gap-2">
            {([
              { id: 'all', label: 'All', desc: `${count.all} wallets` },
              { id: 'verified', label: 'Verified', desc: `${count.verified} wallets` },
              { id: 'unverified', label: 'Unverified', desc: `${count.unverified} wallets` },
            ] as { id: ExportCategory; label: string; desc: string }[]).map(c => (
              <button
                key={c.id}
                onClick={() => setCategory(c.id)}
                className={`text-center px-3 py-3 rounded-lg border transition-colors ${
                  category === c.id
                    ? 'border-blue-500 bg-blue-500/10'
                    : 'border-slate-600 bg-slate-900 hover:border-slate-500'
                }`}
              >
                <p className={`text-sm font-medium ${category === c.id ? 'text-blue-300' : 'text-slate-200'}`}>{c.label}</p>
                <p className="text-xs text-slate-500 mt-0.5">{c.desc}</p>
              </button>
            ))}
          </div>
        </div>

        {/* Columns info */}
        <div className="bg-slate-900 rounded-lg p-3 space-y-1">
          <p className="text-xs font-medium text-slate-400 mb-2">Export includes columns:</p>
          {['label', 'address', 'type', 'mnemonic', 'privateKey', 'verified', 'createdAt'].map(col => (
            <span key={col} className="inline-block mr-2 mb-1 text-xs bg-slate-700 text-slate-300 rounded px-2 py-0.5 font-mono">{col}</span>
          ))}
        </div>

        <button
          onClick={handleDownload}
          disabled={count[category] === 0}
          className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
        >
          📥 Download {count[category]} wallet{count[category] !== 1 ? 's' : ''} as {format.toUpperCase()}
        </button>
      </div>

      {/* Verified breakdown */}
      <div className="bg-slate-800 rounded-xl border border-slate-700 p-5">
        <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Wallet Breakdown</h3>
        <div className="space-y-2">
          {wallets.length === 0 ? (
            <p className="text-sm text-slate-500">No wallets imported yet.</p>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <div className="flex-1 bg-slate-700 rounded-full h-2 overflow-hidden">
                  <div
                    className="h-full bg-green-500 transition-all"
                    style={{ width: wallets.length ? `${(count.verified / wallets.length) * 100}%` : '0%' }}
                  />
                </div>
                <span className="text-xs text-slate-400 w-32 text-right">
                  {count.verified} verified / {count.unverified} unverified
                </span>
              </div>
              <p className="text-xs text-slate-500">
                Wallets become verified after a successful check-in, transfer, or sweep operation.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
