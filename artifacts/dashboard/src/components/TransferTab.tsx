import { useState, useEffect } from 'react';
import { api } from '../api';
import { useApp } from '../App';
import type { TxResult } from '../types';

function fmtUmec(n: number) {
  return (n / 1_000_000).toFixed(6) + ' MEC';
}

export function TransferTab() {
  const { wallets, setWallets, balances, setBalance } = useApp();
  const [fromId, setFromId] = useState('');
  const [to, setTo] = useState('');
  const [chain, setChain] = useState<'hub' | 'rollup'>('hub');
  const [amount, setAmount] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<TxResult | null>(null);

  useEffect(() => {
    api.getWallets().then(ws => {
      setWallets(ws);
      if (ws.length > 0 && !fromId) setFromId(ws[0].id);
    });
  }, [setWallets]);

  const fromWallet = wallets.find(w => w.id === fromId);
  const fromBalance = fromId ? balances[fromId] : null;

  const loadBalance = async () => {
    if (!fromId) return;
    const b = await api.getBalance(fromId);
    setBalance(fromId, b);
  };

  useEffect(() => {
    if (fromId) loadBalance();
  }, [fromId]);

  const setMax = () => {
    if (!fromBalance) return;
    const raw = chain === 'hub'
      ? Math.max(0, fromBalance.hub - 24000)
      : fromBalance.rollupTotal;
    setAmount(String(raw));
  };

  const handleSend = async () => {
    if (!fromId || !to || !amount) return;
    const amountUmec = parseInt(amount, 10);
    if (!amountUmec || amountUmec <= 0) return;

    setSending(true);
    setResult(null);
    try {
      const r = await api.transfer({ fromId, to, chain, amountUmec });
      setResult(r);
      if (r.success) {
        loadBalance();
      }
    } catch (e: any) {
      setResult({ success: false, error: e.message });
    } finally {
      setSending(false);
    }
  };

  const isValid = fromId && to.trim() && parseInt(amount) > 0;

  return (
    <div className="max-w-xl space-y-4">
      <div className="bg-slate-800 rounded-xl border border-slate-700 p-5 space-y-5">
        <h2 className="text-sm font-semibold text-white">Manual P2P Transfer</h2>

        {/* From */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">From Wallet</label>
          <select
            value={fromId}
            onChange={e => setFromId(e.target.value)}
            className="w-full bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 focus:outline-none focus:border-blue-500"
          >
            <option value="">Select wallet…</option>
            {wallets.map(w => (
              <option key={w.id} value={w.id}>{w.label} — {w.address.slice(0, 14)}…</option>
            ))}
          </select>
          {fromBalance && fromWallet && (
            <div className="flex gap-4 text-xs text-slate-400 mt-1">
              <span>Hub: <span className="text-emerald-400 font-mono">{fmtUmec(fromBalance.hub)}</span></span>
              <span>Rollup: <span className="text-purple-400 font-mono">{fmtUmec(fromBalance.rollupTotal)}</span></span>
            </div>
          )}
        </div>

        {/* Chain */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">Chain</label>
          <div className="flex gap-2">
            {(['hub', 'rollup'] as const).map(c => (
              <button
                key={c}
                onClick={() => setChain(c)}
                className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
                  chain === c
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-700 text-slate-300 hover:bg-slate-600'
                }`}
              >
                {c === 'hub' ? '🔵 ME-Hub' : '🟣 Rollup'}
              </button>
            ))}
          </div>
          <p className="text-xs text-slate-500">
            {chain === 'hub'
              ? 'Sends umec on me-hub. Fee: 12,000 umec.'
              : 'Sends tokens on the rollup chain (zero fee).'}
          </p>
        </div>

        {/* To */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">To Address</label>
          <div className="flex gap-2">
            <input
              value={to}
              onChange={e => setTo(e.target.value)}
              placeholder="me1…"
              className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 font-mono focus:outline-none focus:border-blue-500 placeholder:text-slate-600"
            />
            <select
              onChange={e => { if (e.target.value) setTo(wallets.find(w => w.id === e.target.value)?.address ?? ''); }}
              className="bg-slate-900 border border-slate-600 rounded-lg px-2 py-2 text-xs text-slate-300 focus:outline-none focus:border-blue-500"
              defaultValue=""
            >
              <option value="">My wallets</option>
              {wallets.filter(w => w.id !== fromId).map(w => (
                <option key={w.id} value={w.id}>{w.label}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Amount */}
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-slate-400 uppercase tracking-wider">Amount (umec)</label>
          <div className="flex gap-2">
            <input
              type="number"
              value={amount}
              onChange={e => setAmount(e.target.value)}
              placeholder="0"
              min={0}
              className="flex-1 bg-slate-900 border border-slate-600 rounded-lg px-3 py-2 text-sm text-slate-200 font-mono focus:outline-none focus:border-blue-500 placeholder:text-slate-600"
            />
            <button
              onClick={setMax}
              className="px-3 py-2 bg-slate-700 hover:bg-slate-600 text-xs text-slate-300 rounded-lg transition-colors"
            >
              Max
            </button>
          </div>
          {amount && parseInt(amount) > 0 && (
            <p className="text-xs text-slate-500">= {fmtUmec(parseInt(amount))}</p>
          )}
        </div>

        <button
          onClick={handleSend}
          disabled={sending || !isValid}
          className="w-full py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors"
        >
          {sending ? '⏳ Sending…' : '💸 Send Transaction'}
        </button>

        {result && (
          <div className={`rounded-lg p-3 text-sm ${result.success ? 'bg-green-500/10 border border-green-500/30 text-green-300' : 'bg-red-500/10 border border-red-500/30 text-red-300'}`}>
            {result.success ? (
              <>
                <p className="font-semibold">✅ Transaction Sent!</p>
                <p className="text-xs font-mono mt-1 break-all">TX: {result.txHash}</p>
              </>
            ) : (
              <>
                <p className="font-semibold">❌ Transfer Failed</p>
                <p className="text-xs mt-1 break-all">{result.error}</p>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
