# Changelog

All notable changes to `@valve-tech/tx-tracker` are documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
