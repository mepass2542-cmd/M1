import express, { Router, Request, Response } from 'express';
import {
  getWallets,
  getWallet,
  removeWallet,
  updateWalletLabel,
  markVerified,
  parseBulkImport,
  StoredWallet,
} from './store';
import {
  getAllBalances,
  performCheckin,
  hubSend,
  rollupSendAll,
  rollupSendAmount,
  withdrawStakingRewards,
  autoSweep,
  SweepMode,
} from './blockchain';

export const router = Router();

const NETWORK = process.env.NETWORK ?? 'mainnet';

// ─── Wallet CRUD ──────────────────────────────────────────────────────────────

router.get('/wallets', (_req, res) => {
  const wallets = getWallets().map(w => ({
    id: w.id,
    label: w.label,
    address: w.address,
    type: w.type,
    verified: w.verified,
    createdAt: w.createdAt,
    hasCredentials: !!(w.mnemonic || w.privateKey),
  }));
  res.json(wallets);
});

// Import uses text/plain body to avoid JSON control-character parse errors
router.post(
  '/wallets/import',
  express.text({ type: ['text/plain', 'application/json', '*/*'], limit: '10mb' }),
  async (req, res) => {
    try {
      // req.body is the raw string (express.text) or an already-parsed object (express.json fallback)
      let raw: string;
      if (typeof req.body === 'string') {
        raw = req.body;
        // If the client sent JSON-wrapped text, unwrap it
        if (raw.trimStart().startsWith('{')) {
          try {
            const parsed = JSON.parse(raw.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F]/g, ''));
            raw = typeof parsed.text === 'string' ? parsed.text : raw;
          } catch { /* treat as raw mnemonic text */ }
        }
      } else if (req.body && typeof (req.body as any).text === 'string') {
        raw = (req.body as any).text;
      } else {
        raw = '';
      }

      // Strip all control characters except \n (normalise \r\n → \n)
      const text = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

      if (!text) {
        return res.status(400).json({ error: 'Paste at least one mnemonic or private key' });
      }
      const result = await parseBulkImport(text);
      res.json(result);
    } catch (e: any) {
      console.error('[import] Unexpected error:', e);
      res.status(500).json({ error: e?.message ?? 'Import failed' });
    }
  }
);

router.delete('/wallets/:id', (req, res) => {
  const removed = removeWallet(req.params.id);
  res.json({ removed });
});

router.patch('/wallets/:id', (req, res) => {
  const { label } = req.body as { label: string };
  if (label) updateWalletLabel(req.params.id, label);
  res.json({ ok: true });
});

// ─── Balances ─────────────────────────────────────────────────────────────────

router.get('/wallets/:id/balance', async (req, res) => {
  const wallet = getWallet(req.params.id);
  if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
  const balances = await getAllBalances(wallet.address, NETWORK);
  res.json(balances);
});

router.post('/balances', async (req, res) => {
  const { ids } = req.body as { ids?: string[] };
  const wallets = getWallets().filter(w => !ids || ids.includes(w.id));
  const results = await Promise.all(
    wallets.map(async w => ({
      id: w.id,
      address: w.address,
      balances: await getAllBalances(w.address, NETWORK),
    }))
  );
  res.json(results);
});

// ─── Check-In ────────────────────────────────────────────────────────────────

router.post('/checkin', async (req, res) => {
  const { ids } = req.body as { ids: string[] };
  if (!ids?.length) return res.status(400).json({ error: 'ids required' });

  const results = [];
  for (const id of ids) {
    const wallet = getWallet(id);
    if (!wallet) { results.push({ id, success: false, error: 'Wallet not found' }); continue; }
    const r = await performCheckin(wallet, NETWORK);
    if (r.success) markVerified(id);
    results.push({ id, address: wallet.address, label: wallet.label, ...r });
  }
  res.json(results);
});

// ─── Transfer ────────────────────────────────────────────────────────────────

router.post('/transfer', async (req, res) => {
  const { fromId, to, chain, amountUmec, denom } = req.body as {
    fromId: string;
    to: string;
    chain: 'hub' | 'rollup';
    amountUmec: number;
    denom?: string;
  };
  const wallet = getWallet(fromId);
  if (!wallet) return res.status(404).json({ error: 'Source wallet not found' });

  let result;
  if (chain === 'hub') {
    result = await hubSend(wallet, to, amountUmec);
  } else {
    const d = denom ?? 'ibc/BC7F4D581D88785A22824C8FB6807DFC3B65C1764AFF1230D954AAB06B70CBC5';
    result = await rollupSendAmount(wallet, to, d, amountUmec, NETWORK);
  }
  if (result.success) markVerified(fromId);
  res.json(result);
});

// ─── Auto-Sweep ───────────────────────────────────────────────────────────────

router.post('/sweep', async (req, res) => {
  const { ids, mode, destination, minHubReserve } = req.body as {
    ids: string[];
    mode: SweepMode;
    destination: string;
    minHubReserve: number;
  };
  if (!ids?.length) return res.status(400).json({ error: 'ids required' });
  if (!destination) return res.status(400).json({ error: 'destination required' });

  const reserve = minHubReserve ?? 50000;
  const results = [];
  for (const id of ids) {
    const wallet = getWallet(id);
    if (!wallet) { results.push({ id, steps: [{ step: 'Load Wallet', success: false, error: 'Not found' }] }); continue; }
    const steps = await autoSweep(wallet, mode, destination, reserve, NETWORK);
    if (steps.some(s => s.success)) markVerified(id);
    results.push({ id, address: wallet.address, label: wallet.label, steps });
  }
  res.json(results);
});

// ─── Export ───────────────────────────────────────────────────────────────────

router.get('/export', (req, res) => {
  const { format = 'csv', category = 'all' } = req.query as {
    format: 'csv' | 'json';
    category: 'all' | 'verified' | 'unverified';
  };

  let wallets = getWallets();
  if (category === 'verified') wallets = wallets.filter(w => w.verified);
  if (category === 'unverified') wallets = wallets.filter(w => !w.verified);

  const rows = wallets.map(w => ({
    label: w.label,
    address: w.address,
    type: w.type,
    mnemonic: w.mnemonic ?? '',
    privateKey: w.privateKey ?? '',
    verified: w.verified,
    createdAt: w.createdAt,
  }));

  if (format === 'json') {
    res.setHeader('Content-Disposition', `attachment; filename="wallets-${category}-${Date.now()}.json"`);
    res.setHeader('Content-Type', 'application/json');
    return res.send(JSON.stringify(rows, null, 2));
  }

  const headers = ['label', 'address', 'type', 'mnemonic', 'privateKey', 'verified', 'createdAt'];
  const csvRows = [
    headers.join(','),
    ...rows.map(r =>
      headers.map(h => {
        const v = String((r as any)[h] ?? '');
        return v.includes(',') || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v;
      }).join(',')
    ),
  ];
  res.setHeader('Content-Disposition', `attachment; filename="wallets-${category}-${Date.now()}.csv"`);
  res.setHeader('Content-Type', 'text/csv');
  res.send(csvRows.join('\n'));
});
