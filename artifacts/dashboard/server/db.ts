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
  console.log('[db] Wallets table ready');
}
