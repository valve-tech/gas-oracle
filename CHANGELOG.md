# Changelog

All notable changes to the `valve-tech/evm-toolkit` monorepo are documented in
this file. Per-package details live in each `packages/*/CHANGELOG.md`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
