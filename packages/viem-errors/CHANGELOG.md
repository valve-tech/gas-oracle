# Changelog

All notable changes to `@valve-tech/viem-errors` are documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.16.0] — 2026-05-15

### Notes

- Synchronized release — no changes to this package. Republished at
  0.16.0 alongside the rest of the toolkit; the substantive changes
  are in `@valve-tech/chain-source` (adaptive polling + `Logger` +
  `estimateBlockTimeMs` helper) and `@valve-tech/tx-tracker` (logger).
  See the respective CHANGELOGs for details.

## [0.15.0] — 2026-05-14

### Notes

- Synchronized release — no changes to this package. Republished at
  0.15.0 alongside the rest of the toolkit; the substantive changes
  are in `@valve-tech/tx-tracker` (mined-confirmed terminal transition,
  persisted-subscription dedup, first-party localStorage store,
  receipt-poll-fallback silent gate during capability probe) and
  `@valve-tech/chain-source` (new `Capabilities.ready: boolean` field).
  See the respective CHANGELOGs for details.

## [0.14.0] — 2026-05-14

### Notes

- Synchronized release — no changes to this package. Republished at
  0.14.0 alongside the rest of the toolkit; the substantive change
  is in `@valve-tech/tx-tracker` (new default-on `statusPollEveryBlocks`
  per-hash status poll via `eth_getTransactionByHash` + per-subscription
  `probeTransaction` fallback). See `@valve-tech/tx-tracker`'s
  CHANGELOG for details.

## [0.13.0] — 2026-05-12

### Notes

- Synchronized release — no changes to this package. Republished at
  0.13.0 alongside the rest of the toolkit; the substantive change
  is in `@valve-tech/tx-tracker` (new `TrackOptions.probeMined`
  consumer-supplied mined-detection probe). See
  `@valve-tech/tx-tracker`'s CHANGELOG for details.

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
  0.11.0). See `@valve-tech/tx-tracker`'s CHANGELOG for details.

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

### Removed
- Defensive `link === null || link === undefined` guard in `isUserRejectionError`. `walkErrorCause`'s generator returns when the current link is nullish (`walk.ts:34`), so it never yields null/undefined — the guard was unreachable. No effect on public behavior; 100/100/100/100 coverage holds.

## [0.8.0] — 2026-05-06

Synced version bump; no functional changes.

## [0.7.0] — 2026-05-06

### Notes

- Synchronized release — no consumer-visible behavior changes.
  Bumped in lockstep with `@valve-tech/tx-tracker@0.7.0` (the
  first real implementation release of the per-tx state machine).
  Internal-only: a `/* c8 ignore */` annotation was added inside
  `isUserRejectionError` for an unreachable defensive guard
  (`walkErrorCause`'s contract is to never yield nullish links);
  doesn't change behavior.

## [0.6.0] — 2026-05-05

### Notes

- Synchronized release — no changes to this package. Bumped in
  lockstep with `@valve-tech/chain-source@0.6.0` (block-stream
  dedup + head-probe gating in the source tick) and
  `@valve-tech/gas-oracle@0.6.0` (now consumes ChainSource via
  `source?: ChainSource`).

## [0.5.0] — 2026-05-05

### Notes

- Synchronized release — no changes to this package. Bumped in
  lockstep with `@valve-tech/wallet-adapter@0.5.0`, which gains rich
  `TxContext` payloads on every lifecycle event. See that package's
  changelog for the breaking-change details. The
  `@valve-tech/wallet-adapter` runtime continues to depend on
  `@valve-tech/viem-errors` at the synced semver range.

## [0.4.1] — 2026-05-04

### Notes

- Synchronized release — no changes to this package. Bumped in
  lockstep with `@valve-tech/wallet-adapter@0.4.1` which fixes the
  `workspace:^` leak in its published manifest. See that package's
  changelog for details.

## [0.4.0] — 2026-05-04

### Added

- Initial implementation. Functions extracted from a real-world dapp
  (Provex) where they had been re-derived inline; this is the first
  upstream packaging for general use.
  - `walkErrorCause(error, options?)` — generator over the viem
    cause chain. Default `maxDepth: 8`.
  - `isUserRejectionError(error)` — three-signal check across the
    cause chain (EIP-1193 `code === 4001`, class name
    `UserRejectedRequestError`, message regex fallback).
  - `USER_REJECTION_MESSAGE` — default rejection copy.
  - `extractContractErrorName(error)` — finds decoded custom
    Solidity error names on `data.errorName` anywhere in the cause
    chain.
  - `extractContractErrorNameFromMessage(raw)` — scrape fallback for
    flattened messages.
  - `getUserFriendlyErrorMessage(error, options?)` — pipeline:
    rejection → decoded custom error → consumer patterns → default
    patterns → fallback.
  - `DEFAULT_ERROR_PATTERNS` — protocol-agnostic patterns
    (wallet / gas / replacement / network / rate-limit / revert).
  - `handleWalletError(error, options)` — wagmi `onError`-shape
    sink with separate rejection vs real-error paths.
- 49 unit tests covering cause-chain traversal, rejection detection,
  custom-error extraction, message mapping, override precedence, and
  sink routing.
