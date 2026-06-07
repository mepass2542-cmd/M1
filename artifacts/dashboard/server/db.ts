import { Pool } from 'pg';

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false },
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      id          TEXT PRIMARY KEY,
      label       TEXT NOT NULL,
      address     TEXT NOT NULL UNIQUE,
      mnemonic    TEXT,
      private_key TEXT,
      verified    BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TEXT NOT NULL,
      type        TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS checkin_log (
      id          BIGSERIAL PRIMARY KEY,
      wallet_id   TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
      executed_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
      success     BOOLEAN NOT NULL,
      tx_hash     TEXT,
      error       TEXT
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS checkin_log_wallet_date_idx
    ON checkin_log (wallet_id, executed_at DESC)
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS topup_config (
      id                 INT PRIMARY KEY DEFAULT 1,
      enabled            BOOLEAN NOT NULL DEFAULT FALSE,
      master_wallet_id   TEXT REFERENCES wallets(id) ON DELETE SET NULL,
      threshold_umec     INT NOT NULL DEFAULT 25000,
      topup_amount_umec  INT NOT NULL DEFAULT 100000,
      run_before_checkin BOOLEAN NOT NULL DEFAULT TRUE
    )
  `);
  await pool.query(`INSERT INTO topup_config (id) VALUES (1) ON CONFLICT DO NOTHING`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS topup_log (
      id             BIGSERIAL PRIMARY KEY,
      wallet_id      TEXT NOT NULL,
      wallet_label   TEXT NOT NULL,
      executed_at    TIMESTAMPTZ NOT NULL DEFAULT (NOW() AT TIME ZONE 'UTC'),
      success        BOOLEAN NOT NULL,
      tx_hash        TEXT,
      error          TEXT,
      amount_umec    INT NOT NULL,
      balance_before INT NOT NULL DEFAULT 0
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS topup_log_executed_idx ON topup_log (executed_at DESC)
  `);

  console.log('[db] Tables ready (wallets + checkin_log + topup_config + topup_log)');
}
