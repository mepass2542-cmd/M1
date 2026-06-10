---
name: Rollup MsgCheckIn — correct type URL and fields
description: The correct daily check-in uses /stchain.rollapp.checkin.MsgCheckIn with 2 fields on the rollup via broadcastTxAsync. Confirmed from live mempool + explorer.
---

## Rule
Daily check-in: **`/stchain.rollapp.checkin.MsgCheckIn`** with **2 fields only** on rollup chain (`mecheckin_101-1`), broadcast via `broadcastTxAsync`.

**Confirmed from two sources (2026-06-10):**
1. Meta Earth explorer tx `B207FF2FDB188AFB16B873E595BF4A870AE746DED7C3093B29E3E871B3718E1E` (block 20275303) — type `stchain.rollapp.checkin.MsgCheckIn`, fields: creator, slogan, recover_interruption(false)
2. Raw protobuf decode of 5 live rollup mempool txs — ALL have exactly 2 wire fields: address (1) + message (2). recover_interruption=false is proto3 default, not transmitted.

**Live check-in test (2026-06-10):** wallet `me1j30rkze4za7nlmctx3y9ggmusyafm93swv2t38`, TX `176EE7E11BA825B5DA6DAD0A79923A4EAFA9157B4FBAC6370DD34A93304CBBFF` accepted in ~1.4s.

**Why:**
- The hub type `/mechain.checkin.MsgCheckIn` returns code 2 tx parse error — hub binary has no active checkin module.
- The rollup stopped producing blocks 2026-05-01 but mempool stays up. Meta Earth backend records check-ins from mempool acceptance.

**How to apply:**
- typeUrl: `/stchain.rollapp.checkin.MsgCheckIn`
- fields: `checkInAddress` (wallet address), `checkInMessage` (`"META EARTH! ME, My Way!"`)
- fee: `{ amount: [], gas: '200000' }` (zero fee)
- broadcast: `Tendermint37Client.broadcastTxAsync` (not signAndBroadcast)
- chain: rollup RPC `http://118.175.0.247:23011`, chain ID `mecheckin_101-1`
