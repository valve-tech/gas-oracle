# Changelog

All notable changes to `@valve-tech/chain-source` are documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
