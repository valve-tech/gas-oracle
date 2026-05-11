# Changelog

All notable changes to `@valve-tech/tx-flight-react` are documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.12.0] — 2026-05-11

### Notes

- Synchronized release — no consumer-visible changes to this
  package's published surface. Bumped in lockstep alongside the
  v0.12.0 feature work in `@valve-tech/chain-source` (new
  `getBlockByHash` API) and `@valve-tech/gas-oracle` (reorg-side
  ring-lifecycle backfill that uses it).

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
  0.11.0) — which `tx-flight-react` consumes transitively, so
  consumers running tx-flight-react with a persistent storage
  adapter (`localStorageAdapter` / `indexedDBAdapter`) on top of an
  upgraded tx-tracker should bump to this version. See
  `@valve-tech/tx-tracker`'s CHANGELOG for details.

## [0.11.0] — 2026-05-11

### Notes

- Synchronized release — no changes to this package. Bumped in
  lockstep with the rest of the toolkit alongside the v0.11.0
  feature work in `@valve-tech/gas-oracle` (20-block ring lifecycle,
  reorg detection, gap bridging), `@valve-tech/tx-tracker` (audit
  fixes — durable rehydrate, retention enforcement, replaced-by
  dedup, receipt-poll race, helper extraction), `@valve-tech/
  wallet-adapter` (five wallet bridge examples), and
  `@valve-tech/chain-source` (canonical-owner docs for wire types).

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

**First OIDC-driven publish for this package**, jumping straight
from the 0.0.1 name-claim. Package contents are identical to
v0.9.2's intended tarball — v0.9.2's workflow run completed
successfully but skipped this package because
`.github/workflows/release.yml` had no `Publish` step for it
(scaffolding oversight). v0.9.3 adds that step and republishes
all six packages from the same tag.

## [0.9.2] — 2026-05-08

*Not published — the Release workflow's build step succeeded but
the workflow file had no publish step for `@valve-tech/tx-flight-react`,
so the tarball was never uploaded. Superseded by v0.9.3, which
adds the missing workflow step and is this package's first real
OIDC-driven publish.* Synchronized release; no changes to this
package itself.

## [0.9.1] — 2026-05-08

*Not published — the Release workflow's Build step failed for the
same reason as v0.9.0. Adding the workspace siblings to
`devDependencies` did declare the dep relationship, but the root
`build` script's `--topological` flag only follows `dependencies`,
so the build ordering didn't actually change. v0.9.2 fixes this by
switching to `--topological-dev`.*

### Fixed
- Workspace builds in clean CI environments. The sibling packages
  `@valve-tech/chain-source`, `@valve-tech/tx-tracker`, and
  `@valve-tech/wallet-adapter` were declared only as
  `peerDependencies` (with `peerDependenciesMeta.optional: true`)
  in v0.9.0, so a fresh `yarn install` in CI didn't link their
  type declarations into this package's `node_modules` and `tsc -p .`
  failed with `TS2307: Cannot find module '@valve-tech/wallet-adapter'`
  (and the same for `tx-tracker`). They are now also declared as
  `devDependencies: workspace:^` so the workspace types resolve
  during build. No effect on consumers — peer-deps remain optional;
  this only changes how the package builds itself in the monorepo.

## [0.9.0] — 2026-05-08

First fully-functional release. Lands the entire React UI primitive
surface for an in-flight transaction strip:

### Added
- `<TxFlightProvider>` — wraps the React tree; multi-instance scoping
  via `id` (two providers with the same id share state via refCount).
  Pluggable persistence (`storage` prop), eviction tick
  (`maxItems` + `terminalRetentionMs`), error sink (`onError`), and an
  optional `clientFactory` for rehydrate watcher revival.
- `useTxFlight(id?)` hook with three add methods, each with its own
  return type (no overloaded discriminated union):
  - `addWithWalletAdapter(input)` → `{ id, hooks }`. Wraps the
    consumer's `WriteHookParams` so each phase fans out to BOTH the
    user's original callback AND a store update. Wallet-adapter is
    statically imported (types only — no runtime bundle cost).
  - `addByHash(input)` → `Promise<string>`. Dynamic-imports
    `@valve-tech/tx-tracker` + `@valve-tech/chain-source` (optional
    peer deps), builds a private ChainSource + TxTracker, routes
    every event into a TrackedTx patch.
  - `addManual(input)` → `string`. For back-fill (server push,
    observed-elsewhere txs).
- Headless components, all `className` + `style` overridable:
  - Layout: `<TxFlightList>` (reactive newest-first list,
    `filter`/`sort`/`render`/`empty` props), `<TxFlightItem>` (default
    icon + hash + age + actions layout, `render` prop swaps it).
  - Atomic: `<TxFlightStatusIcon>`, `<TxFlightHashLink>`,
    `<TxFlightAge>`, `<TxFlightActions>`.
- Pluggable storage adapters at `@valve-tech/tx-flight-react/storage`:
  `localStorageAdapter` (default, SSR-safe), `indexedDBAdapter`,
  `memoryAdapter`. Custom adapters satisfy the two-method
  `TxFlightStorage` interface. Bigint-safe JSON serializer for
  `TrackedTx.submittedGas`.
- Persistence + rehydrate semantics:
  - `pending` with `hash` AND `clientFactory` wired → async-attach a
    fresh tx-tracker watcher; failures route to
    `onError('rehydrate-watcher', ...)`.
  - `preparing` / `awaiting-signature` → translated to `failed` with
    `notes: 'lost during reload'`.
  - Terminals preserved until eviction prunes them.
- SSR / RSC: Provider is `'use client'`. Pure-renderer atomic
  components (StatusIcon / HashLink / Actions / Item) are RSC-safe.
  `<TxFlightAge>` and `<TxFlightList>` are client-only. Storage
  adapters no-op on the server. Verified by a dedicated
  `@vitest-environment node` suite.

### Coverage
100/100/100/100 stmts/branches/funcs/lines from the first test-bearing
commit forward.

## [0.0.1] — 2026-05-08

Name-claim publish so the npm trusted-publisher record can be wired
before the synced v0.9.0 release. No usable surface — the package
exports its types but the implementation lands at v0.9.0.
