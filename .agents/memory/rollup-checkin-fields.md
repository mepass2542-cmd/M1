---
name: Rollup MsgCheckIn fields & type URL
description: The correct type URL and fields for the Daily Sign-in on the rollup chain (mecheckin_101-1).
---

## Rule
The Daily Sign-in on the rollup chain uses `/mechain.checkin.MsgCheckIn` with **3 fields**:
1. `checkInAddress` — wallet address
2. `checkInMessage` — e.g. "META EARTH! ME, My Way!"
3. `checkInTimezone` — e.g. "UTC", "UTC+8"

Source: `repos/meta-earth/proto/mechain/checkin/tx.proto` (package `mechain.checkin`)

**Why:** Using the old `/stchain.rollapp.checkin.MsgCheckIn` type URL (2 fields, no timezone) causes txs to appear as "ShowE" (unrecognised module) in the Meta Earth explorer — NOT as "Daily Sign-in". The proto for the correct module is in the meta-earth repo (not openroll or me-hub). Previous agent incorrectly documented this as a 2-field rollup-only type.

**How to apply:** Both `meta-earth-checkin/src/checkin.ts` and `artifacts/dashboard/server/blockchain.ts` use:
- `CHECKIN_TYPE_URL = '/mechain.checkin.MsgCheckIn'`
- 3-field protobuf type: `checkInAddress(1), checkInMessage(2), checkInTimezone(3)`
- `checkInTimezone` from `CHECK_IN_TIMEZONE` env var (default `"UTC"`)
- Broadcast: `broadcastTxAsync` + zero fee (unchanged)
