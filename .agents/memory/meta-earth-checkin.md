---
name: Meta Earth check-in mechanism
description: How the daily check-in works on the Meta Earth rollup — fee model, sequence handling, broadcast mode, and what NOT to do.
---

# Meta Earth Check-in Mechanism

**Rule:** Daily check-in is `MsgCheckIn` (`/stchain.rollapp.checkin.MsgCheckIn`) on the rollup chain `mecheckin_101-1` via RPC `http://118.175.0.247:23011`. Use zero fees (empty amount array). No IBC bridging needed.

**Why:** The rollup's minimum gas price (`0.001 umec`) is not enforced — transactions with an empty fee array are accepted. The IBC relayer between me-hub and the rollup has never relayed a packet (both hub channels show next_sequence_receive=1). Attempting to bridge MEC via IBC wastes hub funds. Confirmed working with TX `731C36E75FDF887EE235F16332024CEA864C4E79DB94AD3AC44A2491B3D8A5CF`.

**How to apply:**
- Fee: `{ amount: [], gas: '200000' }`
- Use `Tendermint37Client.connect(rpcUrl)` + `SigningStargateClient.createWithSigner(tmClient, signer, { registry })`
- Use `tmClient.broadcastTxSync({ tx: txBytes })` — NOT `client.broadcastTx()` which waits for block commit and hangs 30s+
- Sequence mismatch (code 32): parse `expected (\d+)` from the error log and retry — `getSequence` returns committed state but mempool may have pending txs ahead of it. Retry up to 3 times.
- MsgCheckIn fields: `checkInAddress` (field 1, string) and `checkInMessage` (field 2, string, default `"META EARTH! ME, My Way!"`)

**What NOT to do:**
- Do NOT send IBC transfers from me-hub — the relayer doesn't work and drains the hub wallet.
- Do NOT use `client.broadcastTx()` (commit mode) — it times out on this rollup.
- Do NOT use the me-hub chain for check-ins — check-ins live on the rollup only.
- Do NOT assume `getSequence()` reflects mempool state — it only reflects committed blocks.

## Chain topology (mainnet 118.175.0.247)
- Port 23011 (RPC) / 23013 (REST): rollup `mecheckin_101-1`, prefix `me` — where MsgCheckIn is submitted
- Port 16657 (RPC) / 11317 (REST): me-hub `me-chain`, prefix `me` — holds wallet umec balance, IBC relay broken
- Port 26657 (RPC) / 1317 (REST): `gc_20-1` chain, prefix `gc` — separate chain, unrelated to daily check-in
