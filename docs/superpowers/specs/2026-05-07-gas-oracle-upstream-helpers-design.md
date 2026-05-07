# gas-oracle upstream helpers + chain presets — design

**Status**: design (pre-implementation)
**Branch**: `feat/v0.8.0-tx-tracker-completion`
**Target version**: v0.8.0 (pre-release; bumps to all five workspaces are local-only at design time)
**Author**: derived from Provex consumer feedback dump (2026-05-06)

## Context

`@valve-tech/gas-oracle` v0.8.0 has not yet shipped — npm `latest` is `0.7.0`, no `v0.8.0` git tag, all five workspace packages have local-only version bumps on this branch. The Provex monorepo (consumer-side dapp built on the evm-toolkit packages) has surfaced a set of patterns that emerged from production use and belong upstream rather than being re-implemented per consumer.

This spec covers the gas-oracle items from that feedback dump: five new consumer-facing helpers plus a per-chain configuration presets entry-point, all landing in v0.8.0 before the release tag.

## Goals

- Surface five helpers that consumers re-implement today: `recommendBumpTier`, `bumpForReplacement`, `classifyTip`, `defaultInclusionLabels`, `inclusionLabel`.
- Provide a per-chain presets entry-point so chain-specific overrides (e.g., PulseChain) are a one-liner at the consumer site instead of an undocumented "you have to know."
- Flip the `priorityModel` default from `'flat'` to `'eip1559'` — most chains honor the EIP-1559 fee market, so the right default protects most consumers; PulseChain becomes the named exception.
- Apply project-wide style discipline already in flight elsewhere: const-namespace pattern for string-union types, `bigint` for numeric values that participate in math.

## Non-goals

- Blob-tx (EIP-4844) replacement bumping. The primitive (`minimumReplacementFee` accepts `txType`) is forward-compatible, but `bumpForReplacement` and `recommendBumpTier` are 1559-scoped for v0.8.0. A `bumpForBlobReplacement` lands when needed.
- React / UI primitives. The headless `<TxFlightStrip>` family from the consumer feedback belongs in a future sibling package, not gas-oracle.
- i18n machinery. `inclusionLabel` accepts a partial-overrides map; consumers manage their own translation tables.
- Wallet-adapter, viem-errors, tx-tracker items from the same feedback dump — separate scope.

## Design

### Section 1 — Foundational refactor (whole-package, behavior-preserving)

**1A. Const-namespace for string-union types.** Every string-union type in the package gets the same shape — value namespace and type alias share the identifier:

```ts
export const PriorityModel = {
  flat: 'flat',
  eip1559: 'eip1559',
} as const
export type PriorityModel = (typeof PriorityModel)[keyof typeof PriorityModel]
```

Same treatment for `TierName` (`slow` / `standard` / `fast` / `instant`), `Trend` (`rising` / `falling` / `stable`), and a new `TxType` covering EIP-2718 type bytes (`legacy` / `eip2930` / `eip1559` / `blob` / `setCodeAuthorization`).

Every existing magic-string literal in `math.ts`, `oracle.ts`, `samples.ts`, and the test files is rewritten to reference the const namespace. The type system catches misses — an unmigrated `'flat'` literal still types-check on its own but won't satisfy `priorityModel?: PriorityModel` at the option boundary.

**1B. BigInt for math, number for identifiers.** Numeric values that participate in arithmetic become `bigint`. Conversion to `number` happens only at JS-platform-API boundaries (`arr[Number(i)]` for indexing, `setInterval(_, Number(ms))` for timers). The `number` type never appears in public API signatures for arithmetic values.

| Site | Now | After |
|---|---|---|
| `MempoolStats.pendingCount` | `number` | `bigint` |
| `MempoolStats.queuedCount` | `number` | `bigint` |
| `BlockPositionQuery.rank` | `number` | `bigint` |
| `BlockPositionQuery.percentile` | `number` | `bigint` |
| `BlockPositionResult.rank` | `number` | `bigint` |
| `CreateGasOracleOptions.pollIntervalMs` | `number` | `bigint` |
| `ClassifyTipResult.percentile` | (new) | `bigint` |
| `ClassifyTipResult.rank` | (new) | `bigint` |

Stays `number` (identifier-like, never math): `chainId`, EIP-2718 type bytes (`TxType` values, `RawTx.type`).

**Default flip.** `oracle.ts:445` and `math.ts:338` both currently coalesce `input.priorityModel ?? 'flat'`. Both become `?? PriorityModel.eip1559`. Tests that explicitly verify flat-model behavior on PulseChain need an explicit `priorityModel: PriorityModel.flat` (or `...chainPresets.pulsechain`) added; tests that used chain 369 as a placeholder ID where the model didn't matter are audited but mostly unchanged.

### Section 2 — Replacement helpers (`replacement.ts`)

Paired primitives for same-nonce EIP-1559 replacement ("speed up" / "outpace stuck tx"). Pure functions; protocol-replacement-floor math encoded explicitly.

**Replacement-floor math** verified against geth `core/txpool/legacypool/list.go:Add()`, geth `core/txpool/blobpool/config.go`, reth `crates/transaction-pool/src/config.rs`, and PulseChain `gitlab.com/pulsechaincom/go-pulse/master/core/txpool/legacypool/legacypool.go`. Findings:

- **Both** `maxFeePerGas` and `maxPriorityFeePerGas` must clear `+10%` (geth's `legacypool.DefaultConfig.PriceBump = 10`, applied to both fields with AND-AND semantics in `list.Add`). The "12.5%" number from the consumer feedback was a conflation with the EIP-1559 base-fee max-change-per-block (`1/8`), which is unrelated to replacement-by-fee.
- **Blob txs** require `+100%` on every fee field (`blobpool.DefaultConfig.PriceBump = 100`, reth `REPLACE_BLOB_PRICE_BUMP = 100`).
- PulseChain inherits geth's defaults unchanged.
- The `+1n` term in the helper is load-bearing for small values: at `current=9`, geth's threshold is `floor(9*11/10)=9` but the strict `old < tx` check forces `tx >= 10`. `(current * 11n) / 10n + 1n` returns the correct minimum for every `current ∈ [0, ∞)`.

```ts
export const ReplacementBumpPercent = {
  default: 10n,   // legacypool — legacy / EIP-2930 / EIP-1559 / EIP-7702
  blob: 100n,     // blobpool — EIP-4844
} as const

export const minimumReplacementFee = (current: bigint, txType: number): bigint => {
  const bump = txType === TxType.blob
    ? ReplacementBumpPercent.blob
    : ReplacementBumpPercent.default
  return (current * (100n + bump)) / 100n + 1n
}
```

`txType` is `number` (matches `TipSample.txType` ergonomics and viem's raw type bytes); the comparison goes through `TxType.blob` so no magic numbers. Unknown future type bytes silently get `default` — the conservative answer (geth handles every non-blob type today via legacypool).

**`bumpForReplacement(currentGas, targetGas)`** — given a current 1559 tx's gas object and a target gas object (from your fee strategy), return a replacement gas object that clears the protocol floor on both fields and is at least the target. Guarantees `result.maxFeePerGas >= result.maxPriorityFeePerGas` (well-formed tx). 1559-scoped — both fields use `minimumReplacementFee(_, TxType.eip1559)`.

**`recommendBumpTier(snapshot, stuckTx, options?)`** — pick a `TierName` to bump to. Two floors apply: the protocol-replacement floor (always), and an outpace-original floor (when `stuckTx.identifier` is provided). The latter uses `tipForBlockPosition({ kind: 'aheadOf', tx: identifier })` over `snapshot.mempoolSamples` to compute the tip needed to outpace the stuck tx in the current pending distribution. Effective floor is `max(protocolFloor, outpaceFloor)`.

```ts
export const BumpStrategy = {
  cheapestThatLands: 'cheapestThatLands',
  oneStepFasterThanRecommended: 'oneStepFasterThanRecommended',
  instant: 'instant',
} as const

export const recommendBumpTier = (
  snapshot: GasOracleState,
  stuckTx: { priorityTip: bigint; identifier?: TxIdentifier },
  options: RecommendBumpTierOptions = {},
): TierName | null => { /* ... */ }
```

Returns `null` when no tier clears the effective floor (original was already paying above the top of the ladder, OR snapshot has empty/zero tiers). Default strategy is `cheapestThatLands`.

**Snapshot extension.** `GasOracleState` gains `mempoolSamples: TipSample[]` — the live mempool sample list that produced the snapshot's tiers. Used by `recommendBumpTier`'s outpace correction. Producer-local convention (same as the existing `ring` field): wire publishers strip before serializing. Does not grow snapshot size cumulatively — each poll replaces the snapshot.

### Section 3 — `classifyTip` (`classify-tip.ts`)

Inverse of `tipForBlockPosition`. Given a tip and a snapshot, find where the tip would land in the live distribution and which named tier it falls in. Pure: no I/O, no oracle dependency.

```ts
export interface ClassifyTipResult {
  tier: TierName | null
  requiredForNextTier: bigint | null
  percentile: bigint   // 0n..100n; 0n = top, 100n = bottom
  rank: bigint
  gasFromTop: bigint
}
```

Returns the tier classification (against the four tier boundaries) and the distribution-position (rank/percentile/gasFromTop), computed from `state.ring[*].tips ++ state.mempoolSamples`. Empty-distribution fallback returns `0n` / `0n` / `0n` for the position fields (mirrors `tipForBlockPosition`'s empty handling).

`requiredForNextTier` is the upsell-UI affordance: `null` at `instant`, `tiers.slow.maxPriorityFeePerGas` when below `slow`. All math bigint; loop counters bigint with `Number(i)` at array-access boundaries.

### Section 4 — Inclusion labels (`inclusion-labels.ts`)

```ts
export const defaultInclusionLabels: Record<TierName, string> = {
  [TierName.slow]: 'Within a few blocks',
  [TierName.standard]: 'Next block',
  [TierName.fast]: 'Top of next block',
  [TierName.instant]: 'Front of next block',
}

export const inclusionLabel = (
  tier: TierName,
  overrides?: Partial<Record<TierName, string>>,
): string => overrides?.[tier] ?? defaultInclusionLabels[tier]
```

Conservative copy — describes relative position, not hard timing guarantees. Locale / branded copy is the consumer's concern: pass a `Partial<Record<TierName, string>>` for per-call overrides, or spread `{ ...defaultInclusionLabels, ...partial }` for a complete replacement map.

### Section 5 — Chain presets (`presets.ts`)

```ts
export type ChainPreset = {
  chainId: number
} & Pick<
  CreateGasOracleOptions,
  'priorityModel' | 'priorityFeeDecayCap' | 'pollIntervalMs'
>

export const chainPresets = {
  pulsechain: {
    chainId: 369,
    priorityModel: PriorityModel.flat,
  },
} as const satisfies Record<string, ChainPreset>

export const presetForChainId = (chainId: number): ChainPreset | undefined =>
  Object.values(chainPresets).find((p) => p.chainId === chainId)
```

`Pick` keeps the preset shape automatically aligned with `CreateGasOracleOptions` — adding a chain-specific knob and updating the union are paired changes; existing entries pick it up or ignore it. Each entry carries its own `chainId`, so spreading at the consumer site fills both the ID and the override:

```ts
createGasOracle({ client, ...chainPresets.pulsechain })
```

PulseChain is the only entry today. The directive for adding more: verify the chain's actual validator behavior against block-level data first; `default-is-eip1559` is correct for every chain we haven't proven otherwise.

### Section 6 — File layout, exports, commit sequence

**New files** (under `packages/gas-oracle/src/`):

| File | Tests |
|---|---|
| `replacement.ts` | `replacement.test.ts` |
| `classify-tip.ts` | `classify-tip.test.ts` |
| `inclusion-labels.ts` | `inclusion-labels.test.ts` |
| `presets.ts` | `presets.test.ts` |

**Modified files**: `types.ts` (const namespaces, bigint migrations, `mempoolSamples` field), `index.ts` (new re-exports), `math.ts` / `oracle.ts` (default flip + refactor), `samples.ts` / `block-position.ts` / `transport.ts` / `mempool.ts` / `viem-actions.ts` / `viem-transport.ts` (refactor), all `*.test.ts` files (paired updates).

Imports retain `.js` extensions throughout — Node ESM + TypeScript compilation contract; `--rewriteRelativeImportExtensions` migration is a separate future PR.

**Public API surface** — new top-level exports from `index.ts`:

- Const namespaces: `PriorityModel`, `TierName`, `Trend`, `TxType`
- Replacement: `minimumReplacementFee`, `bumpForReplacement`, `recommendBumpTier`, `BumpStrategy`, `ReplacementBumpPercent`, types `RecommendBumpTierOptions` / `ReplacementGas`
- Classification: `classifyTip`, type `ClassifyTipResult`
- Labels: `defaultInclusionLabels`, `inclusionLabel`
- Presets: `chainPresets`, `presetForChainId`, type `ChainPreset`

`viem-actions` and `viem-transport` subpath exports unchanged.

**Commit sequence** (on `feat/v0.8.0-tx-tracker-completion`):

| # | Subject | Scope |
|---|---|---|
| 1 | `refactor(gas-oracle): const namespaces for PriorityModel/TierName/Trend/TxType` | 1A — magic-string elimination, no behavior change |
| 2 | `refactor(gas-oracle): bigint for numeric values that participate in math` | 1B — type widening, no behavior change |
| 3 | `feat(gas-oracle): default priorityModel to eip1559` | The only behavior change in the foundational set |
| 4 | `feat(gas-oracle): preserve mempoolSamples on GasOracleState` | Section 2 prerequisite |
| 5 | `feat(gas-oracle): replacement helpers — minimumReplacementFee, bumpForReplacement, recommendBumpTier` | Section 2 |
| 6 | `feat(gas-oracle): classifyTip — inverse of tipForBlockPosition` | Section 3 |
| 7 | `feat(gas-oracle): inclusion labels with locale override` | Section 4 |
| 8 | `feat(gas-oracle): chainPresets entry-point with PulseChain exception` | Section 5 |
| 9 | `docs(gas-oracle): README + skills updates for new defaults, helpers, presets` | Section 7 |
| 10 | `chore(release): widen v0.8.0 changelog to include gas-oracle additions` | CHANGELOG widening + memory-file hygiene |

The existing `eec81ce chore(release): v0.8.0 — tx-tracker completion + WS-push` commit stays in history. Commit (10) lands a follow-up release-narrative commit; no `--amend`, no rebase, no force-push.

### Section 7 — Docs and skills

**README** (`packages/gas-oracle/README.md`):

- Flip "Choosing `priorityModel`" framing from "set this" to "default is `eip1559`; set `flat` only when your chain's validators don't honor the EIP-2718 type byte."
- New "Chain presets" section with the spread pattern and the PulseChain example.
- Audit existing examples that omitted `priorityModel` (which got `'flat'` by default) — explicitly set `flat` if PulseChain-flavored, otherwise note that they now get `'eip1559'`.
- New sections walking through each new helper with a short example.

**CHANGELOG** (`packages/gas-oracle/CHANGELOG.md` + root `CHANGELOG.md`):

v0.8.0 entry widens from "tx-tracker completion + WS-push" to include:
- New helpers (`recommendBumpTier`, `bumpForReplacement`, `classifyTip`, `inclusionLabel`)
- Const namespaces (`PriorityModel`, `TierName`, `Trend`, `TxType`)
- BigInt migration of public numeric fields
- Default `priorityModel` flip to `eip1559`
- Chain presets entry-point with PulseChain exception
- New `mempoolSamples` field on `GasOracleState`

**Skills**:

- `packages/gas-oracle/skills/gas-oracle-integration/SKILL.md` — new sections for replacement workflow, tip classification, UI copy, chain presets; default-flip note on existing examples.
- `.claude/skills/contributing-to-evm-toolkit/SKILL.md` — new project-wide style sections: const-namespace pattern, bigint discipline (with carve-out for identifier-like fields).
- `packages/tx-tracker/skills/tx-tracker-integration/SKILL.md` — cross-reference to `recommendBumpTier` + `bumpForReplacement` for the "speed-up tracked tx" workflow.

**Memory hygiene** (post-implementation):

- `pulsechain-gas-pricing-footgun.md` — reference `chainPresets.pulsechain` as the canonical answer.
- `upstream-candidates.md` — mark gas-oracle items 1-5 shipped in v0.8.0.
- `architecture-primitive-layer.md` — note `GasOracleState` now carries `mempoolSamples`.

## Verification

- All unit tests pass under `yarn workspace @valve-tech/gas-oracle test` and the workspace-aggregate `yarn test` from the repo root.
- Coverage gate (100/100/100/100) holds — closed at v0.8.0 already, the new helpers contribute fully covered lines.
- Lint passes under `yarn workspace @valve-tech/gas-oracle lint`.
- `yarn workspace @valve-tech/gas-oracle typecheck` and `typecheck:examples` both green.
- Replacement-floor math validated by table-driven tests against the geth source semantics: `current ∈ [0, 1, 9, 10, 80, 83, 100, 1e18]`, both legacy/1559 and blob bump percentages, expected min-acceptable values asserted.
- Default flip audit: every `oracle.test.ts` and `math.test.ts` test using `chainId: 369` is reviewed; tests whose assertions depend on the priority-model are made explicit.

## References

- Provex consumer feedback dump (2026-05-06)
- geth `core/txpool/legacypool/legacypool.go` and `list.go` (`DefaultConfig.PriceBump = 10`)
- geth `core/txpool/blobpool/config.go` (`DefaultConfig.PriceBump = 100`)
- reth `crates/transaction-pool/src/config.rs` (`DEFAULT_PRICE_BUMP = 10`, `REPLACE_BLOB_PRICE_BUMP = 100`)
- PulseChain go-pulse `core/txpool/legacypool/legacypool.go` (inherits geth `PriceBump = 10`)
- Existing v0.8.0 design at `docs/superpowers/specs/2026-05-06-v0.8.0-tx-tracker-completion-design.md`
- Project memory: `architecture-primitive-layer.md`, `with-gas-oracle-shared-transport-instance.md`, `pulsechain-gas-pricing-footgun.md`, `upstream-candidates.md`, `v0_3_x_multi_pr_strategy.md`
