import { pool } from './db';
import { getWallets, getWallet } from './store';
import { getHubBalance, hubSend } from './blockchain';

export interface TopupConfig {
  enabled: boolean;
  masterWalletId: string | null;
  thresholdUmec: number;
  topupAmountUmec: number;
  runBeforeCheckin: boolean;
}

export interface TopupResult {
  walletId: string;
  label: string;
  address: string;
  balanceBefore: number;
  success: boolean;
  txHash?: string;
  error?: string;
  skipped?: boolean;   // balance was already above threshold
  isMaster?: boolean;  // this is the master wallet, skip it
}

// ── Config ───────────────────────────────────────────────────────────────────

export async function getTopupConfig(): Promise<TopupConfig> {
  const { rows } = await pool.query(`SELECT * FROM topup_config WHERE id = 1`);
  if (rows.length === 0) {
    return {
      enabled: false,
      masterWalletId: null,
      thresholdUmec: 25000,
      topupAmountUmec: 100000,
      runBeforeCheckin: true,
    };
  }
  const r = rows[0];
  return {
    enabled: r.enabled,
    masterWalletId: r.master_wallet_id ?? null,
    thresholdUmec: r.threshold_umec,
    topupAmountUmec: r.topup_amount_umec,
    runBeforeCheckin: r.run_before_checkin,
  };
}

export async function setTopupConfig(cfg: Partial<TopupConfig>): Promise<TopupConfig> {
  const current = await getTopupConfig();
  const next: TopupConfig = { ...current, ...cfg };
  await pool.query(
    `INSERT INTO topup_config (id, enabled, master_wallet_id, threshold_umec, topup_amount_umec, run_before_checkin)
     VALUES (1, $1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE SET
       enabled            = EXCLUDED.enabled,
       master_wallet_id   = EXCLUDED.master_wallet_id,
       threshold_umec     = EXCLUDED.threshold_umec,
       topup_amount_umec  = EXCLUDED.topup_amount_umec,
       run_before_checkin = EXCLUDED.run_before_checkin`,
    [next.enabled, next.masterWalletId, next.thresholdUmec, next.topupAmountUmec, next.runBeforeCheckin]
  );
  return next;
}

// ── Log ───────────────────────────────────────────────────────────────────────

async function logTopup(
  walletId: string,
  walletLabel: string,
  amountUmec: number,
  balanceBefore: number,
  success: boolean,
  txHash?: string,
  error?: string
) {
  await pool.query(
    `INSERT INTO topup_log
       (wallet_id, wallet_label, executed_at, success, tx_hash, error, amount_umec, balance_before)
     VALUES ($1, $2, NOW() AT TIME ZONE 'UTC', $3, $4, $5, $6, $7)`,
    [walletId, walletLabel, success, txHash ?? null, error ?? null, amountUmec, balanceBefore]
  );
}

export async function getTopupHistory(limit = 100) {
  const { rows } = await pool.query(
    `SELECT * FROM topup_log ORDER BY executed_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

// ── Top-up run ────────────────────────────────────────────────────────────────

export interface TopupRunSummary {
  results: TopupResult[];
  toppedUp: number;
  skipped: number;
  failed: number;
  masterBalanceBefore: number;
  masterBalanceAfter: number;
  masterLabel: string;
}

export async function runTopup(source = 'manual'): Promise<TopupRunSummary> {
  const cfg = await getTopupConfig();

  if (!cfg.enabled) {
    return { results: [], toppedUp: 0, skipped: 0, failed: 0,
      masterBalanceBefore: 0, masterBalanceAfter: 0, masterLabel: '' };
  }
  if (!cfg.masterWalletId) {
    throw new Error('No master wallet configured');
  }

  const masterWallet = await getWallet(cfg.masterWalletId);
  if (!masterWallet) throw new Error('Master wallet not found');

  const allWallets = await getWallets();
  const targets = allWallets.filter(w => w.id !== cfg.masterWalletId);

  console.log(`[topup] ${source}: checking ${targets.length} wallets (threshold ${cfg.thresholdUmec} umec)`);

  const masterBalanceBefore = await getHubBalance(masterWallet.address);
  console.log(`[topup] Master wallet (${masterWallet.label}) balance: ${masterBalanceBefore} umec`);

  const results: TopupResult[] = [];
  // Fee cost per send = 12000 umec
  const SEND_FEE = 12000;

  for (const wallet of targets) {
    const balance = await getHubBalance(wallet.address);

    if (balance >= cfg.thresholdUmec) {
      results.push({
        walletId: wallet.id, label: wallet.label, address: wallet.address,
        balanceBefore: balance, success: true, skipped: true,
      });
      continue;
    }

    // Check master has enough to send
    const masterNow = await getHubBalance(masterWallet.address);
    const needed = cfg.topupAmountUmec + SEND_FEE;
    if (masterNow < needed) {
      const err = `Master wallet insufficient: ${masterNow} umec < ${needed} needed`;
      console.log(`[topup] ❌ ${wallet.label}: ${err}`);
      results.push({
        walletId: wallet.id, label: wallet.label, address: wallet.address,
        balanceBefore: balance, success: false, error: err,
      });
      continue;
    }

    console.log(`[topup] Sending ${cfg.topupAmountUmec} umec → ${wallet.label} (had ${balance} umec)`);
    const tx = await hubSend(masterWallet, wallet.address, cfg.topupAmountUmec);

    try {
      await logTopup(wallet.id, wallet.label, cfg.topupAmountUmec, balance, tx.success, tx.txHash, tx.error);
    } catch { /* don't crash on log failure */ }

    results.push({
      walletId: wallet.id, label: wallet.label, address: wallet.address,
      balanceBefore: balance, success: tx.success, txHash: tx.txHash, error: tx.error,
    });

    if (tx.success) {
      console.log(`[topup] ✅ ${wallet.label}: ${tx.txHash?.slice(0, 12)}`);
    } else {
      console.log(`[topup] ❌ ${wallet.label}: ${tx.error}`);
    }

    // Small delay between sends
    await new Promise(r => setTimeout(r, 1000));
  }

  const masterBalanceAfter = await getHubBalance(masterWallet.address);
  const toppedUp = results.filter(r => !r.skipped && r.success).length;
  const skipped  = results.filter(r => r.skipped).length;
  const failed   = results.filter(r => !r.skipped && !r.success).length;

  console.log(`[topup] Done: ${toppedUp} topped-up, ${skipped} already OK, ${failed} failed`);
  return { results, toppedUp, skipped, failed, masterBalanceBefore, masterBalanceAfter, masterLabel: masterWallet.label };
}
