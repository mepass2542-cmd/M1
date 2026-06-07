import { randomUUID } from 'crypto';
import { DirectSecp256k1HdWallet, DirectSecp256k1Wallet } from '@cosmjs/proto-signing';
import { pool } from './db';
import { getFirestoreDb } from './auth';

const ADDRESS_PREFIX = 'me';
const COLLECTION = 'wallets';

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

// ── Firestore helpers ─────────────────────────────────────────────────────────

function docToWallet(id: string, data: FirebaseFirestore.DocumentData): StoredWallet {
  return {
    id,
    label:      data.label,
    address:    data.address,
    mnemonic:   data.mnemonic   ?? undefined,
    privateKey: data.privateKey ?? undefined,
    verified:   data.verified   ?? false,
    createdAt:  data.createdAt,
    type:       data.type as 'mnemonic' | 'privatekey',
  };
}

function walletToDoc(w: StoredWallet): Record<string, any> {
  const doc: Record<string, any> = {
    label:     w.label,
    address:   w.address,
    verified:  w.verified,
    createdAt: w.createdAt,
    type:      w.type,
  };
  if (w.mnemonic)   doc.mnemonic   = w.mnemonic;
  if (w.privateKey) doc.privateKey = w.privateKey;
  return doc;
}

// ── PostgreSQL sync helper (no credentials — only for FK integrity) ───────────

async function pgUpsertWallet(w: StoredWallet): Promise<void> {
  await pool.query(
    `INSERT INTO wallets (id, label, address, mnemonic, private_key, verified, created_at, type)
     VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6)
     ON CONFLICT (id)   DO UPDATE SET label = $2, verified = $4
     ON CONFLICT (address) DO NOTHING`,
    [w.id, w.label, w.address, w.verified, w.createdAt, w.type]
  ).catch(() => {
    // Fallback: try upsert by address (address unique constraint)
    return pool.query(
      `INSERT INTO wallets (id, label, address, mnemonic, private_key, verified, created_at, type)
       VALUES ($1, $2, $3, NULL, NULL, $4, $5, $6)
       ON CONFLICT (address) DO UPDATE SET label = $2, verified = $4`,
      [w.id, w.label, w.address, w.verified, w.createdAt, w.type]
    );
  });
}

// ── CRUD ──────────────────────────────────────────────────────────────────────

export async function getWallets(): Promise<StoredWallet[]> {
  const db      = getFirestoreDb();
  const snap    = await db.collection(COLLECTION).orderBy('createdAt', 'asc').get();
  return snap.docs.map(d => docToWallet(d.id, d.data()));
}

export async function getWallet(id: string): Promise<StoredWallet | undefined> {
  const db  = getFirestoreDb();
  const doc = await db.collection(COLLECTION).doc(id).get();
  if (!doc.exists) return undefined;
  return docToWallet(doc.id, doc.data()!);
}

/**
 * Returns true if newly inserted, false if address already exists (skipped).
 */
export async function insertWallet(w: StoredWallet): Promise<boolean> {
  const db = getFirestoreDb();

  // Dedup: check if address already exists in Firestore
  const existing = await db.collection(COLLECTION)
    .where('address', '==', w.address)
    .limit(1)
    .get();

  if (!existing.empty) return false; // already exists

  await db.collection(COLLECTION).doc(w.id).set(walletToDoc(w));

  // Sync to PostgreSQL (no credentials) for FK integrity in checkin_log / topup tables
  try { await pgUpsertWallet(w); } catch { /* non-fatal */ }

  return true;
}

export async function removeWallet(id: string): Promise<boolean> {
  const db  = getFirestoreDb();
  const doc = await db.collection(COLLECTION).doc(id).get();
  if (!doc.exists) return false;

  await db.collection(COLLECTION).doc(id).delete();

  // Remove from PostgreSQL too
  try { await pool.query('DELETE FROM wallets WHERE id = $1', [id]); } catch { /* non-fatal */ }

  return true;
}

export async function updateWalletLabel(id: string, label: string): Promise<void> {
  const db = getFirestoreDb();
  await db.collection(COLLECTION).doc(id).update({ label });
  try { await pool.query('UPDATE wallets SET label = $1 WHERE id = $2', [label, id]); } catch { }
}

export async function markVerified(id: string): Promise<void> {
  const db = getFirestoreDb();
  await db.collection(COLLECTION).doc(id).update({ verified: true });
  try { await pool.query('UPDATE wallets SET verified = TRUE WHERE id = $1', [id]); } catch { }
}

export async function getWalletCount(): Promise<number> {
  const db   = getFirestoreDb();
  const snap = await db.collection(COLLECTION).count().get();
  return snap.data().count;
}

// ── One-time migration: PostgreSQL → Firestore ────────────────────────────────

/**
 * Runs on startup. Reads any wallets still in PostgreSQL (including credentials)
 * and writes them to Firestore. Safe to call multiple times — skips already-migrated rows.
 */
export async function migrateWalletsToFirestore(): Promise<void> {
  let rows: any[];
  try {
    const result = await pool.query('SELECT * FROM wallets ORDER BY created_at ASC');
    rows = result.rows;
  } catch {
    return; // table may not exist yet
  }

  if (rows.length === 0) return;

  const db = getFirestoreDb();
  let migrated = 0;

  for (const row of rows) {
    const id = row.id as string;
    const existing = await db.collection(COLLECTION).doc(id).get();
    if (existing.exists) continue;

    const w: StoredWallet = {
      id,
      label:      row.label,
      address:    row.address,
      mnemonic:   row.mnemonic   ?? undefined,
      privateKey: row.private_key ?? undefined,
      verified:   row.verified,
      createdAt:  row.created_at,
      type:       row.type,
    };
    await db.collection(COLLECTION).doc(id).set(walletToDoc(w));
    migrated++;
  }

  if (migrated > 0) {
    console.log(`[store] Migrated ${migrated} wallet(s) from PostgreSQL → Firestore`);
  }
}

// ── Env wallet loader ─────────────────────────────────────────────────────────

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
    const inserted = await insertWallet(w);
    if (inserted) console.log(`[store] Auto-imported primary wallet: ${account.address}`);
  } catch { /* invalid mnemonic or already exists */ }
}

// ── Bulk import ───────────────────────────────────────────────────────────────

export async function parseBulkImport(text: string): Promise<{ imported: number; skipped: number; errors: string[] }> {
  const mnemonics:   string[] = [];
  const privateKeys: string[] = [];
  const errors:      string[] = [];

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
    if ([12, 15, 18, 21, 24].includes(words.length)) {
      const phrase = words.join(' ');
      if (!mnemonics.includes(phrase)) mnemonics.push(phrase);
    }
  }

  let imported = 0;
  let skipped  = 0;
  const count  = await getWalletCount();
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
      const ok = await insertWallet(w);
      ok ? imported++ : skipped++;
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
      const ok = await insertWallet(w);
      ok ? imported++ : skipped++;
    } catch (e: any) {
      errors.push(`Key ${i + 1}: ${e?.message ?? 'invalid'}`);
      skipped++;
    }
  }

  return { imported, skipped, errors };
}
