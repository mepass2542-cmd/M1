# Meta Earth Check-in Bot

A daily check-in automation bot for the Meta Earth blockchain, plus all openmetaearth GitHub repos cloned locally for reference.

## Run & Operate

- `pnpm --filter @workspace/meta-earth-checkin run dev` — start the bot (runs immediately + schedules daily cron)
- `pnpm --filter @workspace/meta-earth-checkin run checkin-now` — one-off check-in right now
- `pnpm run typecheck` — full typecheck across all packages
- Required env: `PRIVATE_KEY` or `MNEMONIC` — wallet credential

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Bot: `@cosmjs/stargate` + `@cosmjs/proto-signing`, `node-cron`
- Message encoding: `protobufjs ^7.4.0` (dynamically defined types)

## Where things live

- `meta-earth-checkin/src/index.ts` — bot entry point / cron scheduler
- `meta-earth-checkin/src/checkin.ts` — MsgNewRecord transaction logic (the actual check-in)
- `meta-earth-checkin/src/wallet.ts` — wallet derivation from private key or mnemonic
- `meta-earth-checkin/src/logger.ts` — timestamped logger
- `meta-earth-checkin/.env.example` — env var template
- `repos/` — all 9 openmetaearth GitHub repos (shallow clones)

## Architecture decisions

- **Daily check-in is `MsgCheckIn` in the `stchain.rollapp.checkin` module** — type URL `/stchain.rollapp.checkin.MsgCheckIn` on the **rollup chain** (`mecheckin_101-1`) via `broadcastTxAsync`.
- The rollup chain stopped producing blocks on 2026-05-01, but its **mempool still accepts transactions**. The Meta Earth backend records check-ins from mempool acceptance — `broadcastTxAsync` is sufficient and is exactly what the Meta Earth app does.
- **Rollup RPC**: `http://118.175.0.247:23011` (chain ID `mecheckin_101-1`, prefix `me`, REST port `23013`).
- **MsgCheckIn fields** (2): `checkInAddress` (1, wallet address), `checkInMessage` (2, configurable — Meta Earth app uses `"META EARTH! ME, My Way!"`).
- **Rollup fee**: zero — custom `fee_checker.go` has no minimum fee requirement. Gas limit: `200 000`.
- **Broadcast mode**: `broadcastTxAsync` — bypasses CheckTx so zero-fee txs are accepted by the mempool. The tx lands in the mempool and the Meta Earth backend sees it.
- Bot uses `@cosmjs/stargate` + `@cosmjs/proto-signing` + `@cosmjs/tendermint-rpc` directly.
- `protobufjs` overridden to `^7.4.0` in `pnpm-workspace.yaml` — version 6.x blocked by Replit security policy.
- **Hub chain (me-hub)**: RPC `http://118.175.0.247:16657` (chain ID `me-chain`). Has `wstaking` module with `MsgNewRecord` — this is a **staking record entry**, NOT a daily check-in. No reward. Do not use for check-in.
- **Hub `mechain.checkin.MsgCheckIn`**: Defined in the `meta-earth` repo but NOT compiled into the running me-hub binary at port 16657. The running hub binary is `me-hub`, not `meta-earth`.

## Product

Daily check-in bot that signs and broadcasts a `MsgNewRecord` transaction on the Meta Earth hub chain on a configurable cron schedule. Supports multiple wallets via numbered `PRIVATE_KEY_1`, `PRIVATE_KEY_2`, ... or `MNEMONIC_1`, `MNEMONIC_2`, ... secrets.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- **Rollup `MsgCheckIn` has 2 fields ONLY**: `checkInAddress` (1) and `checkInMessage` (2). The 3rd timezone field is from the hub chain's `mechain.checkin.MsgCheckIn` (a DIFFERENT chain). Adding it to the rollup tx causes a `RecoverInterruption` wireType parse error.
- **Use `broadcastTxAsync` for rollup txs** — `broadcastTxSync` runs CheckTx which enforces `minGasPrices = "0.001umec"`. Wallets with no IBC MEC fail CheckTx. Async skips CheckTx; DeliverTx has no fee check (confirmed from `openroll/app/fee_checker.go`).
- **Testnet rollup REST port is `3317`** (not `46660`) — confirmed from `repos/meta-earth-js-sdk/src/config/define.ts`.
- `meta-earth-js-sdk` is not published on npm — use local clone in `repos/meta-earth-js-sdk/` for reference, or depend on cosmjs directly.
- `protobufjs@6.x` is blocked by Replit security policy; override to `^7.4.0` is set in `pnpm-workspace.yaml`.
- The chain at port 26657 on `118.175.0.247` is a separate `gc_20-1` chain (prefix `gc`), NOT the me-hub. The me-hub RPC is at port `16657`.
- Dashboard rollup balance queries `ibc/BC7F4D...` denom (IBC-bridged umec); `urax` is the rollup's native staking denom and is unrelated to MEC balance.

## Secrets to set in Replit

| Secret | Value |
|--------|-------|
| `PRIVATE_KEY` | Your hex private key (or use MNEMONIC) |
| `NETWORK` | `mainnet` or `testnet` |
| `RUN_ON_START` | `true` |
| `CRON_SCHEDULE` | `0 8 * * *` (08:00 UTC daily, optional) |
| `CHECK_IN_TIMEZONE` | Timezone string for check-in (e.g. `UTC`, `UTC+8`, optional — defaults to `UTC`) |
| `CHECK_IN_MESSAGE` | Custom check-in message (optional, used for rollup fallback only) |
| `CHECKIN_URL` | URL submitted as `actionUrl` in `MsgNewRecord` (optional, defaults to `https://metaearth.network`) |

## Firebase Auth (dashboard login)

The dashboard is protected by Firebase Authentication. Config is stored as `VITE_FIREBASE_*` env vars.

- **To add users**: Firebase Console → Authentication → Users → Add User (email + password)
- **Project**: `meta-earth-dashboard`
- The wallet private keys/mnemonics stay in PostgreSQL — they are **never sent to Firebase/Firestore**
- Every API request carries a Firebase ID token; the backend (`server/auth.ts`) verifies it with `firebase-admin`

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- RPC config source: `repos/meta-earth-js-sdk/src/config/define.ts`
- MsgNewRecord source: `repos/me-hub/x/wstaking/keeper/msg_server_record.go`
