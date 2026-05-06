# Changelog

All notable changes to `@valve-tech/tx-tracker` are documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- **Per-tx state machine** (`createTxTracker`) consuming a
  `ChainSource` for upstream block + mempool signals. Three
  consumption shapes over one push-based core: `getTxStatus(hash)`
  for the cached snapshot, `subscribe(hash, cb)` for callback-style,
  and `track(hash)` for the async-iterator shape — all three back
  onto the same internal stream so they see consistent state.
- **`TxEvent` discriminated union** (spec §6) with neutral
  observation kinds: `started`, `seen-in-mempool`, `left-mempool`,
  `seen-in-block`, `vanished-from-block`, `replaced-by`,
  `unseen-for-N-blocks`, `signal-degraded`, `signal-recovered`,
  `stopped`. Every event carries an envelope (`hash`, `chainId`,
  `source`, `at: { blockNumber, timestamp }`) so consumers can
  apply policy (`'confirmed'`, `'stuck'`, etc.) in their own UX
  voice without the tracker prejudging.
- **`TxTrackerStore` interface + `createInMemoryStore` default**
  (spec §9, §10). Block-unit retention (`retentionBlocks: 64` by
  default — reorg safety is a depth invariant, not a wall-clock
  invariant), bounded per-hash audit log (`eventLogCapacity: 256`
  by default) for catch-up replay.
- **Reorg detector** (`detectDivergences`, spec §12) — pure function
  over `BlockSample[]` that flags same-height different-hash
  divergences within `reorgDepthBlocks` (default 12). Ring is
  conservative about heights with no canonical entry — a partial
  canonical sequence does not nuke unrelated ring entries.
- **Bulk subscriptions** (spec §11): `trackFromAddress`,
  `trackToAddress`, `trackPredicate`. Auto-tracks matched hashes
  by default (`autoTrackMatched: true`) so the per-hash event
  stream is available too. Capped at `maxBulkSubscriptions: 16`.
- **Capability disclosure** — `tracker.capabilities()` forwards the
  source's snapshot. `signal-degraded` / `signal-recovered` events
  fire on every tracked hash when source-level capability
  transitions cross authority boundaries.
- **Replacement detection** — caches `(from, nonce)` on first
  observation and emits `replaced-by` when a different hash with
  the same identity appears (mempool: `replacementBlockNumber: null`;
  block: filled-in block number).
- **`subscribeAll(cb)`** — global stream of every event the tracker
  emits, useful for indexers piping to a single sink.

### Notes

- Implements spec §5–§12 minus the `'receipt-poll-fallback'`
  lostSignalPolicy strategy (the type is accepted; the runtime
  falls back to `'emit-uncertain'` and a follow-up PR adds the
  per-block receipt fetch path).
- Predicate bulk selectors are silently non-durable per spec §13.2
  (closures don't survive a process boundary). The tracker logs a
  warning via `onError` when a `predicate` selector is registered
  with `durable: true` and persists everything else about the
  selector.
- `gas-oracle` and `tx-tracker` remain siblings — neither imports
  the other; both consume `@valve-tech/chain-source` directly.

## [0.6.0] — 2026-05-05

### Notes

- Synchronized release — no functional changes to this package
  (still a stub on npm). Bumped in lockstep with
  `@valve-tech/chain-source@0.6.0` (block-stream dedup + head-probe
  gating in the source tick) and `@valve-tech/gas-oracle@0.6.0`
  (now consumes ChainSource via `source?: ChainSource`). The
  tx-tracker implementation track lands in a future minor — this
  version exists to keep the synced version line consistent across
  the toolkit.

## [0.5.0] — 2026-05-05

### Notes

- Synchronized release — no changes to this package (still an
  `export {}` stub). Bumped in lockstep with
  `@valve-tech/wallet-adapter@0.5.0`, whose enriched `WriteHookParams`
  / `WritePhaseEvent` shapes are the contract this package will fire
  `onDropped` and `onReplaced` against once it ships. See the
  wallet-adapter changelog for the migration details.

## [0.4.1] — 2026-05-04

### Notes

- Synchronized release — no changes to this package. Bumped in
  lockstep with `@valve-tech/wallet-adapter@0.4.1` which fixes the
  `workspace:^` leak in its published manifest. See that package's
  changelog for details.

## [0.4.0] — 2026-05-04

### Notes

- Synchronized release — no changes to this package. Bumped in
  lockstep with the rest of the toolkit, which adds two new packages:
  `@valve-tech/viem-errors` (cause-chain error utilities) and
  `@valve-tech/wallet-adapter` (wallet contract + lifecycle hooks).
  The contract additions in `wallet-adapter` (notably `onDropped` /
  `onReplaced` hooks plus the `WritePhase` discriminated union) are
  designed to be the consumer-facing surface that this tracker fires
  against once its v0.3.x implementation lands.

## [0.3.1] — 2026-05-04

> **First fully-synchronized release.** Part of the
> `valve-tech/evm-toolkit` v0.3.1 synchronized release line. All
> three packages in the toolkit (`@valve-tech/chain-source`,
> `@valve-tech/gas-oracle`, `@valve-tech/tx-tracker`) ship in
> lockstep from this version onwards under a single `vX.Y.Z` tag.

### Notes

- v0.3.1 contents are byte-identical to the planned v0.3.0 — still
  a name reservation and minimal scaffold (the `index` exports
  nothing). The actual per-tx state machine (the `TxEvent`
  discriminated union, `TxTrackerStore` interface + in-memory
  default, bulk-subscription matchers, reorg detector, three
  consumption shapes) lands in subsequent 0.3.x releases per the
  design contract in
  [`docs/tx-tracker-spec.md`](https://github.com/valve-tech/evm-toolkit/blob/main/docs/tx-tracker-spec.md).
- v0.3.0 was tagged but did not publish to npm — the toolkit-wide
  release workflow failed at the gas-oracle publish step (OIDC
  trusted-publisher mismatch from the repo rename) and aborted
  before reaching this package. The publisher record was fixed and
  v0.3.1 re-releases all three packages.
- `viem ^2.0.0` is the only peer dependency. The dependency on
  `@valve-tech/chain-source` will be declared once the implementation
  actually imports it (subsequent 0.3.x release).

## [0.3.0] — 2026-05-04 — *unpublished; superseded by 0.3.1*

> Tagged but never published to npm — the toolkit's release workflow
> aborted before reaching this package's publish step (see Notes
> above). Superseded by v0.3.1 which carries identical content.

## [0.0.1] — 2026-05-04 — *initial name-reservation publish*

> Manually published from a maintainer's machine during the toolkit
> rename + first-publish setup. No content — `index` exports nothing.
> Superseded by the v0.3.x synchronized line.
