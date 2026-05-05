# Changelog

All notable changes to `@valve-tech/gas-oracle` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.5.0] — 2026-05-05

### Notes

- Synchronized release — no changes to this package. Bumped in
  lockstep with `@valve-tech/wallet-adapter@0.5.0`, which gains rich
  `TxContext` payloads on every lifecycle event (chainId + request +
  block). See that package's changelog for the breaking-change
  details.

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

## [0.3.1] — 2026-05-04

> **First fully-synchronized release in the `valve-tech/evm-toolkit`
> monorepo.** All three packages
> (`@valve-tech/chain-source`, `@valve-tech/gas-oracle`,
> `@valve-tech/tx-tracker`) now ship in lockstep. Future releases use
> a single `vX.Y.Z` tag on the repo.

### Notes

- v0.3.1 carries the same content as the planned v0.3.0 (idle-traffic
  controls — see the v0.3.0 entry below for the full feature list).
- v0.3.0 was a partial-publish workflow run: this package's publish
  step failed with an OIDC trusted-publisher mismatch (the npm
  trusted-publisher record was still pinned to the pre-rename
  `valve-tech/gas-oracle` repo and didn't match the renamed
  `valve-tech/evm-toolkit`). The publisher record was fixed; v0.3.1
  is the first version of this package on npm in the v0.3.x line.

## [0.3.0] — 2026-05-04 — *unpublished; superseded by 0.3.1*

> Tagged but never published to npm — the OIDC trusted-publisher
> mismatch above blocked this version's publish. Other packages in
> the toolkit had partial outcomes for v0.3.0; see their CHANGELOGs
> for details. v0.3.1 re-releases all three packages in lockstep
> with this same content.

### Added
- `pauseWhenIdle` option on `CreateGasOracleOptions` (default `true`).
  The poll loop is now gated on having at least one active subscriber
  — `start()` is still called explicitly, but the loop only fires
  RPC calls when a subscriber is attached. The 0 → 1 subscriber
  transition triggers an immediate cycle plus interval start; the
  n → 0 transition pauses (subject to `staleAfter`). Set `false` to
  restore the v0.2.5 always-poll-after-start behavior.
- `staleAfter` option (ms; default `0`) — keeps the loop alive for
  the specified window after the last unsubscribe. Useful for
  "snappy UI re-mount" where a component unmounts then re-mounts
  briefly (route transitions). Cached state stays warm during the
  window.
- `blockGatedPolling` option (default `true`). Each tick first fires
  a cheap `eth_blockNumber` probe; if the head hasn't moved since
  the previous tick, the rest of the cycle is skipped — no expensive
  `eth_getBlockByNumber(_, true)` / `eth_feeHistory` /
  `txpool_content`. The fee landscape can't change without a new
  block, so polling faster than block time is wasted RPC. For
  PulseChain (~10s) and Ethereum (12s) on a 10s interval this
  collapses ~90% of ticks down to a single probe call. `pollOnce()`
  always bypasses the gate.
- `pauseWhenHidden` option (default `false`, browser-only). When
  enabled, subscribes to the browser's `visibilitychange` event and
  pauses the poll loop while the tab is hidden. Resumes (and emits
  a fresh sample) on `visibilityState === 'visible'`. Auto-no-ops
  in Node / SSR / Web Worker contexts.
- `sampleGasFees(options)` — top-level one-shot helper that returns
  a single fee snapshot without standing up a long-lived oracle.
  Right for tx-submit flows that price one transaction and don't
  need streaming updates. Composes the existing `fetchOracleInputs`
  + `reducePollInputs` split.
- `fetchHeadBlockNumber(client, onError?)` — exported helper for the
  cheap `eth_blockNumber` probe that powers block-gated polling.

### Changed
- **Default behavior change**: `pauseWhenIdle: true` is the default.
  Existing call sites that did `oracle.start()` followed by
  `oracle.getState()` (without subscribing) now see `null` until
  either (a) a subscriber attaches, OR (b) `pollOnce()` is called.
  Migration paths:
  - Subscribe to a no-op: `oracle.subscribe(() => {})` keeps the
    loop alive and the cache warm for `getState()` reads.
  - Set `pauseWhenIdle: false` to restore v0.2.5 behavior.
  - Use `pollOnce()` for one-shot reads.
  - For ad-hoc `client.getGasTiers()`-style use, see the new
    `sampleGasFees` helper.
- The viem-actions extension (`gasOracleActions(...)`) and
  viem-transport wrapper (`withGasOracle(...)`) both default
  `pauseWhenIdle: false` for their internal oracle. Their access
  pattern is pull-based (state read inside the request handler),
  so subscriber-gated pause would always be miss. Callers can
  override by passing `pauseWhenIdle` explicitly.

### Notes
- This release lands the most-requested fix in production usage:
  idle traffic when nothing is reading the oracle. A multi-chain
  dapp running two oracles on a static page used to fire 8–20
  RPCs per chain every 10s; with `pauseWhenIdle: true` (default)
  that drops to zero. With `blockGatedPolling: true` (default), the
  steady-state RPC cost on chains with non-trivial block times
  drops to ~1 call per tick (the cheap `eth_blockNumber` probe)
  whenever the head hasn't moved.
- These primitives are the v0.2.x precursor to the
  `@valve-tech/chain-source` package landing in v0.3.0; the
  subscriber-refcount + block-gating + visibility hooks move into
  that shared layer at v0.3.0 so both gas-oracle and tx-tracker
  inherit them. See `docs/tx-tracker-spec.md` in the repo.
- No API removals. Every existing call site continues to work
  byte-for-byte; the only behavior change is the new default of
  `pauseWhenIdle: true`.

## [0.2.5] — 2026-05-03

### Added
- README **RPC transport modes** section covering all four caller-side
  configurations the package supports: HTTP-only, WS-only, both (via viem's
  `fallback`), and "neither" (driving the pure `reducePollInputs` reducer
  with pre-fetched `OraclePollInputs` — no live `PublicClient` needed).
- `examples/06-reducer-only.ts` exercising the offline path end-to-end with
  synthetic fixture inputs, surfacing the `fetchOracleInputs` /
  `reducePollInputs` export split that enables it.

### Notes
- Documentation-only release. No API changes; behavior identical to v0.2.4.
- Picking WS today buys nothing functional over HTTP — the oracle never
  opens a subscription. The functional case for WS arrives when
  subscription-using features (e.g., tx-tracking via `newHeads` /
  `newPendingTransactions`) land. Choose WS now only if upstream is cheaper
  or lower-latency on it.

## [0.2.4] — 2026-05-02

### Added
- `CHANGELOG.md` (this file).
- `AGENTS.md` at repo root — terse, AI-first companion to README. Lists the
  public API, the discriminated query shape for `tipForBlockPosition`, and
  pitfalls.
- `examples/` directory with 5 runnable scripts covering basic tier reads,
  mempool snapshots, block-position queries, and both viem subpaths.
- `skills/` directory shipped in the npm tarball — Claude Code / Cursor / etc.
  agents consuming `node_modules/@valve-tech/gas-oracle/skills/` get grounded
  context about when and how to use the package.
- README badges (npm version, types-included, SLSA provenance).
- ESLint configuration with `@typescript-eslint/no-explicit-any` enforced as
  an error. The codebase was incidentally `any`-free; this makes the rule a
  hard constraint.
- `lint` script wired into the CI workflow.

### Changed
- `files` field in `package.json` now includes `CHANGELOG.md`, `AGENTS.md`,
  and `skills/` so consumers get the docs and skill files in their
  `node_modules/`.

## [0.2.3] — 2026-05-02

### Added
- First release published via npm trusted-publisher OIDC. SLSA provenance
  attestation now ships with the tarball; consumers can verify with
  `npm audit signatures`.

### Fixed
- Aligned the release workflow with the known-working pattern used by other
  OIDC-publishing repos: removed the `environment:` block from the publish
  job, pinned `npm` to `11.5.1` before install. Without this, the OIDC PUT
  to npm 404'd despite the trusted-publisher record being correctly
  configured. See repo commit `de6c5bb` for the diagnostic.

## [0.2.2] — *unpublished*

Tagged but never published. OIDC publish failed; abandoned in favor of
v0.2.3 which carries the workflow fix.

## [0.2.1] — 2026-05-02

### Fixed
- Top-level `main`, `types`, and `exports` now point at `dist/*` instead of
  `src/*.ts`. The `publishConfig` override pattern that previously rewrote
  these fields at publish time is deprecated in npm 11 and didn't apply
  correctly during the v0.2.0 manual publish — that release shipped a
  tarball whose `package.json` pointed at non-existent `src/` paths.
- Added `prepare: yarn build` to scripts so consumers using workspace
  symlinks or `git+` installs get a built `dist/` automatically.

### Removed
- The `publishConfig` block (deprecated; replaced by aligning top-level
  fields with the published shape).

## [0.2.0] — 2026-05-02

First public release. Tarball had a packaging bug — see [0.2.1] for the
fix. Consumers should install `@valve-tech/gas-oracle@^0.2.1` or later.

### Added
- `priorityFeeDecayCap: bigint | null` config (wad; null = uncapped;
  default `WAD/8` = 12.5%/block, EIP-1559 parity).
- `priorityModel: 'flat' | 'eip1559'` for chains whose validators charge
  tips instead of burning them (`flat`) versus chains that honor
  EIP-1559 ordering (`eip1559`).
- `baseFeeLivenessBlocks: number` — compounded 9/8 buffer over N blocks
  so `maxFeePerGas` survives sustained worst-case base-fee growth.
- `poll: { feeHistory?, mempool? }` toggles for chains that don't expose
  one or both endpoints.
- `keepMempoolSnapshot: boolean` + `oracle.getMempoolSnapshot()` for
  Phase B stuck-tx detection.
- Pure helpers: `normalizeMempool`, `findByHash`, `findByAddressNonce`,
  `findInMempool`.
- `tipForBlockPosition` — discriminated query over `rank` / `percentile`
  / `gasFromTop` and `aheadOf` / `behind` a `TxIdentifier`.
- `@valve-tech/gas-oracle/viem-actions` subpath for
  `client.extend(gasOracleActions(...))` integration.
- `@valve-tech/gas-oracle/viem-transport` subpath for `withGasOracle(transport, ...)`
  drop-in interception.

[0.2.4]: https://github.com/valve-tech/gas-oracle/releases/tag/v0.2.4
[0.2.3]: https://github.com/valve-tech/gas-oracle/releases/tag/v0.2.3
[0.2.1]: https://github.com/valve-tech/gas-oracle/releases/tag/v0.2.1
[0.2.0]: https://github.com/valve-tech/gas-oracle/releases/tag/v0.2.0
