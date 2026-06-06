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

- **Daily check-in is `MsgCheckIn` in the `stchain.rollapp.checkin` module** — type URL `/stchain.rollapp.checkin.MsgCheckIn` on the rollup chain (`mecheckin_101-1`), NOT on me-hub.
- **Rollup RPC**: mainnet `http://118.175.0.247:23011` (chain ID `mecheckin_101-1`, prefix `me`).
- **Fee**: ZERO — the rollup accepts transactions with an empty fee array. The `0.001 umec` minimum gas price is not enforced. No IBC bridging of MEC is needed.
- **Sequence handling**: `getSequence` queries committed state; if mempool has pending txs the chain returns a sequence mismatch (code 32). The bot parses the expected sequence from the error log and retries automatically (up to 3 attempts).
- **Broadcast mode**: `broadcastTxSync` (mempool check only) — avoids long block-commit waits on this rollup.
- Bot uses `@cosmjs/stargate` + `@cosmjs/proto-signing` + `@cosmjs/tendermint-rpc` directly (SDK not on npm).
- `protobufjs` overridden to `^7.4.0` in `pnpm-workspace.yaml` — version 6.x blocked by Replit security policy.

## Product

Daily check-in bot that signs and broadcasts a `MsgNewRecord` transaction on the Meta Earth hub chain on a configurable cron schedule. Supports multiple wallets via numbered `PRIVATE_KEY_1`, `PRIVATE_KEY_2`, ... or `MNEMONIC_1`, `MNEMONIC_2`, ... secrets.

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- **No `MsgCheckin` on me-hub.** The `checkin` module is in the `meta-earth` repo (chain `gc_20-1`, prefix `gc`) — a separate chain where the wallet has no funds. The real daily action users do is `MsgNewRecord` in `wstaking`.
- `meta-earth-js-sdk` is not published on npm — use local clone in `repos/meta-earth-js-sdk/` for reference, or depend on cosmjs directly.
- `protobufjs@6.x` is blocked by Replit security policy; override to `^7.4.0` is set in `pnpm-workspace.yaml`.
- The chain at port 26657 on `118.175.0.247` is a separate `gc_20-1` chain (prefix `gc`), NOT the me-hub. The me-hub RPC is at port `16657`.
- Fee minimum: 10,000 umec hard minimum regardless of gas. Do not use `auto` fee — it underestimates.

## Secrets to set in Replit

| Secret | Value |
|--------|-------|
| `PRIVATE_KEY` | Your hex private key (or use MNEMONIC) |
| `NETWORK` | `mainnet` or `testnet` |
| `RUN_ON_START` | `true` |
| `CRON_SCHEDULE` | `0 8 * * *` (08:00 UTC daily, optional) |
| `ACTION_NUMBER` | Custom action number (optional, auto-generated daily if not set) |
| `ACTION_URL` | Custom URL for the record (optional, defaults to https://metaearth.io) |

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- RPC config source: `repos/meta-earth-js-sdk/src/config/define.ts`
- MsgNewRecord source: `repos/me-hub/x/wstaking/keeper/msg_server_record.go`
