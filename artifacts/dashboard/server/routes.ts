import { Router, Request, Response } from 'express';
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

router.get('/wallets', async (_req, res) => {
  try {
    const wallets = (await getWallets()).map(w => ({
      id: w.id,
      label: w.label,
      address: w.address,
      type: w.type,
      verified: w.verified,
      createdAt: w.createdAt,
      hasCredentials: !!(w.mnemonic || w.privateKey),
    }));
    res.json(wallets);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Failed to load wallets' });
  }
});

// Import — body is plain text (parsed globally by express.text)
router.post('/wallets/import', async (req, res) => {
  try {
    let raw: string;
    if (typeof req.body === 'string') {
      raw = req.body;
    } else if (req.body && typeof (req.body as any).text === 'string') {
      raw = (req.body as any).text;
    } else {
      raw = '';
    }

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
});

router.delete('/wallets/:id', async (req, res) => {
  try {
    const removed = await removeWallet(req.params.id);
    res.json({ removed });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Delete failed' });
  }
});

router.patch('/wallets/:id', async (req, res) => {
  try {
    const { label } = req.body as { label: string };
    if (label) await updateWalletLabel(req.params.id, label);
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Update failed' });
  }
});

// ─── Balances ─────────────────────────────────────────────────────────────────

router.get('/wallets/:id/balance', async (req, res) => {
  try {
    const wallet = await getWallet(req.params.id);
    if (!wallet) return res.status(404).json({ error: 'Wallet not found' });
    const balances = await getAllBalances(wallet.address, NETWORK);
    res.json(balances);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Balance fetch failed' });
  }
});

router.post('/balances', async (req, res) => {
  try {
    const { ids } = req.body as { ids?: string[] };
    const wallets = (await getWallets()).filter(w => !ids || ids.includes(w.id));
    const results = await Promise.all(
      wallets.map(async w => ({
        id: w.id,
        address: w.address,
        balances: await getAllBalances(w.address, NETWORK),
      }))
    );
    res.json(results);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Balances fetch failed' });
  }
});

// ─── Check-In ────────────────────────────────────────────────────────────────

router.post('/checkin', async (req, res) => {
  try {
    const { ids } = req.body as { ids: string[] };
    if (!ids?.length) return res.status(400).json({ error: 'ids required' });

    const results = [];
    for (const id of ids) {
      const wallet = await getWallet(id);
      if (!wallet) { results.push({ id, success: false, error: 'Wallet not found' }); continue; }
      const r = await performCheckin(wallet, NETWORK);
      if (r.success) await markVerified(id);
      results.push({ id, address: wallet.address, label: wallet.label, ...r });
    }
    res.json(results);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Check-in failed' });
  }
});

// ─── Transfer ────────────────────────────────────────────────────────────────

router.post('/transfer', async (req, res) => {
  try {
    const { fromId, to, chain, amountUmec, denom } = req.body as {
      fromId: string;
      to: string;
      chain: 'hub' | 'rollup';
      amountUmec: number;
      denom?: string;
    };
    const wallet = await getWallet(fromId);
    if (!wallet) return res.status(404).json({ error: 'Source wallet not found' });

    let result;
    if (chain === 'hub') {
      result = await hubSend(wallet, to, amountUmec);
    } else {
      const d = denom ?? 'ibc/BC7F4D581D88785A22824C8FB6807DFC3B65C1764AFF1230D954AAB06B70CBC5';
      result = await rollupSendAmount(wallet, to, d, amountUmec, NETWORK);
    }
    if (result.success) await markVerified(fromId);
    res.json(result);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Transfer failed' });
  }
});

// ─── Auto-Sweep ───────────────────────────────────────────────────────────────

router.post('/sweep', async (req, res) => {
  try {
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
      const wallet = await getWallet(id);
      if (!wallet) { results.push({ id, steps: [{ step: 'Load Wallet', success: false, error: 'Not found' }] }); continue; }
      const steps = await autoSweep(wallet, mode, destination, reserve, NETWORK);
      if (steps.some(s => s.success)) await markVerified(id);
      results.push({ id, address: wallet.address, label: wallet.label, steps });
    }
    res.json(results);
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Sweep failed' });
  }
});

// ─── Export ───────────────────────────────────────────────────────────────────

router.get('/export', async (req, res) => {
  try {
    const { format = 'csv', category = 'all' } = req.query as {
      format: 'csv' | 'json';
      category: 'all' | 'verified' | 'unverified';
    };

    let wallets = await getWallets();
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
  } catch (e: any) {
    res.status(500).json({ error: e?.message ?? 'Export failed' });
  }
});
