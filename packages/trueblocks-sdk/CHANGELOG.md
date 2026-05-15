# Changelog

All notable changes to `@valve-tech/trueblocks-sdk` are documented in
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

**First successful npm publish at the v0.10.x line.** v0.10.0's
publish errored at npm's provenance validation because this
`package.json` was missing the `repository` field — `--provenance`
requires it to match the GitHub repo URL in the OIDC attestation.
v0.10.1 adds the missing fields and republishes the whole line in
sync.

### Added
- `package.json`: `repository`, `homepage`, `bugs`, and `keywords`
  fields (matching the shape every other published `@valve-tech/*`
  package already had).

### Notes
- Package contents are otherwise identical to what v0.10.0 would
  have published.

## [0.10.0] — 2026-05-08

*Did not publish — the OIDC `Publish @valve-tech/trueblocks-sdk`
step errored at npm's provenance validation (missing `repository`
field in `package.json`). Superseded by v0.10.1.*

**Intended-for-publish content:** first OIDC-driven publish for
this package, jumping from the 0.0.1 name-claim. Joins the
synchronized release line at v0.10.x.

### Added
- Typed TypeScript HTTP client over the chifra daemon's REST API.
  All 18 OpenAPI endpoints exposed via `createTrueblocksClient(...)`:
  `blocks`, `transactions`, `receipts`, `logs`, `traces`, `when`,
  `state`, `tokens`, `list`, `export`, `monitors`, `names`, `abis`,
  `slurp`, `chunks`, `init`, `config`, `status`.
- 36 narrowed variant accessors on the seven polymorphic endpoints
  whose response is a wide union (4+ types):
  - `client.blocks.{hashes, uncles, traces, uniq, logs, withdrawals, count}`
  - `client.transactions.{traces, uniq, logs}`
  - `client.traces.count`
  - `client.slurp.{appearances, count}`
  - `client.state.call`
  - `client.export.{appearances, receipts, logs, approvals, traces, neighbors, statements, transfers, assets, balances, withdrawals, count, approvalsLogs}`
  - `client.chunks.{manifest, index, blooms, pins, addresses, appearances, stats, count, check}`
- Conditional `VerbFn<P>` typing — endpoints with required query
  parameters (e.g. `/blocks` requires `blocks: string[]`) reject
  no-arg calls at the type level.
- Codegen pipeline: `scripts/codegen.mjs` pulls the upstream OpenAPI
  spec from `TrueBlocks/trueblocks-core` at pinned SHA
  `3205a003af599adf2229408f74afbe6952391883`. `src/generated.ts` is
  fetched on first build (`--if-missing` chained into build, test,
  typecheck), gitignored, and refreshed via `yarn codegen`.
- Browser/mobile-safe runtime — `globalThis.fetch` only, no Node
  imports.
- 100% coverage on the hand-written surface (client, errors, verbs,
  variants).

### Notes
- Licensed MIT, in line with the rest of `@valve-tech/*`. Upstream
  `trueblocks-core` is GPL-3.0-or-later; this package is a
  clean-room TypeScript reimplementation against the public OpenAPI
  spec — no GPL code is incorporated. The clean-room rule (don't
  read the GPL Go SDK source) is preserved in `AGENTS.md` and is
  load-bearing under MIT.
- `state.send()` is **not** exposed: the upstream OpenAPI at the
  pinned SHA describes only `call?: boolean` as a boolean flag on
  the `/state` endpoint, not `send`. The variant will be added when
  the spec gains the flag and codegen picks it up.

## [0.0.1] — 2026-05-08

Manual name-claim publish. Establishes the npm record so a
trusted-publisher binding can be created at npmjs.com; not intended
for consumption.
