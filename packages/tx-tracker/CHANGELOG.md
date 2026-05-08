# Changelog

All notable changes to `@valve-tech/tx-tracker` are documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.9.2] — 2026-05-08

Synchronized release — no changes to this package. Companion fix
to v0.9.1: the root `build` script now uses `--topological-dev`
so workspace `devDependencies` (added to `tx-flight-react` in
v0.9.1) actually drive build ordering. v0.9.2 is the first version
of the v0.9.x line to land on npm for this package.

## [0.9.1] — 2026-05-08

*Not published — the Release workflow's Build step failed for the
same reason as v0.9.0. Superseded by v0.9.2.* Synchronized release;
no changes to this package itself.

## [0.9.0] — 2026-05-08

Synchronized release — no changes to this package. Bumped in lockstep
with the rest of the toolkit, alongside the new
`@valve-tech/tx-flight-react` package. *Not published — the Release
workflow's build step failed before publish; superseded by v0.9.1.*

## [0.8.1] — 2026-05-07

### Added
- `chainId` option on `watchTransaction` / `waitForTransaction` / `waitForPending`. Echoes through to `event.chainId` so consumers fanning multiple watchers into a single multi-chain stream can disambiguate. Falls back to `client.chain?.id`, then `0`.

### Changed
- `replaceTransaction` no longer passes `chain: null`, which silently disabled viem's `assertChainId` network-mismatch check. Now defers to `walletClient.chain` (passing `null` only when the wallet has no chain set, the only case viem requires it). `original.chainId` is threaded through as the top-level `chainId` field — the field is now load-bearing for EIP-155 signing and chain assertion. If a caller's wallet client and `original.chainId` disagree, viem throws.

### Removed
- Dead `_eventSource` parameters from internal `runBulkOnBlock` / `runBulkOnMempool`. No effect on public API.

### Notes
- Code-quality cleanup: removed three unreachable defensive guards from `tracker.ts` and `reorg.ts` that were marked with `c8 ignore` annotations. One pre-existing annotation remains (`tracker.ts:1083` invariant throw, kept for TS return-type narrowing). 100/100/100/100 coverage holds.

## [0.8.0] — 2026-05-06

### Added
- `lostSignalPolicy: { strategy: 'receipt-poll-fallback', pollEveryBlocks: N }` runtime. Closes the type-vs-runtime gap from v0.3.x — when a tracked subscription is in a degraded state, the tracker fetches `getReceipt` every N block ticks and emits `seen-in-block` with `source: 'receipt-poll'` on hit. Capability gate: requires `receiptByHash === 'available'`.
- `withReceipts: true` opt-in receipt enrichment on `TrackOptions`. When set, the tracker pre-fetches the receipt before the per-record block decision and attaches it to `seen-in-block` events via the new `TxEventSeenInBlock.receipt` field. One emit per inclusion — receipt is on the first event, not a follow-up.
- `tracker.group(hashes, options?)` — cross-tx correlation (spec §18.1). Emits `group-progress` / `group-complete` / `group-failed` / `group-stopped` derived from per-member event streams. Replacement does NOT auto-promote.
- `watchTransaction({ client, hash, ... })` — one-shot callback convenience export.
- `waitForTransaction({ client, hash, ... })` — Promise variant of `watchTransaction`. Resolves with discriminated-union outcome (`mined` / `dropped` / `replaced` / `failed`).
- `waitForPending({ client, hash, timeoutBlocks })` — Promise that resolves on first `seen-in-mempool`; rejects with typed `WaitForPendingTimeoutError` if the hash isn't observed within `timeoutBlocks`.
- `replaceTransaction({ original, walletClient, newGas })` — same-nonce replacement primitive. Caller-provides-newGas keeps tx-tracker independent of `@valve-tech/gas-oracle`.

### Changed
- `onBlock` is now async to support pre-fetching receipts before the per-record decision. Stale-block guard added against the resulting interleave window so a delayed pre-fetch can't clobber state advanced by a concurrent block tick.
- `decideBlockObservation` accepts an optional `prefetchedReceipts: ReadonlyMap<Hash, TransactionReceipt>` parameter (backward-compatible — existing callsites omit it).

## [0.7.0] — 2026-05-06

> **The implementation lands.** This is the first release of
> `@valve-tech/tx-tracker` with a real public surface. Prior versions
> (v0.0.1 → v0.6.0) were stubs reserving the npm name. The full
> design contract is at `docs/tx-tracker-spec.md` in the
> `valve-tech/evm-toolkit` repo.

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
- **`AGENTS.md`** + **`skills/tx-tracker-integration/SKILL.md`** for AI
  agents working in downstream projects that import the package. Both
  ship in the npm tarball; the SKILL.md trigger phrases catch
  "track this transaction," "watch tx hash," "stuck transaction," and
  composition questions with `@valve-tech/gas-oracle`.

### Changed

- **Coverage hardening pre-1.0.** Eliminated dead defensive branches
  in `reorg.ts` (sort-comparator equal-key arms unreachable after
  the dedup `filter`; `?? 0n` defaults unreachable after the empty-
  array early return). Tightened `capabilityRank`'s input type from
  `string` to a `CapabilityValue` union literal so the switch is
  exhaustive without a default arm.
- **Test suite up from 75 → 95 tests** (+20). New coverage:
  `trackToAddress`, per-subscription `lostSignalPolicy` overrides,
  durable-subscription persistence (with stub stores), predicate-
  selector + `durable: true` warning, store.appendEvent / store.put
  failure routing through `onError`, bad-block-number handling,
  async iterator queue-vs-waiter ordering and early-break cleanup,
  bulk async iterator drain via `sub.stop()`, multi-sub-on-same-hash
  cleanup semantics, idempotent `stop` / `unsub` / `sub.stop`,
  reorg handler skipping records without `lastSeenInBlock`,
  `findReplacement` raw-nonce fallback when `BigInt()` throws,
  `lifecycle: 'lazy'` accepts-the-option contract.
- Coverage went **89.23% / 78.59% / 92.13% / 91.84%** stmts / branches
  / funcs / lines → **96.13% / 88.93% / 98.87% / 97.61%**, then to
  **97.22% / 92.7% / 98.9% / 98.12%** after the per-record decision
  logic was extracted into pure functions (see "Refactor" below).

### Refactor

- **Per-record decision logic extracted from `tracker.ts` into a new
  pure module `observations.ts`.** The previous shape — two giant
  closures inside `onBlock` / `onMempool` mutating shared state and
  emitting events as a side effect — was a pile of conditionals that
  could only be tested by spinning up the full state machine through
  a stub source. Now `decideBlockObservation` and
  `decideMempoolObservation` are pure functions: literal inputs in,
  `{ events, statusPatch, identityPatch, inMempoolPatch }` out. The
  orchestrator in `tracker.ts` shrank to "compute envelope, loop
  records, call decision fn, merge patch, emit events." Same shape
  as the rest of the toolkit (`reducePollInputs` pure / poll loop
  stateful in gas-oracle; math pure / source stateful in chain-source).
  - **`observations.ts` lands at 100% statements / 100% branches**
    (67/67 stmts, 55/55 branches) covered by 33 fixture-driven unit
    tests in `observations.test.ts`. Each per-record decision arm
    has a dedicated test with literal inputs — no async, no stubs,
    no shared state.
  - `tracker.ts` shrank from 374 statements → 344 (the extracted
    code is gone) and is now mostly orchestration; its branch
    coverage rose from 86.69% → 88.75%.
  - `findReplacement` (closure-based) replaced with pure
    `findReplacementInMempool(snapshot, identity, originalHash)`.
    `cacheIdentityFromTx` (mutation-based) replaced with pure
    `cacheIdentity(current, tx)` returning a patch.
  - **No behavior change.** All 95 pre-refactor integration tests
    continue to pass unchanged; the refactor is internal-only and
    the public API surface is identical.
  - Tracker test suite: 95 → 133 (+38: 33 from `observations.test.ts`
    plus 5 new tracker integration tests covering reorg height-mismatch
    skip and async-iterator multi-waiter drain paths).

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
