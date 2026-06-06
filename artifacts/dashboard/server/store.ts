import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { DirectSecp256k1HdWallet, DirectSecp256k1Wallet } from '@cosmjs/proto-signing';

const WALLET_FILE = '.wallets.json';
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

let wallets: Map<string, StoredWallet> = new Map();

function loadFromFile() {
  try {
    if (existsSync(WALLET_FILE)) {
      const data = JSON.parse(readFileSync(WALLET_FILE, 'utf8')) as StoredWallet[];
      for (const w of data) wallets.set(w.id, w);
      console.log(`[store] Loaded ${wallets.size} wallet(s) from ${WALLET_FILE}`);
    }
  } catch (e) {
    console.error('[store] Failed to load wallet file:', e);
  }
}

function saveToFile() {
  try {
    writeFileSync(WALLET_FILE, JSON.stringify([...wallets.values()], null, 2));
  } catch { /* ignore */ }
}

loadFromFile();

// Also load MNEMONIC env var if set and not already imported
async function loadEnvWallet() {
  const mnemonic = process.env.MNEMONIC;
  if (!mnemonic) return;
  const clean = mnemonic.trim();
  const exists = [...wallets.values()].some(w => w.mnemonic === clean);
  if (exists) return;
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
    wallets.set(w.id, w);
    saveToFile();
    console.log(`[store] Auto-imported primary wallet: ${account.address}`);
  } catch { /* invalid mnemonic */ }
}

loadEnvWallet();

export function getWallets(): StoredWallet[] {
  return [...wallets.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function getWallet(id: string): StoredWallet | undefined {
  return wallets.get(id);
}

export function removeWallet(id: string): boolean {
  const deleted = wallets.delete(id);
  if (deleted) saveToFile();
  return deleted;
}

export function updateWalletLabel(id: string, label: string) {
  const w = wallets.get(id);
  if (w) { w.label = label; wallets.set(id, w); saveToFile(); }
}

export function markVerified(id: string) {
  const w = wallets.get(id);
  if (w) { w.verified = true; wallets.set(id, w); saveToFile(); }
}

export async function parseBulkImport(text: string): Promise<{ imported: number; skipped: number; errors: string[] }> {
  const mnemonics: string[] = [];
  const privateKeys: string[] = [];
  const errors: string[] = [];

  const lines = text.split(/[\n]+/);
  for (const line of lines) {
    const clean = line.trim();
    if (!clean) continue;

    // Try private key (64 hex chars, optionally with 0x)
    const hexMatch = clean.match(/^(?:0x)?([a-fA-F0-9]{64})$/);
    if (hexMatch) {
      const key = hexMatch[1];
      if (!privateKeys.includes(key)) privateKeys.push(key);
      continue;
    }

    // Try mnemonic (12 or 24 lowercase English words)
    const words = clean.toLowerCase().replace(/\s+/g, ' ').split(' ').filter(w => /^[a-z]+$/.test(w));
    if (words.length === 12 || words.length === 24) {
      const phrase = words.join(' ');
      if (!mnemonics.includes(phrase)) mnemonics.push(phrase);
    }
  }

  let imported = 0;
  let skipped = 0;

  for (let i = 0; i < mnemonics.length; i++) {
    try {
      const hdWallet = await DirectSecp256k1HdWallet.fromMnemonic(mnemonics[i], { prefix: ADDRESS_PREFIX });
      const [account] = await hdWallet.getAccounts();
      if ([...wallets.values()].some(w => w.address === account.address)) { skipped++; continue; }
      const w: StoredWallet = {
        id: randomUUID(),
        label: `Wallet ${wallets.size + 1}`,
        address: account.address,
        mnemonic: mnemonics[i],
        verified: false,
        createdAt: new Date().toISOString(),
        type: 'mnemonic',
      };
      wallets.set(w.id, w);
      imported++;
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
      if ([...wallets.values()].some(w => w.address === account.address)) { skipped++; continue; }
      const w: StoredWallet = {
        id: randomUUID(),
        label: `Wallet ${wallets.size + 1}`,
        address: account.address,
        privateKey: privateKeys[i],
        verified: false,
        createdAt: new Date().toISOString(),
        type: 'privatekey',
      };
      wallets.set(w.id, w);
      imported++;
    } catch (e: any) {
      errors.push(`Key ${i + 1}: ${e?.message ?? 'invalid'}`);
      skipped++;
    }
  }

  if (imported > 0) saveToFile();
  return { imported, skipped, errors };
}
