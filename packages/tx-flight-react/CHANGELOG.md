# Changelog

All notable changes to `@valve-tech/tx-flight-react` are documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
