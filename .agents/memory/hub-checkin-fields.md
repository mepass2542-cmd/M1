---
name: Hub MsgCheckIn — correct type & fields
description: Correct type URL, fields, fee, and broadcast mode for Meta Earth daily check-in on the me-hub chain.
---

## Rule
Daily check-in goes to the **me-hub** (`me-chain`), NOT the rollup.

- **Type URL**: `/mechain.checkin.MsgCheckIn`
- **Fields** (3):
  - `checkInAddress` (field 1) — wallet's bech32 address
  - `checkInMessage` (field 2) — e.g. `"ME, My Way!"`
  - `checkInTimezone` (field 3) — e.g. `"UTC"`
- **Fee**: zero amount, gas `200000` — `freeGas = true` is set in `fee_deduct.go` lines 100-101 for all `*checkintypes.MsgCheckIn` messages
- **Broadcast**: normal `signAndBroadcast` (broadcastTxSync) — hub is LIVE, no special CheckTx bypass needed
- **Hub RPC**: `http://118.175.0.247:16657`, chain ID `me-chain`, prefix `me`

**Why:** User confirmed 2026-06-10. Hub is live at block 13345451+, has a compiled `checkin` module in `x/checkin/`. The earlier rollup mempool approach was based on observing other bots, not the hub source code.

**How to apply:** Both `meta-earth-checkin/src/checkin.ts` and `artifacts/dashboard/server/blockchain.ts` must use this type URL and 3-field proto. Register type in hub client's registry before calling signAndBroadcast.
