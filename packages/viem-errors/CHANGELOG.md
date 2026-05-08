# Changelog

All notable changes to `@valve-tech/viem-errors` are documented in
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
