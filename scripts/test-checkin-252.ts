import * as dotenv from 'dotenv';
import path from 'path';
import * as admin from 'firebase-admin';
import {
  DirectSecp256k1HdWallet,
  DirectSecp256k1Wallet,
  Registry,
} from '@cosmjs/proto-signing';
import { SigningStargateClient, defaultRegistryTypes } from '@cosmjs/stargate';
import { Type, Field, Root } from 'protobufjs';

dotenv.config({ path: path.join(__dirname, '../artifacts/dashboard/.env') });

const HUB_RPC  = 'http://118.175.0.247:16657';
const HUB_REST = 'http://118.175.0.247:11317';
const WSTAKING_NEW_RECORD_URL = '/metaearth.wstaking.MsgNewRecord';
const HUB_CHECKIN_FEE = { amount: [{ denom: 'umec', amount: '11000' }], gas: '500000' };

function buildMsgNewRecordType(): Type {
  const root = new Root();
  const T = new Type('MsgNewRecord')
    .add(new Field('actionNumber', 1, 'string'))
    .add(new Field('actionUrl',    2, 'string'))
    .add(new Field('from',         3, 'string'));
  root.add(T);
  return T;
}

async function main() {
  // ── Init Firebase Admin ──────────────────────────────────────────────────
  const saJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!saJson) { console.error('Missing FIREBASE_SERVICE_ACCOUNT'); process.exit(1); }
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(saJson)) });
  const db = admin.firestore();

  // ── Get all wallets from Firestore, find wallet 252 by label ────────────
  console.log('Fetching wallets from Firestore...');
  const snap = await db.collection('wallets').orderBy('createdAt', 'asc').get();
  console.log(`Total Firestore wallets: ${snap.size}`);

  const allWallets = snap.docs.map(d => ({ id: d.id, ...d.data() as any }));
  const wallet252 = allWallets.find((w: any) => w.label === 'Wallet 252');

  if (!wallet252) {
    console.error('Wallet 252 not found in Firestore!');
    console.log('Last 5 wallet labels:', allWallets.slice(-5).map((w: any) => w.label));
    process.exit(1);
  }

  console.log(`\nWallet 252:`);
  console.log(`  label:   ${wallet252.label}`);
  console.log(`  address: ${wallet252.address}`);
  console.log(`  type:    ${wallet252.type}`);
  console.log(`  hasMnemonic: ${!!wallet252.mnemonic}`);
  console.log(`  hasPrivateKey: ${!!wallet252.privateKey}`);

  // ── Check hub balance ────────────────────────────────────────────────────
  console.log(`\nChecking hub balance for ${wallet252.address}...`);
  try {
    const balRes = await fetch(`${HUB_REST}/cosmos/bank/v1beta1/balances/${wallet252.address}?pagination.limit=20`);
    const balJson = await balRes.json() as any;
    const umec = (balJson.balances ?? []).find((b: any) => b.denom === 'umec');
    const bal = umec ? parseInt(umec.amount, 10) : 0;
    console.log(`  Hub balance: ${bal.toLocaleString()} umec`);
    if (bal < 11000) {
      console.error(`  ❌ Insufficient balance — need 11,000 umec, have ${bal.toLocaleString()} umec`);
      process.exit(1);
    }
    console.log(`  ✅ Balance OK`);
  } catch (e: any) {
    console.error('  Balance check failed:', e.message);
    process.exit(1);
  }

  // ── Build signer ─────────────────────────────────────────────────────────
  let signer: any;
  try {
    if (wallet252.privateKey) {
      const keyBytes = Buffer.from(wallet252.privateKey, 'hex');
      signer = await DirectSecp256k1Wallet.fromKey(new Uint8Array(keyBytes), 'me');
    } else if (wallet252.mnemonic) {
      signer = await DirectSecp256k1HdWallet.fromMnemonic(wallet252.mnemonic, { prefix: 'me' });
    } else {
      throw new Error('No credentials');
    }
  } catch (e: any) {
    console.error('Failed to build signer:', e.message);
    process.exit(1);
  }

  // ── Build client ─────────────────────────────────────────────────────────
  const registry = new Registry([...defaultRegistryTypes]);
  registry.register(WSTAKING_NEW_RECORD_URL, buildMsgNewRecordType() as any);

  console.log(`\nConnecting to hub RPC: ${HUB_RPC}`);
  let client: SigningStargateClient;
  try {
    client = await SigningStargateClient.connectWithSigner(HUB_RPC, signer, { registry });
    const chainId = await client.getChainId();
    const blockHeight = await client.getHeight();
    console.log(`  chainId: ${chainId}`);
    console.log(`  blockHeight: ${blockHeight}`);
  } catch (e: any) {
    console.error('Failed to connect:', e.message);
    process.exit(1);
  }

  // ── Send MsgNewRecord ────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const actionNumber = `MEcheckin${today}`;
  const actionUrl = process.env.CHECKIN_URL ?? 'https://metaearth.network';
  const msg = {
    typeUrl: WSTAKING_NEW_RECORD_URL,
    value: { actionNumber, actionUrl, from: wallet252.address },
  };

  console.log(`\nBroadcasting MsgNewRecord...`);
  console.log(`  actionNumber: ${actionNumber}`);
  console.log(`  actionUrl:    ${actionUrl}`);
  console.log(`  from:         ${wallet252.address}`);

  let txHash: string | undefined;
  try {
    const result = await client.signAndBroadcast(wallet252.address, [msg], HUB_CHECKIN_FEE, '');
    console.log(`\n  signAndBroadcast result:`);
    console.log(`    code:    ${result.code}`);
    console.log(`    txHash:  ${result.transactionHash}`);
    console.log(`    height:  ${result.height}`);
    console.log(`    rawLog:  ${(result.rawLog ?? '').slice(0, 300)}`);
    txHash = result.transactionHash;

    if (result.code !== 0) {
      console.error(`\n❌ DeliverTx failed with code ${result.code}`);
      process.exit(1);
    }
    console.log(`\n✅ signAndBroadcast returned success!`);
  } catch (e: any) {
    console.error(`\n❌ signAndBroadcast threw: ${e.message}`);
    process.exit(1);
  }

  // ── Verify tx is actually on chain ────────────────────────────────────────
  if (txHash) {
    console.log(`\nVerifying tx ${txHash} on hub chain...`);
    // Try RPC tx endpoint
    try {
      const rpcRes = await fetch(`${HUB_RPC}/tx?hash=0x${txHash}`);
      const rpcJson = await rpcRes.json() as any;
      if (rpcJson.result?.hash) {
        console.log(`  ✅ Found via RPC: block height ${rpcJson.result.height}`);
      } else {
        console.log(`  ❌ NOT found via RPC: ${JSON.stringify(rpcJson.error ?? rpcJson).slice(0, 200)}`);
      }
    } catch (e: any) {
      console.log(`  RPC check failed: ${e.message}`);
    }

    // Try REST tx endpoint
    try {
      const restRes = await fetch(`${HUB_REST}/cosmos/tx/v1beta1/txs/${txHash}`);
      const restJson = await restRes.json() as any;
      if (restJson.tx_response?.txhash) {
        console.log(`  ✅ Found via REST: height ${restJson.tx_response.height}`);
      } else {
        console.log(`  ❌ NOT found via REST`);
      }
    } catch (e: any) {
      console.log(`  REST check failed: ${e.message}`);
    }

    // Try querying by sender to find the tx
    console.log(`\nSearching by sender address on hub...`);
    try {
      const searchRes = await fetch(
        `${HUB_RPC}/tx_search?query=%22message.sender%3D%27${wallet252.address}%27%22&per_page=3&order_by=%22desc%22`
      );
      const searchJson = await searchRes.json() as any;
      const txs = searchJson.result?.txs ?? [];
      console.log(`  Latest ${txs.length} txs for this address on hub:`);
      for (const t of txs) {
        const match = t.hash === txHash ? ' ← OUR TX' : '';
        console.log(`    hash: ${t.hash} height: ${t.height}${match}`);
      }
    } catch (e: any) {
      console.log(`  Sender search failed: ${e.message}`);
    }
  }

  await admin.app().delete();
  process.exit(0);
}

main().catch(e => { console.error(e); process.exit(1); });
