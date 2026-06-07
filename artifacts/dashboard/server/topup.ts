import { pool } from './db';
import { getWallets, getWallet } from './store';
import { getHubBalance, getRollupBalances, hubSend, ibcTransferToRollup, ROLLUP_IBC_DENOM, Coin } from './blockchain';

export interface TopupConfig {
  enabled: boolean;
  masterWalletId: string | null;
  thresholdUmec: number;
  topupAmountUmec: number;
  runBeforeCheckin: boolean;
  ibcEnabled: boolean;
  ibcThresholdUmec: number;
  ibcAmountUmec: number;
}

export interface TopupResult {
  walletId: string;
  label: string;
  address: string;
  balanceBefore: number;
  success: boolean;
  txHash?: string;
  error?: string;
  skipped?: boolean;
  ibcBalanceBefore?: number;
  ibcSuccess?: boolean;
  ibcTxHash?: string;
  ibcError?: string;
  ibcSkipped?: boolean;
}

export interface TopupRunSummary {
  results: TopupResult[];
  toppedUp: number;
  skipped: number;
  failed: number;
  ibcSent: number;
  ibcSkipped: number;
  ibcFailed: number;
  masterBalanceBefore: number;
  masterBalanceAfter: number;
  masterLabel: string;
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
      ibcEnabled: false,
      ibcThresholdUmec: 5000,
      ibcAmountUmec: 50000,
    };
  }
  const r = rows[0];
  return {
    enabled: r.enabled,
    masterWalletId: r.master_wallet_id ?? null,
    thresholdUmec: r.threshold_umec,
    topupAmountUmec: r.topup_amount_umec,
    runBeforeCheckin: r.run_before_checkin,
    ibcEnabled: r.ibc_enabled ?? false,
    ibcThresholdUmec: r.ibc_threshold_umec ?? 5000,
    ibcAmountUmec: r.ibc_amount_umec ?? 50000,
  };
}

export async function setTopupConfig(cfg: Partial<TopupConfig>): Promise<TopupConfig> {
  const current = await getTopupConfig();
  const next: TopupConfig = { ...current, ...cfg };
  await pool.query(
    `INSERT INTO topup_config
       (id, enabled, master_wallet_id, threshold_umec, topup_amount_umec, run_before_checkin,
        ibc_enabled, ibc_threshold_umec, ibc_amount_umec)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (id) DO UPDATE SET
       enabled            = EXCLUDED.enabled,
       master_wallet_id   = EXCLUDED.master_wallet_id,
       threshold_umec     = EXCLUDED.threshold_umec,
       topup_amount_umec  = EXCLUDED.topup_amount_umec,
       run_before_checkin = EXCLUDED.run_before_checkin,
       ibc_enabled        = EXCLUDED.ibc_enabled,
       ibc_threshold_umec = EXCLUDED.ibc_threshold_umec,
       ibc_amount_umec    = EXCLUDED.ibc_amount_umec`,
    [next.enabled, next.masterWalletId, next.thresholdUmec, next.topupAmountUmec,
     next.runBeforeCheckin, next.ibcEnabled, next.ibcThresholdUmec, next.ibcAmountUmec]
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
  error?: string,
  txType: 'hub' | 'ibc' = 'hub'
) {
  await pool.query(
    `INSERT INTO topup_log
       (wallet_id, wallet_label, executed_at, success, tx_hash, error, amount_umec, balance_before, tx_type)
     VALUES ($1, $2, NOW() AT TIME ZONE 'UTC', $3, $4, $5, $6, $7, $8)`,
    [walletId, walletLabel, success, txHash ?? null, error ?? null, amountUmec, balanceBefore, txType]
  );
}

export async function getTopupHistory(limit = 100) {
  const { rows } = await pool.query(
    `SELECT * FROM topup_log ORDER BY executed_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

// ── Run state — tracks current & last run for polling ─────────────────────────

export interface TopupRunState {
  isRunning: boolean;
  startedAt: string | null;
  lastRunAt: string | null;
  lastSummary: TopupRunSummary | null;
  lastError: string | null;
}

let _topupRunState: TopupRunState = {
  isRunning: false,
  startedAt: null,
  lastRunAt: null,
  lastSummary: null,
  lastError: null,
};

export function getTopupRunState(): TopupRunState { return _topupRunState; }
export function isTopupRunning() { return _topupRunState.isRunning; }

// ── Top-up run ────────────────────────────────────────────────────────────────

export async function runTopup(source = 'manual'): Promise<TopupRunSummary> {
  const cfg = await getTopupConfig();

  if (!cfg.enabled) {
    const empty: TopupRunSummary = { results: [], toppedUp: 0, skipped: 0, failed: 0,
      ibcSent: 0, ibcSkipped: 0, ibcFailed: 0,
      masterBalanceBefore: 0, masterBalanceAfter: 0, masterLabel: '' };
    _topupRunState = { ..._topupRunState, lastSummary: empty, lastError: null };
    return empty;
  }
  if (!cfg.masterWalletId) {
    throw new Error('No master wallet configured');
  }
  if (_topupRunState.isRunning) {
    console.log('[topup] Already running — skipping concurrent request');
    const skippedSummary: TopupRunSummary = { results: [], toppedUp: 0, skipped: 0, failed: 0,
      ibcSent: 0, ibcSkipped: 0, ibcFailed: 0,
      masterBalanceBefore: 0, masterBalanceAfter: 0, masterLabel: '(skipped — already running)' };
    return skippedSummary;
  }

  const masterWallet = await getWallet(cfg.masterWalletId);
  if (!masterWallet) throw new Error('Master wallet not found');

  _topupRunState = { isRunning: true, startedAt: new Date().toISOString(),
    lastRunAt: _topupRunState.lastRunAt, lastSummary: _topupRunState.lastSummary, lastError: null };
  try {
    const allWallets = await getWallets();
    const targets = allWallets.filter(w => w.id !== cfg.masterWalletId);

    console.log(`[topup] ${source}: scanning ${targets.length} wallets in parallel…`);

    // ── Parallel balance scan (hub + rollup ibc) ──────────────────────────────
    const masterBalancePromise = getHubBalance(masterWallet.address);
    const hubBalMap    = new Map<string, number>();
    const ibcBalMap    = new Map<string, number>();

    await Promise.all(
      targets.map(async w => {
        const [hubBal, rollupCoins] = await Promise.all([
          getHubBalance(w.address),
          cfg.ibcEnabled ? getRollupBalances(w.address).catch(() => [] as Coin[]) : Promise.resolve([] as Coin[]),
        ]);
        hubBalMap.set(w.id, hubBal);
        const ibcCoin = rollupCoins.find(c => c.denom === ROLLUP_IBC_DENOM);
        ibcBalMap.set(w.id, ibcCoin?.amount ?? 0);
      })
    );
    const masterBalanceBefore = await masterBalancePromise;
    console.log(`[topup] Master (${masterWallet.label}) hub balance: ${masterBalanceBefore} umec`);

    const hubNeedsTopup = targets.filter(w => (hubBalMap.get(w.id) ?? 0) < cfg.thresholdUmec);
    const hubAlreadyOk  = targets.filter(w => (hubBalMap.get(w.id) ?? 0) >= cfg.thresholdUmec);
    const ibcNeedsTopup = cfg.ibcEnabled
      ? targets.filter(w => (ibcBalMap.get(w.id) ?? 0) < cfg.ibcThresholdUmec)
      : [];

    console.log(`[topup] Hub: ${hubNeedsTopup.length} need top-up, ${hubAlreadyOk.length} OK`);
    if (cfg.ibcEnabled) {
      console.log(`[topup] IBC: ${ibcNeedsTopup.length} need rollup funding`);
    }

    // Build result map keyed by walletId
    const resultMap = new Map<string, TopupResult>();
    for (const w of targets) {
      resultMap.set(w.id, {
        walletId: w.id, label: w.label, address: w.address,
        balanceBefore: hubBalMap.get(w.id) ?? 0,
        success: true, skipped: true,
        ibcBalanceBefore: ibcBalMap.get(w.id) ?? 0,
        ibcSkipped: true, ibcSuccess: true,
      });
    }

    const SEND_FEE = 12000; // hub fee per send
    let masterRunningBalance = masterBalanceBefore;

    // ── Phase 1: Hub top-up (sequential, same master wallet) ─────────────────
    for (const wallet of hubNeedsTopup) {
      const balance = hubBalMap.get(wallet.id) ?? 0;
      const needed  = cfg.topupAmountUmec + SEND_FEE;

      if (masterRunningBalance < needed) {
        const err = `Master insufficient: ${masterRunningBalance} umec < ${needed} needed`;
        console.log(`[topup] ❌ Hub ${wallet.label}: ${err}`);
        resultMap.set(wallet.id, {
          ...resultMap.get(wallet.id)!,
          balanceBefore: balance, success: false, skipped: false, error: err,
        });
        continue;
      }

      console.log(`[topup] Hub → ${wallet.label}: ${cfg.topupAmountUmec} umec (had ${balance})`);
      const tx = await hubSend(masterWallet, wallet.address, cfg.topupAmountUmec);

      if (tx.success) {
        masterRunningBalance -= cfg.topupAmountUmec + SEND_FEE;
        console.log(`[topup] ✅ Hub ${wallet.label}: ${tx.txHash?.slice(0, 12)}`);
      } else {
        console.log(`[topup] ❌ Hub ${wallet.label}: ${tx.error}`);
      }

      try { await logTopup(wallet.id, wallet.label, cfg.topupAmountUmec, balance, tx.success, tx.txHash, tx.error, 'hub'); }
      catch { /* ignore log failure */ }

      resultMap.set(wallet.id, {
        ...resultMap.get(wallet.id)!,
        balanceBefore: balance, success: tx.success, skipped: false,
        txHash: tx.txHash, error: tx.error,
      });

      await new Promise(r => setTimeout(r, 600));
    }

    // ── Phase 2: IBC top-up — fund rollup accounts ────────────────────────────
    if (cfg.ibcEnabled && ibcNeedsTopup.length > 0) {
      console.log(`[topup] IBC phase: sending ${cfg.ibcAmountUmec} umec via IBC to ${ibcNeedsTopup.length} wallets`);

      for (const wallet of ibcNeedsTopup) {
        const ibcBal = ibcBalMap.get(wallet.id) ?? 0;
        const needed = cfg.ibcAmountUmec + SEND_FEE;

        if (masterRunningBalance < needed) {
          const err = `Master insufficient for IBC: ${masterRunningBalance} umec < ${needed} needed`;
          console.log(`[topup] ❌ IBC ${wallet.label}: ${err}`);
          resultMap.set(wallet.id, {
            ...resultMap.get(wallet.id)!,
            ibcBalanceBefore: ibcBal, ibcSuccess: false, ibcSkipped: false, ibcError: err,
          });
          continue;
        }

        console.log(`[topup] IBC → ${wallet.label}: ${cfg.ibcAmountUmec} umec (rollup had ${ibcBal})`);
        const tx = await ibcTransferToRollup(masterWallet, wallet.address, cfg.ibcAmountUmec);

        if (tx.success) {
          masterRunningBalance -= cfg.ibcAmountUmec + SEND_FEE;
          console.log(`[topup] ✅ IBC ${wallet.label}: ${tx.txHash?.slice(0, 12)}`);
        } else {
          console.log(`[topup] ❌ IBC ${wallet.label}: ${tx.error}`);
        }

        try { await logTopup(wallet.id, wallet.label, cfg.ibcAmountUmec, ibcBal, tx.success, tx.txHash, tx.error, 'ibc'); }
        catch { /* ignore log failure */ }

        resultMap.set(wallet.id, {
          ...resultMap.get(wallet.id)!,
          ibcBalanceBefore: ibcBal, ibcSuccess: tx.success, ibcSkipped: false,
          ibcTxHash: tx.txHash, ibcError: tx.error,
        });

        await new Promise(r => setTimeout(r, 800));
      }
    }

    const masterBalanceAfter = await getHubBalance(masterWallet.address);
    const results = [...resultMap.values()];

    const toppedUp   = results.filter(r => !r.skipped && r.success).length;
    const skipped    = results.filter(r => r.skipped).length;
    const failed     = results.filter(r => !r.skipped && !r.success).length;
    const ibcSent    = results.filter(r => !r.ibcSkipped && r.ibcSuccess).length;
    const ibcSkipped = results.filter(r => r.ibcSkipped).length;
    const ibcFailed  = results.filter(r => !r.ibcSkipped && !r.ibcSuccess).length;

    const summary: TopupRunSummary = { results, toppedUp, skipped, failed,
      ibcSent, ibcSkipped, ibcFailed,
      masterBalanceBefore, masterBalanceAfter, masterLabel: masterWallet.label };
    console.log(`[topup] Done — hub: ${toppedUp} sent, ${skipped} OK, ${failed} failed | ibc: ${ibcSent} sent, ${ibcSkipped} OK, ${ibcFailed} failed`);
    _topupRunState = { isRunning: false, startedAt: null,
      lastRunAt: new Date().toISOString(), lastSummary: summary, lastError: null };
    return summary;
  } catch (err: any) {
    _topupRunState = { isRunning: false, startedAt: null,
      lastRunAt: new Date().toISOString(), lastSummary: null,
      lastError: err?.message ?? String(err) };
    throw err;
  }
}
