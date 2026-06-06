import { randomUUID } from 'crypto';
import { DirectSecp256k1HdWallet, DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { pool } from './db';

const ADDRESS_PREFIX = 'me';

export interface StoredWallet {
  id: string;
  label: string;
  address: string;
  mnemonic?: string;
  privateKey?: string;
  verified: boolean;
  createdAt: string;
  type: 'mnemonic' | 'privatekey';
}

function rowToWallet(row: any): StoredWallet {
  return {
    id: row.id,
    label: row.label,
    address: row.address,
    mnemonic: row.mnemonic ?? undefined,
    privateKey: row.private_key ?? undefined,
    verified: row.verified,
    createdAt: row.created_at,
    type: row.type as 'mnemonic' | 'privatekey',
  };
}

export async function getWallets(): Promise<StoredWallet[]> {
  const { rows } = await pool.query('SELECT * FROM wallets ORDER BY created_at ASC');
  return rows.map(rowToWallet);
}

export async function getWallet(id: string): Promise<StoredWallet | undefined> {
  const { rows } = await pool.query('SELECT * FROM wallets WHERE id = $1', [id]);
  return rows[0] ? rowToWallet(rows[0]) : undefined;
}

export async function insertWallet(w: StoredWallet): Promise<void> {
  await pool.query(
    `INSERT INTO wallets (id, label, address, mnemonic, private_key, verified, created_at, type)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (address) DO NOTHING`,
    [w.id, w.label, w.address, w.mnemonic ?? null, w.privateKey ?? null, w.verified, w.createdAt, w.type]
  );
}

export async function removeWallet(id: string): Promise<boolean> {
  const { rowCount } = await pool.query('DELETE FROM wallets WHERE id = $1', [id]);
  return (rowCount ?? 0) > 0;
}

export async function updateWalletLabel(id: string, label: string): Promise<void> {
  await pool.query('UPDATE wallets SET label = $1 WHERE id = $2', [label, id]);
}

export async function markVerified(id: string): Promise<void> {
  await pool.query('UPDATE wallets SET verified = TRUE WHERE id = $1', [id]);
}

export async function getWalletCount(): Promise<number> {
  const { rows } = await pool.query('SELECT COUNT(*) AS cnt FROM wallets');
  return parseInt(rows[0].cnt, 10);
}

// Load MNEMONIC env var on startup if set
export async function loadEnvWallet() {
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) return;
  const clean = mnemonic.trim();
  try {
    const hdWallet = await DirectSecp256k1HdWallet.fromMnemonic(clean, { prefix: ADDRESS_PREFIX });
    const [account] = await hdWallet.getAccounts();
    const w: StoredWallet = {
      id: randomUUID(),
      label: 'Primary Wallet',
      address: account.address,
      mnemonic: clean,
      verified: true,
      createdAt: new Date().toISOString(),
      type: 'mnemonic',
    };
    await insertWallet(w);
    console.log(`[store] Auto-imported primary wallet: ${account.address}`);
  } catch { /* invalid mnemonic or already exists */ }
}

export async function parseBulkImport(text: string): Promise<{ imported: number; skipped: number; errors: string[] }> {
  const mnemonics: string[] = [];
  const privateKeys: string[] = [];
  const errors: string[] = [];

  const lines = text.split(/[\n]+/);
  for (const line of lines) {
    const clean = line.trim();
    if (!clean) continue;

    const hexMatch = clean.match(/^(?:0x)?([a-fA-F0-9]{64})$/);
    if (hexMatch) {
      const key = hexMatch[1];
      if (!privateKeys.includes(key)) privateKeys.push(key);
      continue;
    }

    const words = clean.toLowerCase().replace(/\s+/g, ' ').split(' ').filter(w => /^[a-z]+$/.test(w));
    if (words.length === 12 || words.length === 24) {
      const phrase = words.join(' ');
      if (!mnemonics.includes(phrase)) mnemonics.push(phrase);
    }
  }

  let imported = 0;
  let skipped = 0;
  const count = await getWalletCount();
  let walletNum = count;

  for (let i = 0; i < mnemonics.length; i++) {
    try {
      const hdWallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonics[i], { prefix: ADDRESS_PREFIX });
      const [account] = await hdWallet.getAccounts();
      walletNum++;
      const w: StoredWallet = {
        id: randomUUID(),
        label: `Wallet ${walletNum}`,
        address: account.address,
        mnemonic: mnemonics[i],
        verified: false,
        createdAt: new Date().toISOString(),
        type: 'mnemonic',
      };
      await insertWallet(w);
      const existing = await getWallet(w.id);
      if (existing) {
        imported++;
      } else {
        skipped++;
      }
    } catch (e: any) {
      errors.push(`Mnemonic ${i + 1}: ${e?.message ?? 'invalid'}`);
      skipped++;
    }
  }

  for (let i = 0; i < privateKeys.length; i++) {
    try {
      const keyBytes = Buffer.from(privateKeys[i], 'hex');
      const pkWallet = await DirectSecp256k1Wallet.fromKey(new Uint8Array(keyBytes), ADDRESS_PREFIX);
      const [account] = await pkWallet.getAccounts();
      walletNum++;
      const w: StoredWallet = {
        id: randomUUID(),
        label: `Wallet ${walletNum}`,
        address: account.address,
        privateKey: privateKeys[i],
        verified: false,
        createdAt: new Date().toISOString(),
        type: 'privatekey',
      };
      await insertWallet(w);
      const existing = await getWallet(w.id);
      if (existing) {
        imported++;
      } else {
        skipped++;
      }
    } catch (e: any) {
      errors.push(`Key ${i + 1}: ${e?.message ?? 'invalid'}`);
      skipped++;
    }
  }

  return { imported, skipped, errors };
}
