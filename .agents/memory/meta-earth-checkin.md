---
name: Meta Earth check-in mechanism
description: How the daily check-in works on the Meta Earth rollup — fee model, sequence handling, broadcast mode, staking module, and what NOT to do.
---

# Meta Earth Check-in Mechanism

**Rule:** Daily check-in is `MsgCheckIn` (`/stchain.rollapp.checkin.MsgCheckIn`) on the rollup chain `mecheckin_101-1` via RPC `http://118.175.0.247:23011`. Fee is **10 000 units of IBC MEC** on the rollup — NOT empty.

**Why:** The rollup previously accepted zero-fee txs, but now enforces a minimum fee. Wallets hold IBC MEC (`ibc/BC7F4D581D88785A22824C8FB6807DFC3B65C1764AFF1230D954AAB06B70CBC5`) on the rollup which pays for fees. Using empty fee returns code 13.

**How to apply:**
- Fee: `{ amount: [{ denom: ROLLUP_IBC_DENOM, amount: '10000' }], gas: '200000' }`
- Use `Tendermint37Client.connect(rpcUrl)` + `SigningStargateClient.createWithSigner(tmClient, signer, { registry })`
- Use `tmClient.broadcastTxSync({ tx: txBytes })` — NOT `client.broadcastTx()` which waits for block commit and hangs 30s+
- Sequence mismatch (code 32): parse `expected (\d+)` from the error log and retry — `getSequence` returns committed state but mempool may have pending txs ahead of it. Retry up to 3 times.
- MsgCheckIn fields: `checkInAddress` (field 1, string) and `checkInMessage` (field 2, string)
- When sweeping rollup balance, reserve 10 000 IBC MEC for fees (don't send all)

## wstaking Custom Module (Hub staking — NOT standard cosmos staking)

The me-hub uses `metaearth.wstaking`, NOT `cosmos.staking.v1beta1` or `cosmos.distribution.v1beta1`.
Standard Cosmos staking endpoints return 0 / code 13 runtime error.

**REST endpoints:**
- `GET /metaearth/wstaking/delegation/{address}` → `delegation_response.balance.amount` (umec, as string)
  - Also contains `delegation_response.delegation.validator_address`
- `GET /metaearth/wstaking/delegation-rewards/{address}` → `rewards[0].amount` (float string umec)
- One delegation per wallet (single validator, not multiple)

**Transaction type URLs (protobuf registry):**
- Claim rewards: `/metaearth.wstaking.MsgWithdrawDelegatorReward`
  - Fields: `delegatorAddress` (string, field 1), `validatorAddress` (string, field 2)
- Unstake: `/metaearth.wstaking.MsgUnstake`
  - Fields: `stakerAddress` (string, field 1), `validatorAddress` (string, field 2), `amount` (Coin, field 3)
- These must be registered in the cosmjs `Registry` before signing

**Hub hub client must include wstaking types in its registry** — `SigningStargateClient.connectWithSigner(HUB_RPC, signer, { registry })` where registry has `/metaearth.wstaking.*` types registered.

## IBC channel (confirmed STATE_OPEN)
- Hub `channel-1` (port: transfer) ↔ Rollup `channel-0` (port: transfer)
- IBC denom of hub MEC on rollup: `ibc/BC7F4D581D88785A22824C8FB6807DFC3B65C1764AFF1230D954AAB06B70CBC5`
- Use `client.sendIbcTokens(sender, receiver, coin, 'transfer', 'channel-1', undefined, timeoutTimestampNs, HUB_FEE)`

## Chain topology (mainnet 118.175.0.247)
- Port 23011 (RPC) / 23013 (REST): rollup `mecheckin_101-1`, prefix `me` — where MsgCheckIn is submitted
- Port 16657 (RPC) / 11317 (REST): me-hub, prefix `me` — holds wallet umec balance; staking via wstaking module
- Port 26657 / 1317: `gc_20-1` chain — unrelated to daily check-in or hub staking
