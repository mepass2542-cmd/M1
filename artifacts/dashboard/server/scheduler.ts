import cron from 'node-cron';
import { pool } from './db';
import { getWallets, getWallet } from './store';
import { performCheckin } from './blockchain';
import { getTopupConfig, runTopup } from './topup';

const NETWORK   = process.env.NETWORK ?? 'mainnet';
const CRON_EXPR = process.env.CRON_SCHEDULE ?? '0 9 * * *';
const MAX_RETRIES    = 3;
const RETRY_DELAY_MS = 2 * 60 * 1000; // 2 min between retries per wallet
const WATCHDOG_MS    = 5 * 60 * 1000; // check every 5 min for missed wallets

// ── In-memory state ──────────────────────────────────────────────────────────

export interface RunResult {
  walletId: string;
  label: string;
  success: boolean;
  txHash?: string;
  error?: string;
}

let _isRunning    = false;
let _lastRunAt:   Date | null = null;
let _nextRunAt:   Date | null = null;
let _lastResults: RunResult[] = [];

export function getSchedulerState() {
  return {
    cronExpr:    CRON_EXPR,
    lastRunAt:   _lastRunAt?.toISOString() ?? null,
    nextRunAt:   _nextRunAt?.toISOString() ?? null,
    isRunning:   _isRunning,
    lastResults: _lastResults,
  };
}

// ── Next-run calculator (handles * and specific values) ───────────────────────

function matchesPart(val: number, part: string): boolean {
  if (part === '*') return true;
  // handle lists: "1,2,3"
  if (part.includes(',')) return part.split(',').some(p => matchesPart(val, p.trim()));
  // handle ranges: "1-5"
  if (part.includes('-')) {
    const [lo, hi] = part.split('-').map(Number);
    return val >= lo && val <= hi;
  }
  // handle step: "*/5"
  if (part.startsWith('*/')) {
    const step = parseInt(part.slice(2), 10);
    return step > 0 && val % step === 0;
  }
  return parseInt(part, 10) === val;
}

export function computeNextCronRun(expr: string): Date | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minPart, hourPart, domPart, monthPart, dowPart] = parts;

  // Scan minute-by-minute from next minute, up to 8 days
  const start = new Date(Date.now() + 60_000);
  start.setUTCSeconds(0, 0);

  for (let i = 0; i < 8 * 24 * 60; i++) {
    const t = new Date(start.getTime() + i * 60_000);
    if (
      matchesPart(t.getUTCMinutes(), minPart) &&
      matchesPart(t.getUTCHours(),   hourPart) &&
      matchesPart(t.getUTCDate(),    domPart) &&
      matchesPart(t.getUTCMonth() + 1, monthPart) &&
      matchesPart(t.getUTCDay(),     dowPart)
    ) {
      t.setUTCSeconds(0, 0);
      return t;
    }
  }
  return null;
}

function refreshNextRunAt() {
  _nextRunAt = computeNextCronRun(CRON_EXPR);
}

// ── DB helpers ───────────────────────────────────────────────────────────────

export async function logCheckin(
  walletId: string,
  success: boolean,
  txHash?: string,
  error?: string
) {
  await pool.query(
    `INSERT INTO checkin_log (wallet_id, executed_at, success, tx_hash, error)
     VALUES ($1, NOW() AT TIME ZONE 'UTC', $2, $3, $4)`,
    [walletId, success, txHash ?? null, error ?? null]
  );
}

export async function getCheckinHistory(limit = 100) {
  const { rows } = await pool.query(
    `SELECT cl.id, cl.wallet_id, cl.executed_at, cl.success, cl.tx_hash, cl.error,
            w.label, w.address
     FROM checkin_log cl
     JOIN wallets w ON w.id = cl.wallet_id
     ORDER BY cl.executed_at DESC
     LIMIT $1`,
    [limit]
  );
  return rows;
}

export async function getAllWalletStats() {
  const { rows } = await pool.query(`
    WITH success_days AS (
      SELECT wallet_id, DATE(executed_at AT TIME ZONE 'UTC') AS day
      FROM checkin_log WHERE success = TRUE
    ),
    uniq_days AS (
      SELECT DISTINCT wallet_id, day FROM success_days
    ),
    ranked AS (
      SELECT wallet_id, day,
             (ROW_NUMBER() OVER (PARTITION BY wallet_id ORDER BY day DESC) - 1)::int AS gap
      FROM uniq_days
    ),
    streaks AS (
      SELECT wallet_id, COUNT(*)::int AS streak
      FROM ranked
      WHERE day = CURRENT_DATE - gap
      GROUP BY wallet_id
    ),
    last_ok AS (
      SELECT wallet_id, MAX(executed_at) AS last_success_at
      FROM checkin_log WHERE success = TRUE
      GROUP BY wallet_id
    ),
    today_ok AS (
      SELECT DISTINCT wallet_id
      FROM checkin_log
      WHERE success = TRUE AND DATE(executed_at AT TIME ZONE 'UTC') = CURRENT_DATE
    )
    SELECT w.id AS wallet_id,
           w.label,
           w.address,
           COALESCE(s.streak, 0) AS streak,
           lo.last_success_at,
           (tok.wallet_id IS NOT NULL) AS checked_in_today
    FROM wallets w
    LEFT JOIN streaks   s   ON s.wallet_id   = w.id
    LEFT JOIN last_ok   lo  ON lo.wallet_id  = w.id
    LEFT JOIN today_ok  tok ON tok.wallet_id = w.id
    ORDER BY w.created_at
  `);
  return rows;
}

async function walletsMissingToday(): Promise<string[]> {
  const { rows } = await pool.query(`
    SELECT w.id FROM wallets w
    WHERE NOT EXISTS (
      SELECT 1 FROM checkin_log cl
      WHERE cl.wallet_id = w.id
        AND cl.success = TRUE
        AND DATE(cl.executed_at AT TIME ZONE 'UTC') = CURRENT_DATE
    )
  `);
  return rows.map((r: any) => r.id);
}

// ── Core run logic ───────────────────────────────────────────────────────────

export async function runAllCheckins(source = 'cron'): Promise<RunResult[]> {
  if (_isRunning) {
    console.log('[scheduler] Already running — skipping');
    return _lastResults;
  }
  return _runCheckins(await getWallets(), source);
}

/**
 * Check in a specific subset of wallets by ID.
 * Used when new wallets are added — only checks in wallets that haven't
 * checked in today so already-done wallets aren't double-checked.
 */
/**
 * Fire-and-forget: run check-in for a specific set of wallet objects (already loaded).
 * Used by the manual check-in route. Client polls /api/checkin/schedule for progress.
 */
export async function runCheckinForIds(wallets: any[]): Promise<void> {
  if (_isRunning) {
    console.log('[scheduler] Already running — skipping manual check-in request');
    return;
  }
  await _runCheckins(wallets, 'manual');
}

export async function runCheckinForNewWallets(walletIds: string[]): Promise<void> {
  if (!walletIds.length) return;
  if (_isRunning) {
    console.log('[scheduler] Already running — new wallets will be picked up by watchdog');
    return;
  }

  // Filter to only wallets that haven't checked in today
  const missed = await walletsMissingToday();
  const toRun  = walletIds.filter(id => missed.includes(id));
  if (!toRun.length) {
    console.log('[scheduler] New wallets already checked in today ✓');
    return;
  }

  const wallets = await Promise.all(toRun.map(id => getWallet(id)));
  const valid   = wallets.filter(Boolean) as Awaited<ReturnType<typeof getWallet>>[];
  if (!valid.length) return;

  console.log(`[scheduler] New wallet(s) added — checking in ${valid.length} now`);
  await _runCheckins(valid as any, 'new-wallet');
}

async function _runCheckins(wallets: any[], source: string): Promise<RunResult[]> {
  _isRunning   = true;
  _lastRunAt   = new Date();
  _lastResults = [];
  refreshNextRunAt();

  try {
    if (wallets.length === 0) {
      console.log('[scheduler] No wallets — nothing to do');
      return [];
    }

    // ── Pre-flight top-up ─────────────────────────────────────────────────
    try {
      const topupCfg = await getTopupConfig();
      if (topupCfg.enabled && topupCfg.masterWalletId && topupCfg.runBeforeCheckin) {
        console.log('[scheduler] Running auto top-up before check-ins…');
        const summary = await runTopup('pre-checkin');
        if (summary.toppedUp > 0) {
          console.log(`[scheduler] Top-up: ${summary.toppedUp} topped up, ${summary.skipped} OK, ${summary.failed} failed`);
        } else {
          console.log(`[scheduler] Top-up: all ${summary.skipped} wallets already have sufficient balance`);
        }
      }
    } catch (topupErr: any) {
      console.error('[scheduler] Top-up pre-flight error (continuing):', topupErr?.message);
    }

    console.log(`[scheduler] ${source}: checking in ${wallets.length} wallet(s)`);

    for (const wallet of wallets) {
      let success   = false;
      let txHash: string | undefined;
      let lastError: string | undefined;

      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        const result = await performCheckin(wallet, NETWORK);
        if (result.success) {
          success = true;
          txHash  = result.txHash;
          break;
        }
        lastError = result.error ?? result.note ?? 'failed';
        if (result.permanent) {
          console.log(`[scheduler] ${wallet.label}: ⚠️ permanent error — ${lastError}`);
          break;
        }
        console.log(`[scheduler] ${wallet.label} attempt ${attempt}/${MAX_RETRIES}: ${lastError}`);
        if (attempt < MAX_RETRIES) await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      }

      try {
        await logCheckin(wallet.id, success, txHash, success ? undefined : lastError);
      } catch (dbErr: any) {
        console.error('[scheduler] DB log error:', dbErr?.message);
      }

      const entry: RunResult = { walletId: wallet.id, label: wallet.label, success, txHash, error: lastError };
      _lastResults.push(entry);
      console.log(`[scheduler] ${wallet.label}: ${success ? '✅ ' + (txHash?.slice(0, 12) ?? '') : '❌ ' + lastError}`);

      await new Promise(r => setTimeout(r, 800));
    }

    const ok = _lastResults.filter(r => r.success).length;
    console.log(`[scheduler] Done: ${ok}/${wallets.length} succeeded`);
    return _lastResults;
  } finally {
    _isRunning = false;
    refreshNextRunAt();
  }
}

// ── Watchdog — runs every 5 min, catches any missed wallets ──────────────────

function startWatchdog() {
  setInterval(async () => {
    if (_isRunning) return;
    try {
      const missed = await walletsMissingToday();
      if (missed.length === 0) return;
      console.log(`[scheduler] Watchdog: ${missed.length} wallet(s) haven't checked in today — running now`);
      await runAllCheckins('watchdog');
    } catch (e: any) {
      console.error('[scheduler] Watchdog error:', e?.message);
    }
  }, WATCHDOG_MS);
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function startScheduler() {
  const expr = cron.validate(CRON_EXPR) ? CRON_EXPR : '0 9 * * *';
  refreshNextRunAt();
  console.log(`[scheduler] Daily check-in cron: ${expr} UTC`);
  if (_nextRunAt) console.log(`[scheduler] Next scheduled run: ${_nextRunAt.toISOString()}`);

  // On startup: run immediately if any wallet has not checked in today
  setTimeout(async () => {
    try {
      const missed = await walletsMissingToday();
      if (missed.length > 0) {
        console.log(`[scheduler] Wallets missing today's check-in — running now to protect streak`);
        await runAllCheckins('startup');
      } else {
        console.log('[scheduler] All wallets checked in today ✓ — next run per schedule');
      }
    } catch (e) {
      console.error('[scheduler] Startup check error:', e);
    }
  }, 3000);

  // Daily cron
  cron.schedule(expr, () => {
    console.log('[scheduler] Cron fired');
    refreshNextRunAt();
    runAllCheckins('cron').catch(e => console.error('[scheduler] Cron error:', e));
  }, { timezone: 'UTC' });

  // Watchdog: every 5 min, pick up any wallets that missed check-in
  startWatchdog();
}
