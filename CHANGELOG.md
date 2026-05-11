# Changelog

All notable changes to the `valve-tech/evm-toolkit` monorepo are documented in
this file. Per-package details live in each `packages/*/CHANGELOG.md`.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.12.0] — 2026-05-11

Feature release. Five pieces of work shipped together, all
additive — no breaking changes for existing consumers.

**`@valve-tech/chain-source`** — adds `getBlockByHash(hash)` to
the `ChainSource` interface (and the underlying `fetchBlockByHash`
transport helper). Returns the block at a specific hash even when
that hash is no longer canonical — required for any consumer that
walks a reorged-away branch via parentHash chains.

**`@valve-tech/gas-oracle`** — reorg-side backfill in the ring
lifecycle. Closes the only known gap from v0.11.0: when
`handleBlock` detects a parentHash mismatch with the ring tip, it
now walks back from `newBlock.parentHash` via
`source.getBlockByHash` to find the common ancestor, then feeds
the walked-back chain to the reducer as `historicalBlocks`. The
reducer trims the diverged tail and populates `lastReorg` with
accurate `depth` + `droppedHashes`. Bounded by `ringWindowBlocks`
so deep reorgs degrade via the reducer's restart arm.

**Toolkit-wide** — new `verify:persisted-types` CI check codifies
the wire-shape-evolution discipline that emerged from the v0.11.x
incident. `scripts/persisted-types.manifest.json` is a checked-in
snapshot of the fields on every persisted type
(`TxStatus`, `TrackedTxRecord`, `PersistedSubscription`,
`TrackedTx`); the script parses the source interfaces and fails CI
on any drift. Forces the maintainer to acknowledge each field
addition and consider safety (optional? defensive read? migration?)
before the change can land. Wired into `verify:clean` + the CI
workflow.

**`@valve-tech/tx-flight-react`** — adds a `makeLegacyTrackedTx`
test fixture + two legacy-shape round-trip tests that lock in the
wire-shape evolution discipline for `TrackedTx` persistence.
Mirrors the `makeLegacyTxStatus` helper from tx-tracker (v0.11.2).
No production code change.

**`@valve-tech/wallet-adapter`** — three more bridge examples
(now 8 total), covering ethers v6 (`Signer` bridge for
dapps still on ethers), Privy embedded wallets (CAIP-2 chain
encoding + lazy provider fetching), and Safe (Gnosis Safe)
multisig (returns a `safeTxHash`, not an on-chain tx hash —
file header documents the consumer-visible implications). Each
runs end-to-end via the no-network sanity-check pattern.

- **chain-source**: `getBlockByHash` API.
- **gas-oracle**: ring lifecycle reorg-side backfill (uses
  `getBlockByHash`).
- **wallet-adapter**: 3 more examples (ethers, Privy, Safe).
- **tx-tracker**, **tx-flight-react**, **viem-errors**,
  **trueblocks-sdk**: synced no-op (tx-flight-react also gains
  test-only `makeLegacyTrackedTx` helper).

Coverage stays at 100/100/100/100 across all 7 packages. 1078
tests total. New CI step: `verify:persisted-types`.

## [0.11.2] — 2026-05-11

Posture-consistency follow-up to v0.11.1. After the v0.11.0 crash
shipped (and was fixed in v0.11.1), we re-ran an upgrade-hazard
review across all persistence-touching code in `@valve-tech/tx-tracker`
and `@valve-tech/tx-flight-react`. The review surfaced two
additional strict-null read sites in tx-tracker that are
structurally identical to the v0.11.1 root cause:

- `tracker.ts:834` — stale-block guard's `recordedSince !== null`
  on `TxStatus.lastObservedAtBlock`.
- `observations.ts:274` — unseen-streak gate's
  `firstObservedAtBlock === null`, plus the `unseenStreak + 1`
  arithmetic below it.

**These are not crashing on any current consumer's data** — the
fields have been on `TxStatus` since v0.3.x, so no live persisted
record has them missing. The fix tightens both sites to defensive
shape checks (`typeof === 'bigint'` and `== null` + `?? 0`) so the
hazard class is closed across the entire package, not just the
v0.11.1 site. Same posture, consistent application.

Also adds a `makeLegacyTxStatus(overrides, omit)` test helper that
codifies the "legacy-fixture" pattern: the v0.11.1 regression test
and the two new v0.11.2 tests all use it. Future audits of persisted
types should reach for this primitive to write at least one
legacy-shape test per added field.

- **tx-tracker**: substantive fix. See package CHANGELOG.
- **chain-source**, **gas-oracle**, **viem-errors**, **wallet-adapter**,
  **tx-flight-react**, **trueblocks-sdk**: synced no-op republish.

Coverage stays at 100/100/100/100 across all 7 packages. 1066 tests
in total (was 1063; +3 legacy-fixture tests).

## [0.11.1] — 2026-05-11

Patch release. Fixes a v0.11.0 upgrade-path crash in
`@valve-tech/tx-tracker` that affected consumers running a
persistent store (localStorage, IndexedDB, Redis, SQLite, custom
`TxTrackerStore`) and upgrading from ≤0.10. v0.11.0 added
`TxStatus.terminalAtBlockNumber: bigint | null`, but the
retention-enforcement check used `t !== null` (strict). Records
persisted by ≤0.10 stores have the field absent (`undefined` at
runtime), which slipped past the guard and threw `TypeError: Cannot
mix BigInt and other types` at `undefined + BigInt(retentionBlocks)`.
The throw was uncaught inside `Subscriptions.emit`, halting the
in-flight block-tick fanout silently — downstream events for that
tick were dropped and consumer-visible UIs stalled on "pending"
indefinitely.

Fixed in three sites (tracker.ts retention guard + observations.ts
two patch guards), regression-tested in both `tracker.test.ts` and
`observations.test.ts`.

- **tx-tracker**: the substantive fix — `typeof t === 'bigint'`
  retention guard + `== null` patch guards. See package CHANGELOG.
- **tx-flight-react**: republished because it consumes tx-tracker
  transitively. Consumers with a persistent storage adapter should
  bump.
- **chain-source**, **gas-oracle**, **viem-errors**, **wallet-adapter**,
  **trueblocks-sdk**: synced no-op republish (package contents
  identical to 0.11.0).

## [0.11.0] — 2026-05-11

Feature release across the toolkit. Three meaningful pieces of code
work, plus a docs pass and a workspace-wide coverage closure to 100%.

**`@valve-tech/gas-oracle`** — the 20-block ring lifecycle ships.
Tier recommendations now sample from a real rolling window
(`state.ring[*].tips ++ mempoolSamples`) instead of a single block,
which materially stabilizes the published numbers across single-block
dips. New `ringWindowBlocks` option on `createGasOracle` (default
`20n`, matches the `eth_feeHistory` window); `state.lastReorg`
surfaces detected ring-trim events; pure `incorporateBlock` helper
exported for replay harnesses. The poll loop pre-fetches missing
blocks via `source.getBlock` to bridge clean gaps before the reducer
runs. Reorg-side backfill remains scoped out — the reducer trims
the diverged tail and lets natural forward polling refill the new
canonical branch.

**`@valve-tech/tx-tracker`** — a 7-finding audit landed before the
release. Three of those were silent-failure-shaped (durable
rehydrate, retention enforcement, receipt-poll identity race) where
documented behavior simply did not fire; two were concrete bugs
(`replaced-by` re-fire across the mempool→block boundary, sync
sub.stop() inside a bulk fanout); one was a defensive hardening
extraction; one was a lock-in test on intentional behavior. Net new
public API: `TxTracker.ready(): Promise<void>` for cross-process
restart consumers, `retentionBlocks` option on
`CreateTxTrackerOptions`, `terminalAtBlockNumber` field on
`TxStatus`, and `findBulkSubBySelector` exported from the package
root. Spec compliance walk against `docs/tx-tracker-spec.md`
produced a clean pass for every named default and event kind.

**`@valve-tech/wallet-adapter`** — five worked bridge examples now
ship in the repo, covering the common wallet-plumbing classes
end-to-end:

- `01-reown-adapter.ts` — universal EIP-1193 (Reown / WalletConnect,
  MetaMask SDK, RainbowKit, raw window.ethereum, hardware wallets
  in browser context).
- `02-wagmi-adapter.ts` — the wagmi React stack (`useWalletClient()`
  → adapter, skipping the EIP-1193 round-trip).
- `03-server-relayer.ts` — backend code signing from a private key
  (env var / KMS), hard-failing on cross-chain.
- `04-erc4337-smart-account.ts` — ERC-4337 account abstraction via
  permissionless.js or similar; `adapter.address` is the smart
  account, not the EOA signer.
- `05-hardware-wallet-direct.ts` — direct USB/HID Ledger via
  `@ledgerhq/hw-app-eth` (Trezor via `@trezor/connect` shape too).

Each ends in a no-network sanity check using viem's `custom`
transport so the bridge code self-validates without anyone having
to install the underlying wallet libraries.

**`@valve-tech/chain-source`** — `RawTx`, `BlockResult`,
`FeeHistoryResult`, `TxPoolContent`, `NormalizedMempool`, and
`PollOptions` are now imported by `@valve-tech/gas-oracle` from this
package (the canonical owner) rather than declared locally. gas-
oracle continues to re-export them so downstream
`import { RawTx } from '@valve-tech/gas-oracle'` keeps working;
nominal type identity now unifies across the toolkit.

**Coverage** — 100% statements / branches / functions / lines across
every published package. Two unreachable defensive paths were
refactored away (`gas-oracle`'s `reduceAndPublish` null guard +
`c8 ignore` directive; `tx-tracker`'s `findBulkSubBySelector` throw
replaced with a tested defensive null return). No `c8 ignore` /
`istanbul ignore` directives remain in any package's `src/`.

- **chain-source**: documentation comment in `src/types.ts` updated
  to reflect post-migration canonical-owner status; no API change.
- **gas-oracle**: 20-block ring lifecycle (`ringWindowBlocks`
  option, `state.lastReorg`, gap bridging), wire types now imported
  from `chain-source`, dead-branch refactor.
- **tx-tracker**: 7-finding audit (durable rehydrate, retention
  enforcement, replaced-by dedup, race/defensive fixes,
  `findBulkSubBySelector` extraction, behavior lock-ins); new
  `ready()`, `retentionBlocks`, `terminalAtBlockNumber`.
- **wallet-adapter**: 5 wallet bridge examples + `typecheck:examples`
  wiring; README anchor.
- **trueblocks-sdk**, **tx-flight-react**, **viem-errors**: synced
  no-op (republish at 0.11.0 alongside the rest of the toolkit).

## [0.10.1] — 2026-05-08

Recovery release for v0.10.0 partial publish. v0.10.0 published six
of seven packages successfully but the OIDC `Publish
@valve-tech/trueblocks-sdk` step failed at npm's provenance
validation: the new package's `package.json` had no `repository`
field, and `--provenance` requires it to match the GitHub repo URL
in the OIDC attestation (`https://github.com/valve-tech/evm-toolkit`).

v0.10.1 adds the missing `repository`, `homepage`, `bugs`, and
`keywords` fields to `trueblocks-sdk/package.json` (matching the
shape every other published package already had) and republishes
all seven from one tag.

- **trueblocks-sdk**: package.json gains repository/homepage/bugs/
  keywords. **First successful npm publish at the v0.10.x line** —
  previously stuck at the 0.0.1 manual name-claim because v0.10.0's
  publish errored.
- **chain-source**, **gas-oracle**, **tx-tracker**, **viem-errors**,
  **wallet-adapter**, **tx-flight-react**: synced no-op (republish
  at 0.10.1 — package contents identical to their published 0.10.0
  tarballs).

## [0.10.0] — 2026-05-08

*Partial publish — `trueblocks-sdk` missing, see v0.10.1.* Adds
**`@valve-tech/trueblocks-sdk`** as the seventh workspace
package — a typed TypeScript HTTP client for a running TrueBlocks
chifra daemon. All 18 OpenAPI endpoints + 36 narrowed variant
accessors on the polymorphic ones (54 methods total). MIT-licensed
clean-room reimplementation against the public OpenAPI spec; no
upstream GPL code is incorporated. Codegen-driven types pinned to
`TrueBlocks/trueblocks-core@3205a003`.

This is also a synchronized minor bump for the entire monorepo
because adding a new package is a notable surface change for
consumers of `@valve-tech/*`.

- **trueblocks-sdk** (NEW): first OIDC-driven publish at v0.10.0,
  jumping from the 0.0.1 name-claim. Includes the `Publish
  @valve-tech/trueblocks-sdk` step in `.github/workflows/release.yml`
  + a freshly-configured trusted-publisher record on npmjs.com.
- **chain-source**, **gas-oracle**, **tx-tracker**, **viem-errors**,
  **wallet-adapter**, **tx-flight-react**: synced no-op (version
  bump only — package contents identical to their published 0.9.3
  tarballs).

## [0.9.3] — 2026-05-08

Third recovery release for v0.9.0. v0.9.2 finally got the build
ordering right and the OIDC publish workflow ran end-to-end — but
five of the six packages published, not six: the workflow file
`.github/workflows/release.yml` had no `Publish @valve-tech/tx-flight-react`
step (oversight when the new package was scaffolded). v0.9.3 adds
that step so all six packages publish in lockstep, and is the
first synchronized version to land on npm for **every** package
in the v0.9.x line, including `tx-flight-react` (which had been
stuck at the 0.0.1 name-claim).

- **`.github/workflows/release.yml`**: added a sixth publish step
  (`yarn pack` + `npm publish --provenance`) for
  `@valve-tech/tx-flight-react`, ordered last so any future
  ordering-sensitive tooling sees its three workspace siblings
  publish first.
- **chain-source**, **gas-oracle**, **tx-tracker**, **viem-errors**,
  **wallet-adapter**: synced no-op (republish at 0.9.3 — package
  contents identical to their already-published 0.9.2 tarballs).
- **tx-flight-react**: synced no-op against 0.9.2's intended
  contents — but this is its *first* OIDC-driven publish at the
  v0.9.x line, jumping straight from the 0.0.1 name-claim.

## [0.9.2] — 2026-05-08

Second recovery release for v0.9.0. The v0.9.1 attempt added the
sibling-package `devDependencies` to `tx-flight-react` but didn't
fix the workspace **build ordering**: the root `build` script used
`yarn workspaces foreach --topological`, which only follows
`dependencies` entries — not `devDependencies` — so `tx-flight-react`
still ran before `wallet-adapter` / `tx-tracker` were emitted, and
the Build step failed identically. Switched to `--topological-dev`
in the root `build` script. v0.9.2 published five of the six
packages on npm, but `tx-flight-react` remained at 0.0.1 because
the release workflow had no publish step for it. *Superseded by
v0.9.3 for the partial-publish recovery.*

- **root**: `package.json#scripts.build` now uses
  `--topological-dev`, so workspace `devDependencies` participate
  in build ordering. Pure CI-orchestration change; no published
  package shape changed.
- **chain-source**, **gas-oracle**, **tx-tracker**, **viem-errors**,
  **wallet-adapter**, **tx-flight-react**: synced no-op (version
  bump only — package contents identical to v0.9.1's intended
  publish, which never reached npm).

## [0.9.1] — 2026-05-08

Recovery release for v0.9.0 — that tag was pushed but the OIDC
publish workflow's build step failed before any `npm publish` ran,
so nothing in the v0.9.0 line ever landed on npm. *Also did not
publish — same Build-step failure due to `--topological` ignoring
the new `devDependencies`. Superseded by v0.9.2.*

- **tx-flight-react**: declares `@valve-tech/chain-source`,
  `@valve-tech/tx-tracker`, and `@valve-tech/wallet-adapter` as
  `devDependencies: workspace:^` in addition to their existing
  `peerDependencies` entries. Without this, a clean CI install
  doesn't link the sibling packages' type declarations and
  `tsc -p .` fails. Consumer-facing peer-deps are unchanged
  (still optional).
- **chain-source**, **gas-oracle**, **tx-tracker**, **viem-errors**,
  **wallet-adapter**: synced no-op.

## [0.9.0] — 2026-05-08

Adds a sixth package, **`@valve-tech/tx-flight-react`** — React UI primitives for an in-flight transaction strip. Synced bump across all six `@valve-tech/*` packages.

- **tx-flight-react** (NEW): `<TxFlightProvider>` + `useTxFlight` hook + headless layout/atomic components (`<TxFlightList>`, `<TxFlightItem>`, `<TxFlightStatusIcon>`, `<TxFlightHashLink>`, `<TxFlightAge>`, `<TxFlightActions>`). Three add shapes — `addWithWalletAdapter` (sync, types-only wallet-adapter import; wraps `WriteHookParams` so each phase fans to user callbacks AND store dispatch), `addByHash` (async; dynamic-imports tx-tracker + chain-source), `addManual` (sync back-fill). Pluggable storage adapters (`localStorageAdapter` default, `indexedDBAdapter`, `memoryAdapter`) at the `/storage` sub-export. Persistence with bigint-safe JSON; rehydrate revives pending watchers via an optional `clientFactory` prop. Multi-instance scoping by `id`. SSR / RSC safe (Provider is `'use client'`; pure-renderer components are RSC-compatible). Spec: `docs/superpowers/specs/2026-05-07-tx-flight-react-design.md`.
- **chain-source**, **gas-oracle**, **tx-tracker**, **viem-errors**, **wallet-adapter**: synced no-op.

The `@valve-tech/tx-flight-react@0.0.1` name-claim publish was made manually before this release so the npm trusted-publisher record could be wired against the existing package; the 0.9.0 release publishes via the OIDC workflow alongside the synced sibling packages.

All six packages remain at 100/100/100/100 stmts/branches/funcs/lines.

## [0.8.1] — 2026-05-07

Code-quality cleanup of v0.8.0 review leftovers. Synced bump across all five `@valve-tech/*` packages.

- **tx-tracker**: `chainId` option on the three one-shot helpers (`watchTransaction`, `waitForTransaction`, `waitForPending`) — falls back to `client.chain?.id` so the previous `chainId: 0` placeholder gets auto-corrected for most callers without an API change. `replaceTransaction` no longer disables viem's network-mismatch check (`chain: null` → `walletClient.chain ?? null`); `original.chainId` is now load-bearing for EIP-155 signing and chain assertion. Removed dead `_eventSource` parameters from internal bulk runners.
- **gas-oracle**, **viem-errors**: small internal refactors that eliminated `c8 ignore` annotations from earlier releases. No public-API changes.
- **chain-source**, **wallet-adapter**: synced no-op.

All five packages remain at 100/100/100/100 stmts/branches/funcs/lines.

## [0.8.0] — 2026-05-06

Synced bump across all five `@valve-tech/*` packages.

- **chain-source**: WS subscribe paths wired in `subscribeBlocks` and `subscribeMempool` (live-probed at capability time; lazy-opened on first use; falls back to existing poll cycle on subscribe failure).
- **tx-tracker**: closes the three deferred items from `tx-tracker-spec.md` (receipt-poll-fallback runtime, withReceipts eager enrichment, tracker.group cross-tx correlation), adds two Provex upstream verbs (`watchTransaction`, `replaceTransaction`), and ships two Promise-based companions (`waitForTransaction`, `waitForPending` with arrival-timeout). Project-local contributor skill at `.claude/skills/extending-tx-tracker/SKILL.md`.
- **gas-oracle**: upstream helpers (replacement / classifyTip / inclusion labels), chain presets entry-point (PulseChain), const-namespace exports for `PriorityModel` / `TierName` / `Trend` / `TxType`, hoisted `TIER_LADDER`, bigint migration of public numeric fields, and a default-flip for `priorityModel` from `'flat'` to `PriorityModel.eip1559`. See package CHANGELOG for migration notes. Spec: `docs/superpowers/specs/2026-05-07-gas-oracle-upstream-helpers-design.md`.
- **viem-errors / wallet-adapter**: synced no-op.

### @valve-tech/gas-oracle

#### Added

- **Replacement helpers** (`replacement.ts`): `minimumReplacementFee`, `bumpForReplacement`, `recommendBumpTier` (three strategies: `cheapestThatLands` / `oneStepFasterThanRecommended` / `instant`). Optional outpace correction via `stuckTx.identifier` reads `snapshot.mempoolSamples` on top of the EIP-1559 +10% protocol floor.
- **`classifyTip(snapshot, tipWei)`** (`classify-tip.ts`): inverse of `tipForBlockPosition`.
- **Inclusion labels** (`inclusion-labels.ts`): `defaultInclusionLabels` + `inclusionLabel(tier, overrides?)` for locale/branded copy.
- **Chain presets** (`presets.ts`): `chainPresets.pulsechain` (chainId 369, `PriorityModel.flat`) and `presetForChainId(chainId)`.
- **Const-namespace exports**: `PriorityModel`, `TierName`, `Trend`, `TxType` exported as both values and types. `TIER_LADDER` exported from `types.ts`.
- **`mempoolSamples: TipSample[]`** on `GasOracleState` — producer-local, strippable for wire serialization.

#### Changed

- **`priorityModel` default**: `'flat'` → `PriorityModel.eip1559`. PulseChain (chain 369) is now the explicit exception (use `chainPresets.pulsechain`).
- **BigInt migration**: `MempoolStats.pendingCount`, `MempoolStats.queuedCount`, `BlockPositionQuery.rank`/`.percentile`, `BlockPositionResult.rank`, `CreateGasOracleOptions.pollIntervalMs` are now `bigint`. Identifier fields (`chainId`, EIP-2718 type bytes) stay `number`.

#### Migration

- Verify your chain honors EIP-1559 — examples that previously omitted `priorityModel` now silently get `PriorityModel.eip1559`.
- Use bigint literals (`0n`, `1n`, …) and floor-division semantics for migrated fields.
- `pollIntervalMs: 5000` → `pollIntervalMs: 5000n`.

Spec: `docs/superpowers/specs/2026-05-06-v0.8.0-tx-tracker-completion-design.md`
