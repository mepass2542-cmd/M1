---
name: Hub chain MsgNewRecord check-in
description: The rollup chain (mecheckin_101-1) stalled 2026-05-01. Active daily check-in is MsgNewRecord on me-chain hub (9 000+ txs/day confirmed June 2026).
---

## Rule
Daily check-in must use `/metaearth.wstaking.MsgNewRecord` on the hub chain (`me-chain`), NOT the rollup.

**Why:** The rollup chain `mecheckin_101-1` stopped producing blocks on 2026-05-01 (block 18,600,981). All tx broadcasts return a false "async accepted" success after 60s poll timeout. The hub chain has been actively processing `MsgNewRecord` txs continuously.

**How to apply:** Any code that broadcasts check-in transactions should target hub RPC `http://118.175.0.247:16657` with `signAndBroadcast` (no async bypass needed). Message fields: `actionNumber` (alphanumeric, bot uses `MEcheckin` + `YYYYMMDD`), `actionUrl` (non-empty URL, defaults to `https://metaearth.network`), `from` (wallet address).

## Fee
Chain enforces a flat **minimum 10 000 umec** fee (error code 13: "fee must greater than or equal 10000umec"). Bot uses `11 000 umec / 500 000 gas`. Real txs use ~75 000 gas out of 500 000 limit. Wallets with < 11 000 umec hub balance will fail with code 5 "insufficient funds" — they need to be topped up before they can check in.

## Rollup legacy
Keep rollup `MsgCheckIn` as fallback code only (2-field proto, zero fee, broadcastTxAsync). It will always fail while the rollup is stalled but is harmless to keep in case the chain ever resumes.

## Protobuf
MsgNewRecord type (from `proto/metaearth/wstaking/record.proto`):
- field 1: `actionNumber` string (alphanumeric only, keeper validates)
- field 2: `actionUrl` string (non-empty, no URL format validation)
- field 3: `from` string (bech32 wallet address)
