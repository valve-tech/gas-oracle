# Changelog

All notable changes to the `valve-tech/evm-toolkit` monorepo are documented in
this file. Per-package details live in each `packages/*/CHANGELOG.md`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.9.2] — 2026-05-08

Second recovery release for v0.9.0. The v0.9.1 attempt added the
sibling-package `devDependencies` to `tx-flight-react` but didn't
fix the workspace **build ordering**: the root `build` script used
`yarn workspaces foreach --topological`, which only follows
`dependencies` entries — not `devDependencies` — so `tx-flight-react`
still ran before `wallet-adapter` / `tx-tracker` were emitted, and
the Build step failed identically. Switched to `--topological-dev`
in the root `build` script. v0.9.2 is the first version of the
v0.9.x line to actually reach npm.

- **root**: `package.json#scripts.build` now uses
  `--topological-dev`, so workspace `devDependencies` participate
  in build ordering. Pure CI-orchestration change; no published
  package shape changed.
- **chain-source**, **gas-oracle**, **tx-tracker**, **viem-errors**,
  **wallet-adapter**, **tx-flight-react**: synced no-op (version
  bump only — package contents identical to v0.9.1's intended
  publish, which never reached npm).

## [0.9.1] — 2026-05-08

Recovery release for v0.9.0 — that tag was pushed but the OIDC
publish workflow's build step failed before any `npm publish` ran,
so nothing in the v0.9.0 line ever landed on npm. *Also did not
publish — same Build-step failure due to `--topological` ignoring
the new `devDependencies`. Superseded by v0.9.2.*

- **tx-flight-react**: declares `@valve-tech/chain-source`,
  `@valve-tech/tx-tracker`, and `@valve-tech/wallet-adapter` as
  `devDependencies: workspace:^` in addition to their existing
  `peerDependencies` entries. Without this, a clean CI install
  doesn't link the sibling packages' type declarations and
  `tsc -p .` fails. Consumer-facing peer-deps are unchanged
  (still optional).
- **chain-source**, **gas-oracle**, **tx-tracker**, **viem-errors**,
  **wallet-adapter**: synced no-op.

## [0.9.0] — 2026-05-08

Adds a sixth package, **`@valve-tech/tx-flight-react`** — React UI primitives for an in-flight transaction strip. Synced bump across all six `@valve-tech/*` packages.

- **tx-flight-react** (NEW): `<TxFlightProvider>` + `useTxFlight` hook + headless layout/atomic components (`<TxFlightList>`, `<TxFlightItem>`, `<TxFlightStatusIcon>`, `<TxFlightHashLink>`, `<TxFlightAge>`, `<TxFlightActions>`). Three add shapes — `addWithWalletAdapter` (sync, types-only wallet-adapter import; wraps `WriteHookParams` so each phase fans to user callbacks AND store dispatch), `addByHash` (async; dynamic-imports tx-tracker + chain-source), `addManual` (sync back-fill). Pluggable storage adapters (`localStorageAdapter` default, `indexedDBAdapter`, `memoryAdapter`) at the `/storage` sub-export. Persistence with bigint-safe JSON; rehydrate revives pending watchers via an optional `clientFactory` prop. Multi-instance scoping by `id`. SSR / RSC safe (Provider is `'use client'`; pure-renderer components are RSC-compatible). Spec: `docs/superpowers/specs/2026-05-07-tx-flight-react-design.md`.
- **chain-source**, **gas-oracle**, **tx-tracker**, **viem-errors**, **wallet-adapter**: synced no-op.

The `@valve-tech/tx-flight-react@0.0.1` name-claim publish was made manually before this release so the npm trusted-publisher record could be wired against the existing package; the 0.9.0 release publishes via the OIDC workflow alongside the synced sibling packages.

All six packages remain at 100/100/100/100 stmts/branches/funcs/lines.

## [0.8.1] — 2026-05-07

Code-quality cleanup of v0.8.0 review leftovers. Synced bump across all five `@valve-tech/*` packages.

- **tx-tracker**: `chainId` option on the three one-shot helpers (`watchTransaction`, `waitForTransaction`, `waitForPending`) — falls back to `client.chain?.id` so the previous `chainId: 0` placeholder gets auto-corrected for most callers without an API change. `replaceTransaction` no longer disables viem's network-mismatch check (`chain: null` → `walletClient.chain ?? null`); `original.chainId` is now load-bearing for EIP-155 signing and chain assertion. Removed dead `_eventSource` parameters from internal bulk runners.
- **gas-oracle**, **viem-errors**: small internal refactors that eliminated `c8 ignore` annotations from earlier releases. No public-API changes.
- **chain-source**, **wallet-adapter**: synced no-op.

All five packages remain at 100/100/100/100 stmts/branches/funcs/lines.

## [0.8.0] — 2026-05-06

Synced bump across all five `@valve-tech/*` packages.

- **chain-source**: WS subscribe paths wired in `subscribeBlocks` and `subscribeMempool` (live-probed at capability time; lazy-opened on first use; falls back to existing poll cycle on subscribe failure).
- **tx-tracker**: closes the three deferred items from `tx-tracker-spec.md` (receipt-poll-fallback runtime, withReceipts eager enrichment, tracker.group cross-tx correlation), adds two Provex upstream verbs (`watchTransaction`, `replaceTransaction`), and ships two Promise-based companions (`waitForTransaction`, `waitForPending` with arrival-timeout). Project-local contributor skill at `.claude/skills/extending-tx-tracker/SKILL.md`.
- **gas-oracle**: upstream helpers (replacement / classifyTip / inclusion labels), chain presets entry-point (PulseChain), const-namespace exports for `PriorityModel` / `TierName` / `Trend` / `TxType`, hoisted `TIER_LADDER`, bigint migration of public numeric fields, and a default-flip for `priorityModel` from `'flat'` to `PriorityModel.eip1559`. See package CHANGELOG for migration notes. Spec: `docs/superpowers/specs/2026-05-07-gas-oracle-upstream-helpers-design.md`.
- **viem-errors / wallet-adapter**: synced no-op.

### @valve-tech/gas-oracle

#### Added

- **Replacement helpers** (`replacement.ts`): `minimumReplacementFee`, `bumpForReplacement`, `recommendBumpTier` (three strategies: `cheapestThatLands` / `oneStepFasterThanRecommended` / `instant`). Optional outpace correction via `stuckTx.identifier` reads `snapshot.mempoolSamples` on top of the EIP-1559 +10% protocol floor.
- **`classifyTip(snapshot, tipWei)`** (`classify-tip.ts`): inverse of `tipForBlockPosition`.
- **Inclusion labels** (`inclusion-labels.ts`): `defaultInclusionLabels` + `inclusionLabel(tier, overrides?)` for locale/branded copy.
- **Chain presets** (`presets.ts`): `chainPresets.pulsechain` (chainId 369, `PriorityModel.flat`) and `presetForChainId(chainId)`.
- **Const-namespace exports**: `PriorityModel`, `TierName`, `Trend`, `TxType` exported as both values and types. `TIER_LADDER` exported from `types.ts`.
- **`mempoolSamples: TipSample[]`** on `GasOracleState` — producer-local, strippable for wire serialization.

#### Changed

- **`priorityModel` default**: `'flat'` → `PriorityModel.eip1559`. PulseChain (chain 369) is now the explicit exception (use `chainPresets.pulsechain`).
- **BigInt migration**: `MempoolStats.pendingCount`, `MempoolStats.queuedCount`, `BlockPositionQuery.rank`/`.percentile`, `BlockPositionResult.rank`, `CreateGasOracleOptions.pollIntervalMs` are now `bigint`. Identifier fields (`chainId`, EIP-2718 type bytes) stay `number`.

#### Migration

- Verify your chain honors EIP-1559 — examples that previously omitted `priorityModel` now silently get `PriorityModel.eip1559`.
- Use bigint literals (`0n`, `1n`, …) and floor-division semantics for migrated fields.
- `pollIntervalMs: 5000` → `pollIntervalMs: 5000n`.

Spec: `docs/superpowers/specs/2026-05-06-v0.8.0-tx-tracker-completion-design.md`
