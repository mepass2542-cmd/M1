---
name: Hub checkin module not active
description: /mechain.checkin.MsgCheckIn on me-hub returns code 2 tx parse error — hub binary has no active checkin module.
---

The `me-hub` binary (chain `me-chain`) returns:
> code 2: unable to resolve type URL /mechain.checkin.MsgCheckIn: tx parse error

even though the source code (`repos/meta-earth/proto/mechain/checkin/tx.proto`, `repos/meta-earth/x/checkin/types/codec.go`) defines the type. The running binary simply doesn't have the checkin module registered.

**Why:** Scanning 200+ recent hub blocks found zero checkin transactions. Only bank, IBC, wstaking, kyc, and megroup types appear on-chain. The checkin module may have been removed before deployment or the binary predates it.

**How to apply:** Never attempt check-in on the hub. Always use the rollup (`mecheckin_101-1`, RPC `http://118.175.0.247:23011`) with type `/stchain.rollapp.checkin.MsgCheckIn` and `broadcastTxAsync`.

**Live test (2026-06-10):** wallet `me1j30rkze4za7nlmctx3y9ggmusyafm93swv2t38`, TX `176EE7E11BA825B5DA6DAD0A79923A4EAFA9157B4FBAC6370DD34A93304CBBFF` accepted by rollup mempool in ~1.4 s.
