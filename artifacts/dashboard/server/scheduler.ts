import cron from 'node-cron';
import { pool } from './db';
import { getWallets } from './store';
import { performCheckin } from './blockchain';
import { getTopupConfig, runTopup } from './topup';

const NETWORK  = process.env.NETWORK ?? 'mainnet';
const CRON_EXPR = process.env.CRON_SCHEDULE ?? '0 9 * * *';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2 * 60 * 1000; // 2 min between retries per wallet

// ── In-memory state ──────────────────────────────────────────────────────────

export interface RunResult {
  walletId: string;
  label: string;
  success: boolean;
  txHash?: string;
  error?: string;
}

let _isRunning   = false;
let _lastRunAt:  Date | null = null;
let _lastResults: RunResult[] = [];

export function getSchedulerState() {
  return {
    cronExpr: CRON_EXPR,
    lastRunAt: _lastRunAt?.toISOString() ?? null,
    isRunning: _isRunning,
    lastResults: _lastResults,
  };
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

async function walletsMissingToday(): Promise<boolean> {
  const { rows } = await pool.query(`
    SELECT w.id FROM wallets w
    WHERE NOT EXISTS (
      SELECT 1 FROM checkin_log cl
      WHERE cl.wallet_id = w.id
        AND cl.success = TRUE
        AND DATE(cl.executed_at AT TIME ZONE 'UTC') = CURRENT_DATE
    )
    LIMIT 1
  `);
  return rows.length > 0;
}

// ── Core run logic ───────────────────────────────────────────────────────────

export async function runAllCheckins(source = 'cron'): Promise<RunResult[]> {
  if (_isRunning) {
    console.log('[scheduler] Already running — skipping');
    return _lastResults;
  }

  _isRunning  = true;
  _lastRunAt  = new Date();
  _lastResults = [];

  try {
    const wallets = await getWallets();
    if (wallets.length === 0) {
      console.log('[scheduler] No wallets in DB — nothing to do');
      return [];
    }

    // ── Pre-flight: top up low-balance wallets before check-ins ──────────
    try {
      const topupCfg = await getTopupConfig();
      if (topupCfg.enabled && topupCfg.masterWalletId && topupCfg.runBeforeCheckin) {
        console.log(`[scheduler] Running auto top-up before check-ins…`);
        const summary = await runTopup('pre-checkin');
        if (summary.toppedUp > 0) {
          console.log(`[scheduler] Top-up done: ${summary.toppedUp} wallets topped up, ${summary.skipped} already OK, ${summary.failed} failed`);
        } else {
          console.log(`[scheduler] Top-up: all ${summary.skipped} wallets already have sufficient balance`);
        }
      }
    } catch (topupErr: any) {
      console.error('[scheduler] Top-up pre-flight error (continuing with check-ins):', topupErr?.message);
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
        console.log(`[scheduler] ${wallet.label} attempt ${attempt}/${MAX_RETRIES}: ${lastError}`);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        }
      }

      try {
        await logCheckin(wallet.id, success, txHash, success ? undefined : lastError);
      } catch (dbErr: any) {
        console.error('[scheduler] Failed to log check-in:', dbErr?.message);
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
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────

export function startScheduler() {
  const expr = cron.validate(CRON_EXPR) ? CRON_EXPR : '0 9 * * *';
  console.log(`[scheduler] Daily check-in cron: ${expr} UTC`);

  // On startup: run immediately if any wallet has not checked in today
  setTimeout(() => {
    walletsMissingToday()
      .then(missed => {
        if (missed) {
          console.log('[scheduler] Wallets missing today\'s check-in — running now to protect streak');
          return runAllCheckins('startup');
        }
        console.log('[scheduler] All wallets checked in today ✓ — next run per schedule');
      })
      .catch(e => console.error('[scheduler] Startup check error:', e));
  }, 3000); // 3-second delay so DB is fully ready

  cron.schedule(expr, () => {
    console.log('[scheduler] Cron fired');
    runAllCheckins('cron').catch(e => console.error('[scheduler] Cron error:', e));
  }, { timezone: 'UTC' });
}
