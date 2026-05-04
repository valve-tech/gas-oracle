# Changelog

All notable changes to `@valve-tech/chain-source` are documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.3.0] — 2026-05-04

> **First release.** Part of the `valve-tech/evm-toolkit` v0.3.0
> synchronized release line. All three packages in the toolkit
> (`@valve-tech/chain-source`, `@valve-tech/gas-oracle`,
> `@valve-tech/tx-tracker`) ship in lockstep from this version
> onwards under a single `vX.Y.Z` tag.

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

- The version starts at `0.3.0` rather than `0.1.0` because the
  toolkit converted to synchronized versioning at this release — all
  three packages share the same version going forward. This package
  has no published predecessor on npm; consumers can treat `0.3.0`
  as the initial release.
- `viem ^2.0.0` is the only peer dependency. No runtime deps.
