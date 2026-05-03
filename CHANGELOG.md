# Changelog

All notable changes to `@valve-tech/gas-oracle` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
