# Changelog

All notable changes to `@valve-tech/chain-source` are documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.13.0] — 2026-05-12

### Changed

- `EventSource` doc comment for the `'receipt-poll'` discriminator
  widened. Previously described only the receipt-poll fallback path;
  now explicitly covers any per-hash mined check that isn't the
  source's own block-poll. `@valve-tech/tx-tracker` v0.13.0 uses
  this discriminator for both its existing `receipt-poll-fallback`
  lost-signal policy AND its new
  `TrackOptions.probeMined` per-subscription consumer-supplied probe.
  The type value itself is unchanged — `'receipt-poll'` is still the
  same string literal in the discriminated union. No consumer
  migration required.

### Notes

- The widening reflects how the discriminator is actually consumed:
  it has always meant "per-hash mined check, not from the canonical
  block stream," and `buildVanishedFromBlock`'s spec §12.3 rejection
  of this source has always been the authoritative constraint.
  Consumers who already gate UI / business logic on
  `event.source === 'receipt-poll'` will see the same set of events
  they always have, plus any newly-arriving probe-derived events
  from consumers that opt into the tx-tracker probe API.

## [0.12.0] — 2026-05-11

### Added

- `ChainSource.getBlockByHash(hash)` — on-demand fetch of a block by
  its hash. Companion to `getBlock(tag)`, but returns the block at
  the hash even if it's no longer canonical. Required for any
  consumer that walks a reorged-away branch via parentHash chains
  (`@valve-tech/gas-oracle`'s reorg-side backfill in v0.12.0 uses
  it). `safeRequest`-shaped — returns `null` on transport error or
  if the upstream no longer carries the hash (deep reorg, pruned
  archive).
- `fetchBlockByHash(client, hash, onError?)` — top-level transport
  helper for direct use (mirrors `fetchBlock`). Exported from the
  package root for replay harnesses and tests that bypass the
  full source.

## [0.11.2] — 2026-05-11

### Notes

- Synchronized release — no changes to this package. Republished at
  0.11.2 alongside the rest of the toolkit; the substantive fix is
  in `@valve-tech/tx-tracker` (posture-consistency follow-up to
  v0.11.1 — two additional strict-null read sites on persisted
  `TxStatus` fields tightened defensively). See
  `@valve-tech/tx-tracker`'s CHANGELOG for details.

## [0.11.1] — 2026-05-11

### Notes

- Synchronized release — no changes to this package. Republished at
  0.11.1 alongside the rest of the toolkit; the substantive fix is
  in `@valve-tech/tx-tracker` (upgrade-path crash on the first
  block tick after upgrading a persistent store from ≤0.10 to
  0.11.0). See `@valve-tech/tx-tracker`'s CHANGELOG for details.

## [0.11.0] — 2026-05-11

### Changed

- Doc comment in `src/types.ts` no longer describes the
  gas-oracle import migration as "future" — the migration shipped
  in this same release. Comment now states that this package is the
  canonical owner and gas-oracle re-exports from `index.ts`. No
  type-shape change.

## [0.10.1] — 2026-05-08

Synchronized release — no changes to this package. Republished at
0.10.1 alongside the rest of the toolkit; v0.10.0 only got
trueblocks-sdk publishing wrong (missing `repository` field tripped
provenance validation), so the rest of the line had to bump to
re-sync.

## [0.10.0] — 2026-05-08

Synchronized release — no changes to this package. Republished at
0.10.0 alongside the rest of the toolkit. The minor bump (rather
than patch) reflects the addition of a new sibling package,
`@valve-tech/trueblocks-sdk`, to the synced release line.

## [0.9.3] — 2026-05-08

Synchronized release — no changes to this package. Republished at
0.9.3 alongside the rest of the toolkit so all six packages share
one synced version line on npm. v0.9.2 had published this package
successfully but skipped `tx-flight-react` (workflow file was
missing a publish step); v0.9.3 fixes that and re-publishes
everything from one tag.

## [0.9.2] — 2026-05-08

Synchronized release — no changes to this package. Companion fix
to v0.9.1: the root `build` script now uses `--topological-dev`
so workspace `devDependencies` (added to `tx-flight-react` in
v0.9.1) actually drive build ordering. First version of the v0.9.x
line on npm for this package, but the toolkit-wide v0.9.x line
didn't reach all six packages until v0.9.3.

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

Synchronized release — no changes to this package. Bumped in lockstep with the rest of the toolkit.

## [0.8.0] — 2026-05-06

### Added
- WS subscribe path for `subscribeBlocks`. When `capabilities.newHeads === 'subscription'`, the source opens `eth_subscribe('newHeads')` lazily on `start()` and pipes head events through the existing fetchBlock + dedup-by-hash machinery. Push and poll coexist safely.
- WS subscribe path for `subscribeMempool` with hash-only normalization. Push delivers a hash; the source fetches the full tx via `getTransaction` and emits a single-tx `NormalizedMempool` snapshot so consumers see one shape regardless of source.
- Live-probe at capability-detection time. `probeCapabilities` now performs one opportunistic `eth_subscribe('newHeads')` round-trip to confirm the transport actually supports subscribe, returning `'subscription' | 'poll-only' | 'unavailable'` truthfully. Failure downgrades to `'poll-only'` and surfaces via `onError`.

### Changed
- Internal: extracted shared `wsTransport` cast; consolidated WS-subscribe error method names to `'eth_subscribe.<channel>'` for both setup-failure and stream-error paths.

## [0.7.0] — 2026-05-06

### Notes

- Synchronized release — no consumer-visible changes to this package.
  Bumped in lockstep with `@valve-tech/tx-tracker@0.7.0`, the
  long-promised v0.3.x track ChainSource was built to feed (per
  `docs/tx-tracker-spec.md` §3.1). chain-source itself stays
  byte-identical with v0.6.0's dist; this release exists so
  consumers running `npm view @valve-tech/chain-source versions`
  see the toolkit-wide line is at v0.7.0.
- Internal-only: the workspace test suite is now at 100/100/100/100
  coverage on this package (was 97/97/97/98). No new exports, no
  behavior change.

## [0.6.0] — 2026-05-05

### Added

- **`createChainSource({ client, pollIntervalMs?, poll?, onError? })`** —
  the canonical `ChainSource` primitive lands. Implements the
  `subscribe / on-demand / capabilities / lifecycle` contract from
  [`docs/tx-tracker-spec.md`](https://github.com/valve-tech/evm-toolkit/blob/main/docs/tx-tracker-spec.md)
  §3.2.
- **`subscribeBlocks(cb)` / `subscribeMempool(cb)`** — first-class
  multi-subscriber streams. One upstream poll cycle fans out to every
  attached subscriber. Returns an idempotent unsubscribe handle.
- **On-demand RPCs:** `getBlock(tag)`, `getFeeHistory(blockCount, percentiles)`,
  `getMempoolSnapshot()` (returns the normalized form), `getReceipt(hash)`,
  `getTransaction(hash)`. Each follows the `safeRequest`-returns-null
  posture — never throws across the boundary.
- **`probeCapabilities(client)`** + cached `capabilities()` accessor.
  The probe runs eagerly at construction; `await source.ready()`
  guarantees the cached snapshot is populated before reading.
  Per-method discrimination (`newHeads` / `newPendingTransactions` /
  `txpoolContent` / `receiptByHash`) honors the "no silent downgrade"
  invariant from §2.2 of the spec.
- **`Subscriptions<E>`** — hand-rolled typed pub/sub primitive,
  browser/mobile-safe (no Node `events` dependency). Per-subscriber
  throws are swallowed so a single bad consumer cannot affect
  delivery to the others; emit fans out to a snapshot of subscribers
  taken at the start of the call so mid-emit registration changes
  are deferred to the next emit.
- **Type re-exports** of `BlockResult`, `Capabilities`, `EventSource`,
  `FeeHistoryResult`, `NormalizedMempool`, `PollOptions`, `RawTx`,
  `TransactionReceipt`, `TxPoolContent`. These are the wire-format
  contracts used by `@valve-tech/gas-oracle` and `@valve-tech/tx-tracker`
  in their v0.3.x migrations.
- **Additive method on the spec'd interface: `pollOnce()`**. Drives one
  cycle out-of-band; useful for serverless / manual-refresh flows and
  for deterministic test setups that don't want to engage fake
  timers.

### Changed

- **`subscribeBlocks` now dedups by `block.hash`.** Previously, every
  successful tick fanned out to block subscribers regardless of
  whether the head had advanced; on a static head that meant an emit
  every `pollIntervalMs`. The stream now only emits when the observed
  block hash differs from the last one delivered. Hash-based (not
  number-based) so a same-height reorg surfaces as a fresh
  observation. Dedup state resets on `stop()` — a paused-then-resumed
  source emits a current snapshot to its consumers on first re-tick
  rather than waiting for the next chain block. `subscribeMempool` is
  intentionally not deduped — txs come and go between blocks even on
  a static head, so every successful snapshot remains fresh data.
- **The poll cycle now head-probe-gates the full block fetch.** Each
  tick runs a cheap `eth_blockNumber` probe in parallel with the
  mempool fetch; only when the probe shows the head has advanced (or
  the probe failed and we're falling through defensively) does the
  cycle issue the expensive `eth_getBlockByNumber('latest', true)`
  (1–5MB on busy chains). On a static head with the default 10 s
  interval, the per-tick RPC weight drops from "full block + mempool
  + probe" to "probe + mempool". Mempool fetch still runs every
  cycle. Closes the efficiency-regression risk for the upcoming
  gas-oracle migration to consume `ChainSource` (the soon-to-be-
  deprecated `gas-oracle.blockGatedPolling` option had this behavior
  in v0.5.0; it now lives at the source layer where every consumer
  benefits).

### Notes

- WebSocket push subscriptions (`eth_subscribe('newHeads')` /
  `eth_subscribe('newPendingTransactions')`) are not yet wired in this
  release. The capability probe discloses what the transport
  *structurally* supports, but the source always uses its interval
  poll cycle in this revision. A future release adds the push path
  without changing the consumer-facing surface.
- `gas-oracle` and `tx-tracker` migrations to consume `ChainSource`
  land in subsequent PRs of the same v0.3.x track. Until those merge,
  this package is consumable directly but its sibling packages keep
  their v0.3.0 standalone behavior.

## [0.5.0] — 2026-05-05

### Notes

- Synchronized release — no changes to this package. Bumped in
  lockstep with `@valve-tech/wallet-adapter@0.5.0`, which gains rich
  `TxContext` payloads on every lifecycle event (chainId + request +
  block) so downstream consumers don't have to re-fetch what the
  helper already has in scope. See that package's changelog for the
  breaking-change details.

## [0.4.1] — 2026-05-04

### Notes

- Synchronized release — no changes to this package. Bumped in
  lockstep with `@valve-tech/wallet-adapter@0.4.1` which fixes the
  `workspace:^` leak in its published manifest. See that package's
  changelog for details.

## [0.4.0] — 2026-05-04

### Notes

- Synchronized release — no changes to this package. Bumped in
  lockstep with the rest of the toolkit, which adds two new packages
  (`@valve-tech/viem-errors` and `@valve-tech/wallet-adapter`). The
  v0.3.x ChainSource implementation track is unaffected by this
  release and remains in flight under PR #12; it will land in a
  subsequent version.

## [0.3.1] — 2026-05-04

> **First fully-synchronized release.** v0.3.0 was a partial publish:
> `@valve-tech/chain-source@0.3.0` made it onto npm, but the
> simultaneous `@valve-tech/gas-oracle@0.3.0` publish failed with an
> OIDC trusted-publisher mismatch (the gas-oracle record was pinned
> to the pre-rename `valve-tech/gas-oracle` repo, not the renamed
> `valve-tech/evm-toolkit`). The trusted-publisher record was fixed
> and v0.3.1 re-publishes all three packages at the same version to
> restore synced state.

### Notes

- No functional change vs. v0.3.0. This package's contents are
  byte-identical (still an `export {}` stub for the v0.3.x
  implementation roadmap).
- Use v0.3.1 over v0.3.0 — they're identical in this package, but
  v0.3.1 is the version where every toolkit package ships at the
  same number.

## [0.3.0] — 2026-05-04 — *partially published; superseded by 0.3.1*

> Published successfully here, but the simultaneous publishes for
> `@valve-tech/gas-oracle` and `@valve-tech/tx-tracker` did not land
> (npm OIDC trusted-publisher mismatch on gas-oracle, which then
> aborted the workflow before tx-tracker). All three packages were
> re-released as v0.3.1 to restore synced state.
>
> The v0.3.0 tarball remains on npm and is byte-identical to v0.3.1
> for this package.

### Added

- `@valve-tech/chain-source` published. **This release is a name
  reservation and minimal scaffold** — the package's `index` exports
  nothing yet; the actual implementation of the `ChainSource`
  primitive (capability probing, push-or-poll fan-out for blocks
  and mempool, on-demand `getReceipt` / `getTransaction`,
  multi-subscriber lifecycle gating) lands in subsequent 0.3.x
  releases per the design contract in
  [`docs/tx-tracker-spec.md`](https://github.com/valve-tech/evm-toolkit/blob/main/docs/tx-tracker-spec.md).

### Notes

- First release of this package. No published predecessor on npm.
- The version starts at `0.3.0` rather than `0.1.0` because the
  toolkit converted to synchronized versioning at this release — all
  three packages share the same version going forward.
- `viem ^2.0.0` is the only peer dependency. No runtime deps.
