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
- `meta-earth-checkin/src/checkin.ts` — MsgCheckIn transaction logic (the actual check-in)
- `meta-earth-checkin/src/wallet.ts` — wallet derivation from private key or mnemonic
- `meta-earth-checkin/src/logger.ts` — timestamped logger
- `meta-earth-checkin/.env.example` — env var template
- `repos/` — all 9 openmetaearth GitHub repos (shallow clones)

## Architecture decisions

- **Daily check-in is `/mechain.checkin.MsgCheckIn`** on the **me-hub** (`me-chain`) via `broadcastTxSync` (`signAndBroadcast`). Hub is LIVE at block 13345451+.
- **MsgCheckIn fields** (3): `checkInAddress` (1, wallet address), `checkInMessage` (2, e.g. `"ME, My Way!"`), `checkInTimezone` (3, e.g. `"UTC"`). Confirmed from `repos/meta-earth/proto/mechain/checkin/tx.proto` and `tx.pb.go`.
- **Fee**: zero amount — `fee_deduct.go` lines 100-101 set `freeGas = true` for all `*checkintypes.MsgCheckIn` messages. Gas limit: `200 000`. Normal `broadcastTxSync` works — no custom CheckTx for checkin msgs.
- **Hub RPC**: `http://118.175.0.247:16657` (chain ID `me-chain`, prefix `me`, REST port `11317`).
- Bot uses `@cosmjs/stargate` + `@cosmjs/proto-signing` directly.
- `protobufjs` overridden to `^7.4.0` in `pnpm-workspace.yaml` — version 6.x blocked by Replit security policy.
- **Hub `wstaking` module**: Has `MsgNewRecord` — this is the **Show E task** module, **NOT daily check-in**. Using `MsgNewRecord` for check-in triggers "Show E" in the Meta Earth app, not "Daily Sign-in".

## Product

Daily check-in bot that signs and broadcasts a `MsgCheckIn` transaction on the Meta Earth hub chain (`me-chain`) via `signAndBroadcast` on a configurable cron schedule. Supports multiple wallets via numbered `PRIVATE_KEY_1`, `PRIVATE_KEY_2`, ... or `MNEMONIC_1`, `MNEMONIC_2`, ... secrets.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- **Correct hub check-in type URL is `/mechain.checkin.MsgCheckIn`** with **3 fields**: `checkInAddress` (1), `checkInMessage` (2), `checkInTimezone` (3). Default message: `"ME, My Way!"`. Confirmed from `repos/meta-earth/proto/mechain/checkin/tx.proto`.
- **DO NOT use `/metaearth.wstaking.MsgNewRecord` for check-in** — that is the "Show E" task module. Sending `MsgNewRecord` triggers "Show E" in the Meta Earth app, not "Daily Sign-in".
- **MsgCheckIn gets freeGas** — `fee_deduct.go` lines 100-101 set `freeGas = true` for `*checkintypes.MsgCheckIn`. Zero amount fee, gas limit 200 000. Normal `broadcastTxSync` (`signAndBroadcast`) works fine.
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
| `CHECK_IN_MESSAGE` | Custom check-in message (optional, defaults to `META EARTH! ME, My Way!`) |

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
