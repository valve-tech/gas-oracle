# gas-oracle Upstream Helpers + Chain Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land five consumer-facing helpers (`recommendBumpTier`, `bumpForReplacement`, `classifyTip`, `defaultInclusionLabels`, `inclusionLabel`) + per-chain presets entry-point + foundational style refactor (const namespaces + bigint discipline) + `priorityModel` default flip into v0.8.0 of `@valve-tech/gas-oracle` before its release tag.

**Architecture:** Pure functions over snapshots, flat `src/` layout, one helper per file with paired `*.test.ts`. Foundational refactor first (commits 1-3), then snapshot extension (commit 4), then five helper additions in dependency order (commits 5-8), then docs (9) and release-narrative widening (10).

**Tech Stack:** TypeScript 6.x, vitest, viem (peer dep), `@valve-tech/chain-source` (workspace dep), ESM with `.js` import extensions, Yarn 4 workspaces, c8 coverage gate at 100/100/100/100.

**Branch:** `feat/v0.8.0-tx-tracker-completion` (extends in place; no version bump from current local 0.8.0).

**Spec:** `docs/superpowers/specs/2026-05-07-gas-oracle-upstream-helpers-design.md`

**Verification gate (per task):** All four green before commit:
- `yarn workspace @valve-tech/gas-oracle typecheck`
- `yarn workspace @valve-tech/gas-oracle test`
- `yarn workspace @valve-tech/gas-oracle lint`
- `yarn workspace @valve-tech/gas-oracle test:coverage` — 100/100/100/100

**Working directory throughout:** `/Users/michaelmclaughlin/Documents/3commascapital/gitlab/pulsechainorg/pulsechain/gas-oracle`

---

## Task 1: Const-namespace refactor (Section 1A)

**Dependencies:** None — first commit on top of `b3caa04` (spec commit).

**Files:**
- Modify: `packages/gas-oracle/src/types.ts` — add const namespaces for `PriorityModel`, `TierName`, `Trend`, `TxType`; keep type aliases as derived
- Modify: `packages/gas-oracle/src/math.ts` — replace literal `'flat'`/`'eip1559'`/`'rising'`/`'falling'`/`'stable'`/`'slow'`/`'standard'`/`'fast'`/`'instant'` with const refs
- Modify: `packages/gas-oracle/src/oracle.ts` — same
- Modify: `packages/gas-oracle/src/samples.ts` — same; replace `txType >= 2` numeric magic with `TxType.eip1559` ref where applicable
- Modify: `packages/gas-oracle/src/block-position.ts` — same (Trend/TierName uses)
- Modify: `packages/gas-oracle/src/transport.ts`, `mempool.ts`, `viem-actions.ts`, `viem-transport.ts` — magic-string audit
- Modify: `packages/gas-oracle/src/index.ts` — add value re-exports for `PriorityModel`, `TierName`, `Trend`, `TxType`
- Modify: `packages/gas-oracle/src/*.test.ts` — every test file with literal magic strings

**Test:** Existing test suite is the spec for behavior. No new tests added in this task. The type system catches missed migrations (literals at non-string-typed positions remain literal; literals at `PriorityModel`-typed positions still satisfy the type, so the migration is style discipline enforced by review + grep, not solely by `tsc`).

- [ ] **Step 1: Verify clean baseline.**

```bash
yarn workspace @valve-tech/gas-oracle typecheck && \
yarn workspace @valve-tech/gas-oracle test && \
yarn workspace @valve-tech/gas-oracle lint
```

Expected: All green. (Establishes the green-pre-refactor baseline; if anything fails, stop and resolve before proceeding.)

- [ ] **Step 2: Add const namespaces in `types.ts`.**

Replace the existing type aliases for `PriorityModel`, `TierName`, `Trend` (and add new `TxType`) with const-namespace pairs. Keep the same identifier for both value and type.

```ts
// types.ts — replaces lines defining `export type PriorityModel = 'flat' | 'eip1559'` etc.

export const PriorityModel = {
  flat: 'flat',
  eip1559: 'eip1559',
} as const
export type PriorityModel = (typeof PriorityModel)[keyof typeof PriorityModel]

export const TierName = {
  slow: 'slow',
  standard: 'standard',
  fast: 'fast',
  instant: 'instant',
} as const
export type TierName = (typeof TierName)[keyof typeof TierName]

export const Trend = {
  rising: 'rising',
  falling: 'falling',
  stable: 'stable',
} as const
export type Trend = (typeof Trend)[keyof typeof Trend]

/**
 * EIP-2718 transaction type bytes. Identifier values — never participate
 * in arithmetic, so they stay `number` per the package-wide bigint
 * carve-out.
 */
export const TxType = {
  legacy: 0,
  eip2930: 1,
  eip1559: 2,
  blob: 3,
  setCodeAuthorization: 4,
} as const
export type TxType = (typeof TxType)[keyof typeof TxType]
```

- [ ] **Step 3: Re-export const namespaces from `index.ts`.**

Add value re-exports (the existing `export type ... from './types.js'` line stays; we add a parallel value-level export):

```ts
// index.ts — add after the existing `export type { ... } from './types.js'` block
export { PriorityModel, TierName, Trend, TxType } from './types.js'
```

- [ ] **Step 4: Run typecheck to find migration sites.**

```bash
yarn workspace @valve-tech/gas-oracle typecheck
```

Expected: PASS — adding const namespaces doesn't break anything; existing literal usages still satisfy their types via TS literal-type narrowing.

- [ ] **Step 5: Find every literal usage to migrate.**

```bash
cd packages/gas-oracle && \
grep -rnE "'(flat|eip1559|slow|standard|fast|instant|rising|falling|stable)'" src/ | \
  grep -v "// " | \
  awk -F: '{print $1}' | sort -u
```

Expected: List of files. Should match the Files: Modify section above (`math.ts`, `oracle.ts`, `samples.ts`, `block-position.ts`, plus several `*.test.ts`). Note any files not listed — they need adding.

- [ ] **Step 6: Replace literal usages file-by-file.**

For each non-test file in the migration list, replace literals with const references. Pattern:

```ts
// Before
const priorityModel: PriorityModel = input.priorityModel ?? 'flat'
if (priorityModel === 'eip1559') { /* ... */ }

// After
const priorityModel: PriorityModel = input.priorityModel ?? PriorityModel.flat
if (priorityModel === PriorityModel.eip1559) { /* ... */ }
```

Same pattern for `TierName.slow`/`TierName.standard`/`TierName.fast`/`TierName.instant`, `Trend.rising`/`Trend.falling`/`Trend.stable`.

For `samples.ts:19` (priorityModel filter): currently `tx.txType >= 2` or similar — leave the `>= 2` form since it's a numeric range comparison, but add a `TxType.eip1559` ref where it makes the intent clearer. (Audit at the actual call site; if a single-equality compare exists, replace `=== 2` with `=== TxType.eip1559`. Range compares stay numeric.)

After each file, run typecheck to confirm no regressions:

```bash
yarn workspace @valve-tech/gas-oracle typecheck
```

- [ ] **Step 7: Replace literal usages in test files.**

Apply the same pattern across every `*.test.ts` file in the migration list. Test files often have many sites — process file-by-file.

```ts
// Before (math.test.ts:585-586)
const flat = call({ ringSamples: ring, mempoolSamples: [], priorityModel: 'flat' })
const eip = call({ ringSamples: ring, mempoolSamples: [], priorityModel: 'eip1559' })

// After
const flat = call({ ringSamples: ring, mempoolSamples: [], priorityModel: PriorityModel.flat })
const eip = call({ ringSamples: ring, mempoolSamples: [], priorityModel: PriorityModel.eip1559 })
```

Add a single import line at the top of each migrated test file:

```ts
import { PriorityModel, TierName, Trend, TxType } from '../src/index.js'
// or directly from types.js — match the existing import convention in each file
```

(If a file already imports `PriorityModel` as a type, replace with a value+type import. TS allows the same identifier for both.)

- [ ] **Step 8: Verification gate.**

```bash
yarn workspace @valve-tech/gas-oracle typecheck && \
yarn workspace @valve-tech/gas-oracle test && \
yarn workspace @valve-tech/gas-oracle lint && \
yarn workspace @valve-tech/gas-oracle test:coverage
```

Expected: All green; coverage holds 100/100/100/100. The refactor is mechanical and behavior-preserving.

- [ ] **Step 9: Spot-check no literal magic strings remain.**

```bash
cd packages/gas-oracle && \
grep -rnE "'(flat|eip1559|slow|standard|fast|instant|rising|falling|stable)'" src/ | \
  grep -vE "^[^:]+:[0-9]+:.*// " | \
  grep -vE "JSDoc|in JSDoc"
```

Expected: empty output (only docstrings or comments mentioning the values, never code-level literals). If anything appears, finish migration before committing.

- [ ] **Step 10: Commit.**

```bash
git add -A packages/gas-oracle/src && \
git commit -m "$(cat <<'EOF'
refactor(gas-oracle): const namespaces for PriorityModel/TierName/Trend/TxType

Lift every string-union type in the package to a const-namespace pair:
the value object (`as const`) and the derived type alias share the
identifier, so call sites use `PriorityModel.flat` / `TierName.slow` /
`Trend.rising` instead of bare string literals. Adds `TxType` covering
the EIP-2718 type bytes (legacy/eip2930/eip1559/blob/setCodeAuthorization).

Why: prepares the package for the v0.8.0 upstream-helpers landing — every
new helper consumes these constants, and the project-wide rule "no magic
strings" is now enforceable by review (grep for bare literals → empty).
No behavior change; tests continue to pass unchanged in semantics.
EOF
)"
```

---

## Task 2: BigInt migration for math values (Section 1B)

**Dependencies:** Task 1 (const namespaces are referenced in test fixtures).

**Files:**
- Modify: `packages/gas-oracle/src/types.ts` — change `MempoolStats.pendingCount`/`queuedCount` from `number` to `bigint`; change `BlockPositionQuery.rank`/`percentile` and `BlockPositionResult.rank` (in `block-position.ts`) from `number` to `bigint`
- Modify: `packages/gas-oracle/src/oracle.ts` — change `CreateGasOracleOptions.pollIntervalMs` from `number` to `bigint`; convert at the `setInterval`/`setTimeout` boundary via `Number(pollIntervalMs)`
- Modify: `packages/gas-oracle/src/block-position.ts` — internal loop counters to bigint; `Number(i)` only at array-access points; pass-through bigints in input/output
- Modify: any file consuming the migrated fields (find via typecheck errors)
- Modify: `packages/gas-oracle/src/*.test.ts` — every test passing `0`/`1`/`100` to a now-bigint position needs `0n`/`1n`/`100n`

**Test:** Existing test suite. No new behavior, just type discipline.

- [ ] **Step 1: Verify Task 1 baseline green.**

```bash
yarn workspace @valve-tech/gas-oracle typecheck && \
yarn workspace @valve-tech/gas-oracle test
```

Expected: Both green.

- [ ] **Step 2: Migrate `MempoolStats` to bigint counts.**

```ts
// types.ts — modify MempoolStats
export interface MempoolStats {
  pendingCount: bigint
  queuedCount: bigint
  /** Sum of `tx.gas` across all pending txs — congestion proxy. */
  pendingGasDemand: bigint
  /** Latest block's gas limit, useful for "pending demand vs. block capacity". */
  blockGasLimit: bigint
}
```

- [ ] **Step 3: Find producer sites — fix conversions.**

```bash
yarn workspace @valve-tech/gas-oracle typecheck 2>&1 | head -40
```

Expected: errors at sites where `pendingCount`/`queuedCount` are constructed from `number`. Fix by `BigInt(rawCount)` at the producer boundary (e.g., wherever `txpool_content` array lengths get assigned).

- [ ] **Step 4: Migrate `BlockPositionQuery` and `BlockPositionResult` to bigint rank/percentile.**

```ts
// block-position.ts
export type BlockPositionQuery =
  | { kind: 'rank'; rank: bigint }
  | { kind: 'percentile'; percentile: bigint }
  | { kind: 'gasFromTop'; gas: bigint }
  | { kind: 'aheadOf'; tx: TxIdentifier }
  | { kind: 'behind'; tx: TxIdentifier }

export interface BlockPositionResult {
  requiredTip: bigint
  pivot: TipSample | null
  rank: bigint
  gasFromTop: bigint
}
```

- [ ] **Step 5: Update `tipForBlockPosition` internals — bigint everywhere, `Number(i)` only at array access.**

Replace `pivotIndex: number` with `pivotIndex: bigint`. Loop counters via `for (let i = 0n; i < BigInt(sorted.length); i += 1n)`. Array access via `sorted[Number(i)]`. `findIndex` returns number — `BigInt()`-convert immediately. Update existing helpers `indexAtGasOffset` and `sumGasUpTo` with same pattern.

```ts
// block-position.ts — rewrite indexAtGasOffset
const indexAtGasOffset = (sorted: TipSample[], targetGas: bigint): bigint => {
  if (targetGas <= 0n) return 0n
  let cumulative = 0n
  const len = BigInt(sorted.length)
  for (let i = 0n; i < len; i += 1n) {
    cumulative += sorted[Number(i)].gas
    if (cumulative > targetGas) return i
  }
  return -1n
}

const sumGasUpTo = (sorted: TipSample[], indexExclusive: bigint): bigint => {
  let g = 0n
  const len = BigInt(sorted.length)
  const upper = indexExclusive < len ? indexExclusive : len
  for (let i = 0n; i < upper; i += 1n) g += sorted[Number(i)].gas
  return g
}

const empty = (): BlockPositionResult => ({
  requiredTip: 0n,
  pivot: null,
  rank: 0n,
  gasFromTop: 0n,
})
```

In the `tipForBlockPosition` switch, treat `pivotIndex: bigint` and the percentile branch's clamp via bigint:

```ts
case 'percentile': {
  // 0% = top of block (highest tip); 100% = bottom. Clamp to [0n, 100n].
  const pct = query.percentile < 0n
    ? 0n
    : query.percentile > 100n
      ? 100n
      : query.percentile
  const len = BigInt(sorted.length)
  pivotIndex = (len * pct) / 100n
  if (pivotIndex >= len) pivotIndex = len - 1n
  beatPivot = true
  break
}
case 'rank': {
  pivotIndex = query.rank
  beatPivot = true
  break
}
```

For `aheadOf`/`behind`, `findIndex` returns number — convert at boundary:

```ts
case 'aheadOf':
case 'behind': {
  const found = sorted.findIndex((s) => matchesIdentifier(s, query.tx))
  pivotIndex = found === -1 ? -1n : BigInt(found)
  beatPivot = query.kind === 'aheadOf'
  break
}
```

End-of-function shape:

```ts
if (pivotIndex < 0n || pivotIndex >= BigInt(sorted.length)) {
  return {
    requiredTip: 0n,
    pivot: null,
    rank: BigInt(sorted.length),
    gasFromTop: sumGasUpTo(sorted, BigInt(sorted.length)),
  }
}

const pivot = sorted[Number(pivotIndex)]
const requiredTip = beatPivot
  ? pivot.tip + 1n
  : pivot.tip > 0n ? pivot.tip - 1n : 0n

return {
  requiredTip,
  pivot,
  rank: pivotIndex,
  gasFromTop: sumGasUpTo(sorted, pivotIndex),
}
```

- [ ] **Step 6: Migrate `pollIntervalMs` to bigint with conversion at `setInterval` boundary.**

```ts
// oracle.ts CreateGasOracleOptions
pollIntervalMs?: bigint
```

Find the `setInterval` / `setTimeout` call site (likely `oracle.ts` start function or chain-source consumer):

```ts
// at the call site
setInterval(pollOnce, Number(pollIntervalMs))
```

Update the default literal — search for `DEFAULT_POLL_INTERVAL_MS`:

```ts
// oracle.ts
const DEFAULT_POLL_INTERVAL_MS = 10_000n   // was: 10_000
```

If `DEFAULT_POLL_INTERVAL_MS` is exported or used as a number elsewhere, convert at the use site rather than changing the constant — match existing convention.

- [ ] **Step 7: Update test files — literal `0`/`1`/`100` etc. at bigint positions become `0n`/`1n`/`100n`.**

```bash
yarn workspace @valve-tech/gas-oracle typecheck 2>&1 | head -40
```

Iterate file-by-file based on the typecheck errors. Common sites:
- `BlockPositionQuery.rank: 5` → `5n`
- `BlockPositionQuery.percentile: 50` → `50n`
- Test fixtures asserting `result.rank === 3` → `result.rank === 3n`
- `mempool: { pendingCount: 10, queuedCount: 0, ... }` → `pendingCount: 10n, queuedCount: 0n`
- `pollIntervalMs: 5000` → `5000n`

After each file, run typecheck to drive forward:

```bash
yarn workspace @valve-tech/gas-oracle typecheck 2>&1 | head -20
```

When typecheck is clean, run the test suite:

```bash
yarn workspace @valve-tech/gas-oracle test
```

- [ ] **Step 8: Verification gate.**

```bash
yarn workspace @valve-tech/gas-oracle typecheck && \
yarn workspace @valve-tech/gas-oracle test && \
yarn workspace @valve-tech/gas-oracle lint && \
yarn workspace @valve-tech/gas-oracle test:coverage
```

Expected: All green; coverage holds 100/100/100/100.

- [ ] **Step 9: Commit.**

```bash
git add -A packages/gas-oracle/src && \
git commit -m "$(cat <<'EOF'
refactor(gas-oracle): bigint for numeric values that participate in math

Migrate every public numeric field that takes part in arithmetic to
bigint: MempoolStats.pendingCount/queuedCount, BlockPositionQuery.rank,
BlockPositionQuery.percentile, BlockPositionResult.rank, and
CreateGasOracleOptions.pollIntervalMs. Loop counters in block-position
become bigint; Number(i) conversion lives only at array-access boundaries
(arr[Number(i)]) and at the setInterval(_, Number(ms)) timer call.

Identifier-like fields (chainId, EIP-2718 type bytes) stay number per the
documented carve-out — they never participate in math.

Why: project-wide style rule lands across the package in one mechanical
pass so future contributors can't accidentally re-introduce loss-of-
precision number arithmetic on Wei-scale values. No behavior change.
EOF
)"
```

---

## Task 3: Default `priorityModel` flip to `eip1559`

**Dependencies:** Tasks 1 and 2.

**Files:**
- Modify: `packages/gas-oracle/src/oracle.ts:445` — `?? 'flat'` → `?? PriorityModel.eip1559`
- Modify: `packages/gas-oracle/src/math.ts:338` — `?? 'flat'` → `?? PriorityModel.eip1559`
- Modify: `packages/gas-oracle/src/oracle.test.ts` and `packages/gas-oracle/src/math.test.ts` — audit every test using chain 369 or chain 1/8453 without explicit `priorityModel`; make the model explicit where the test asserts model-specific behavior; add a new test asserting the default is `eip1559`
- Test: `packages/gas-oracle/src/oracle.test.ts` — new test for default behavior

- [ ] **Step 1: Write a failing test asserting the new default.**

Append to `packages/gas-oracle/src/oracle.test.ts`:

```ts
describe('default priorityModel', () => {
  it('defaults to PriorityModel.eip1559 when not provided', async () => {
    // A block whose paying lane (type-2 txs) and slow lane (type-0 legacy)
    // produce different tier values. Under the eip1559 default, paying-lane
    // tiers must come from type-2-only samples.
    const ringSamples = [
      // High-tip type-0 (legacy) — should be EXCLUDED from paying lanes
      // under eip1559 model
      { tip: 100n, gas: 21_000n, txType: TxType.legacy, hash: '0xa', address: '0x1', nonce: '1' },
      { tip: 95n, gas: 21_000n, txType: TxType.legacy, hash: '0xb', address: '0x2', nonce: '1' },
      // Lower-tip type-2 (eip1559) — these drive paying-lane tiers
      { tip: 10n, gas: 21_000n, txType: TxType.eip1559, hash: '0xc', address: '0x3', nonce: '1' },
      { tip: 12n, gas: 21_000n, txType: TxType.eip1559, hash: '0xd', address: '0x4', nonce: '1' },
    ] satisfies TipSample[]

    const next = reducePollInputs({
      chainId: 1,
      blockNumber: 100n,
      timestamp: 0n,
      baseFee: 1n,
      baseFeeHistory: [1n],
      ringSamples,
      mempoolSamples: [],
      mempool: { pendingCount: 0n, queuedCount: 0n, pendingGasDemand: 0n, blockGasLimit: 30_000_000n },
      blob: null,
      // priorityModel intentionally omitted
    })

    // Under eip1559 default, the instant tier reflects the type-2 distribution
    // (top tip 12n), NOT the full mixed distribution (which would be 100n).
    expect(next.tiers[TierName.instant].maxPriorityFeePerGas).toBeLessThanOrEqual(12n)
    expect(next.tiers[TierName.instant].maxPriorityFeePerGas).toBeGreaterThan(0n)
  })
})
```

- [ ] **Step 2: Run the test — it should fail (current default is `'flat'`).**

```bash
yarn workspace @valve-tech/gas-oracle test -- oracle.test --run --reporter=verbose
```

Expected: FAIL — under the current `'flat'` default, instant tier reflects the full distribution (top tip 100n).

- [ ] **Step 3: Flip the default in `oracle.ts:445`.**

```ts
// oracle.ts — locate `priorityModel: input.priorityModel,` (around line 445)
// In the call to `reducePollInputs(...)`, the default lives in `reducePollInputs` itself,
// not in oracle.ts. Confirm by checking math.ts:338.
```

If the literal `?? 'flat'` is now `?? PriorityModel.flat` (post Task 1), update to `?? PriorityModel.eip1559`:

```ts
// math.ts:338 (in reducePollInputs)
const priorityModel: PriorityModel = input.priorityModel ?? PriorityModel.eip1559
```

```ts
// oracle.ts — also check around line 445; if there's a separate default fallback, update it too.
```

- [ ] **Step 4: Run the new test — should pass.**

```bash
yarn workspace @valve-tech/gas-oracle test -- oracle.test --run --reporter=verbose
```

Expected: the new "defaults to PriorityModel.eip1559" test PASSES.

- [ ] **Step 5: Run full test suite — find tests that broke from the flip.**

```bash
yarn workspace @valve-tech/gas-oracle test 2>&1 | tail -60
```

Expected: a handful of failures. For each:
- If the test asserts behavior under `'flat'` semantics on chain 369 (or any chain), add an explicit `priorityModel: PriorityModel.flat` to its setup.
- If the test asserts behavior under `'eip1559'` semantics on Mainnet/Base, no change (it now matches the default).
- If the test passes either way (assertion is independent of the model), no change needed but verify.

Common sites:
- `oracle.test.ts:1532` already has `priorityModel: 'flat'` (now `PriorityModel.flat`) — explicit, no change.
- `oracle.test.ts:49` (`chainId: 369`) — depends on what's asserted; likely add `priorityModel: PriorityModel.flat`.
- `oracle.test.ts:679-704` — the eip1559-vs-flat differential test; explicitly sets both, no change.
- `viem-actions.test.ts:58` — no `priorityModel`; check if assertions depend on it.

- [ ] **Step 6: Update broken tests by adding explicit `priorityModel` where needed.**

Example:

```ts
// Before — relies on 'flat' default for chain 369 behavior
const oracle = createGasOracle({ client, chainId: 369 })

// After — explicit
const oracle = createGasOracle({ client, chainId: 369, priorityModel: PriorityModel.flat })
```

After each fix, re-run:

```bash
yarn workspace @valve-tech/gas-oracle test
```

- [ ] **Step 7: Update README example (`packages/gas-oracle/README.md:39`).**

Skim the README block at line 39 (currently shows `priorityModel: 'eip1559'`) — note this is now redundant in the example since it's the default. The full README rewrite happens in Task 9, but at minimum verify the README doesn't ASSERT a 'flat' default anywhere.

- [ ] **Step 8: Verification gate.**

```bash
yarn workspace @valve-tech/gas-oracle typecheck && \
yarn workspace @valve-tech/gas-oracle test && \
yarn workspace @valve-tech/gas-oracle lint && \
yarn workspace @valve-tech/gas-oracle test:coverage
```

Expected: All green; coverage holds 100/100/100/100.

- [ ] **Step 9: Commit.**

```bash
git add -A packages/gas-oracle/src && \
git commit -m "$(cat <<'EOF'
feat(gas-oracle): default priorityModel to eip1559

Flip the createGasOracle / reducePollInputs default from
PriorityModel.flat to PriorityModel.eip1559. Most chains honor the
EIP-2718 type byte and the EIP-1559 fee-market shape; defaulting to
the right behavior for the majority case avoids silent under-pricing
on consumers that don't know to set the option.

PulseChain (chain 369) becomes the canonical exception — explicitly set
priorityModel: PriorityModel.flat (or use ...chainPresets.pulsechain
once Task 8 lands). Tests asserting flat-model behavior on chain 369
are updated to set the model explicitly; chains where assertions
already align with eip1559 need no change.

Why: pre-shipped default change — package hasn't released v0.8.0 yet,
so no consumer is broken. Captures the design decision that "default has
to be right per chain"; the named exception is more honest than guessing.
EOF
)"
```

---

## Task 4: Preserve `mempoolSamples` on `GasOracleState`

**Dependencies:** Tasks 1, 2, 3.

**Files:**
- Modify: `packages/gas-oracle/src/types.ts` — add `mempoolSamples: TipSample[]` to `GasOracleState` with producer-local JSDoc
- Modify: `packages/gas-oracle/src/oracle.ts` — preserve mempool samples on the produced state instead of discarding after tier computation
- Modify: `packages/gas-oracle/src/math.ts` — `reducePollInputs` returns `mempoolSamples` on the resulting state
- Modify: `packages/gas-oracle/src/oracle.test.ts`, `math.test.ts` — fixtures pass and assert `mempoolSamples`

- [ ] **Step 1: Add `mempoolSamples` to the `GasOracleState` type.**

```ts
// types.ts — within GasOracleState interface
export interface GasOracleState {
  // ...existing fields
  /**
   * Live mempool samples used to compute this snapshot's tiers.
   * Producer-local — wire publishers should strip before serializing
   * (same convention as `ring`). Consumed by replacement / classification
   * helpers (e.g., `recommendBumpTier`'s outpace correction) for live-
   * distribution analysis without re-fetching mempool data.
   */
  mempoolSamples: TipSample[]
}
```

- [ ] **Step 2: Write failing test — state preserves mempool samples.**

Add to `packages/gas-oracle/src/oracle.test.ts`:

```ts
it('preserves mempoolSamples on the published state', () => {
  const mempoolSamples: TipSample[] = [
    { tip: 5n, gas: 21_000n, txType: TxType.eip1559, hash: '0xm1', address: '0x1', nonce: '1' },
    { tip: 8n, gas: 21_000n, txType: TxType.eip1559, hash: '0xm2', address: '0x2', nonce: '1' },
  ]
  const next = reducePollInputs({
    chainId: 1,
    blockNumber: 100n,
    timestamp: 0n,
    baseFee: 1n,
    baseFeeHistory: [1n],
    ringSamples: [],
    mempoolSamples,
    mempool: { pendingCount: 2n, queuedCount: 0n, pendingGasDemand: 42_000n, blockGasLimit: 30_000_000n },
    blob: null,
  })

  expect(next.mempoolSamples).toHaveLength(2)
  expect(next.mempoolSamples[0]).toEqual(mempoolSamples[0])
  expect(next.mempoolSamples[1]).toEqual(mempoolSamples[1])
})
```

- [ ] **Step 3: Run the test — should fail.**

```bash
yarn workspace @valve-tech/gas-oracle test -- oracle.test --run --reporter=verbose
```

Expected: FAIL — `next.mempoolSamples` is `undefined`.

- [ ] **Step 4: Update `reducePollInputs` in `math.ts` to thread mempool samples through.**

Locate `reducePollInputs` and find its return value (the constructed `GasOracleState`). Add `mempoolSamples` to the returned object using the input's `mempoolSamples` field:

```ts
// math.ts — return value of reducePollInputs
return {
  chainId: input.chainId,
  blockNumber: input.blockNumber,
  timestamp: input.timestamp,
  baseFee: input.baseFee,
  baseFeeTrend: detectTrend(input.baseFeeHistory),
  baseFeeHistory: input.baseFeeHistory,
  mempool: input.mempool,
  blob: input.blob,
  tiers,
  ring: ringNext,
  mempoolSamples: input.mempoolSamples,   // NEW
  // existing lastPublishedTips/lastPublishedBlockNumber threading unchanged
}
```

If `reducePollInputs`'s input type doesn't already include `mempoolSamples`, audit — it likely does (it's already used to feed `computeTiers`). If not, add the field to the input interface.

- [ ] **Step 5: Run the test — should pass.**

```bash
yarn workspace @valve-tech/gas-oracle test -- oracle.test --run --reporter=verbose
```

Expected: PASS.

- [ ] **Step 6: Update `oracle.ts` poll cycle to pass mempool samples through.**

Locate where `oracle.ts` calls `reducePollInputs` (around line 304). Verify `mempoolSamples` is already provided. If not, derive from the polled mempool data.

- [ ] **Step 7: Audit every test fixture constructing `GasOracleState` — add `mempoolSamples: []` where missing.**

```bash
yarn workspace @valve-tech/gas-oracle typecheck 2>&1 | head -40
```

Expected: errors at every fixture missing `mempoolSamples`. Add `mempoolSamples: []` (or a meaningful sample list) to each.

- [ ] **Step 8: Verification gate.**

```bash
yarn workspace @valve-tech/gas-oracle typecheck && \
yarn workspace @valve-tech/gas-oracle test && \
yarn workspace @valve-tech/gas-oracle lint && \
yarn workspace @valve-tech/gas-oracle test:coverage
```

Expected: All green; coverage holds 100/100/100/100.

- [ ] **Step 9: Commit.**

```bash
git add -A packages/gas-oracle/src && \
git commit -m "$(cat <<'EOF'
feat(gas-oracle): preserve mempoolSamples on GasOracleState

Stop discarding mempool samples after tier computation. The samples
that produced the snapshot's tiers are preserved on the resulting
GasOracleState as `mempoolSamples`, ready for downstream helpers
(recommendBumpTier's outpace correction, classifyTip's distribution
position) to analyze the live distribution without re-fetching.

Producer-local convention applies (same as `ring`): wire publishers
strip before serializing. Each poll replaces the field; no cumulative
growth.
EOF
)"
```

---

## Task 5: Replacement helpers (`replacement.ts`)

**Dependencies:** Tasks 1-4.

**Files:**
- Create: `packages/gas-oracle/src/replacement.ts`
- Create: `packages/gas-oracle/src/replacement.test.ts`
- Modify: `packages/gas-oracle/src/index.ts` — add re-exports

- [ ] **Step 1: Write failing test for `minimumReplacementFee` — table-driven against geth's threshold semantics.**

Create `packages/gas-oracle/src/replacement.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import {
  minimumReplacementFee,
  bumpForReplacement,
  recommendBumpTier,
  BumpStrategy,
  ReplacementBumpPercent,
} from './replacement.js'
import { PriorityModel, TierName, TxType, type GasOracleState, type TipSample } from './types.js'

describe('minimumReplacementFee', () => {
  // Table: [current, txType, expectedMinimum]
  // Verified against geth/legacypool list.go:Add — both
  // strict-greater-than and >=110% threshold checks.
  const cases: Array<[bigint, number, bigint]> = [
    [0n, TxType.eip1559, 1n],          // floor=0, +1 to clear strict-greater
    [1n, TxType.eip1559, 2n],          // floor=floor(11/10)=1, +1
    [9n, TxType.eip1559, 10n],         // floor=floor(99/10)=9, +1
    [10n, TxType.eip1559, 12n],        // floor=floor(110/10)=11, +1
    [80n, TxType.eip1559, 89n],        // floor=floor(880/10)=88, +1
    [83n, TxType.eip1559, 92n],        // floor=floor(913/10)=91, +1
    [100n, TxType.eip1559, 111n],      // floor=110, +1
    [TxType.legacy, TxType.legacy, 1n],  // 0n input via legacy type byte
  ]

  it.each(cases)('current=%s txType=%s → minimum=%s', (current, txType, expected) => {
    expect(minimumReplacementFee(current, txType)).toBe(expected)
  })

  it('blob txs use +100% bump', () => {
    // current=100, +100% = 200, +1 = 201
    expect(minimumReplacementFee(100n, TxType.blob)).toBe(201n)
    expect(minimumReplacementFee(0n, TxType.blob)).toBe(1n)
    expect(minimumReplacementFee(50n, TxType.blob)).toBe(101n)
  })

  it('unknown future txTypes default to legacy bump', () => {
    expect(minimumReplacementFee(100n, 99)).toBe(111n)   // unknown type byte
  })
})

describe('ReplacementBumpPercent', () => {
  it('exposes the geth/reth defaults', () => {
    expect(ReplacementBumpPercent.default).toBe(10n)
    expect(ReplacementBumpPercent.blob).toBe(100n)
  })
})
```

- [ ] **Step 2: Run the test — should fail (file doesn't exist).**

```bash
yarn workspace @valve-tech/gas-oracle test -- replacement.test --run --reporter=verbose 2>&1 | head -20
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `minimumReplacementFee` and `ReplacementBumpPercent`.**

Create `packages/gas-oracle/src/replacement.ts`:

```ts
/**
 * Same-nonce EIP-1559 replacement helpers. Pure functions; no I/O.
 *
 * The protocol-replacement-floor math is verified against geth
 * `core/txpool/legacypool/list.go:Add()`, geth `core/txpool/blobpool/
 * config.go`, reth `crates/transaction-pool/src/config.rs`, and PulseChain
 * `gitlab.com/pulsechaincom/go-pulse/master/core/txpool/legacypool/
 * legacypool.go`. The `+1n` term in `minimumReplacementFee` is load-
 * bearing for small `current` values where geth's integer-floor threshold
 * collapses below the strict `old < tx` check.
 */

import { TierName, TxType, type GasOracleState, type TipSample } from './types.js'
import type { TxIdentifier } from './mempool.js'
import { tipForBlockPosition } from './block-position.js'

export const ReplacementBumpPercent = {
  /** geth `legacypool.DefaultConfig.PriceBump` — legacy / EIP-2930 / EIP-1559 / EIP-7702. */
  default: 10n,
  /** geth `blobpool.DefaultConfig.PriceBump` — EIP-4844 blob txs. */
  blob: 100n,
} as const

export const minimumReplacementFee = (
  current: bigint,
  txType: number,
): bigint => {
  const bump = txType === TxType.blob
    ? ReplacementBumpPercent.blob
    : ReplacementBumpPercent.default
  return (current * (100n + bump)) / 100n + 1n
}
```

- [ ] **Step 4: Run test — should pass for `minimumReplacementFee` and `ReplacementBumpPercent`.**

```bash
yarn workspace @valve-tech/gas-oracle test -- replacement.test --run --reporter=verbose
```

Expected: PASS for the implemented helpers.

- [ ] **Step 5: Add `bumpForReplacement` test.**

Append to `replacement.test.ts`:

```ts
describe('bumpForReplacement', () => {
  it('returns max(target, protocolFloor) for both fields', () => {
    const current = { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }
    const target = { maxFeePerGas: 200n, maxPriorityFeePerGas: 50n }
    const result = bumpForReplacement(current, target)
    // protocolFloor for maxFee = (100 * 110)/100 + 1 = 111
    // protocolFloor for tip   = (10  * 110)/100 + 1 = 12
    // both targets exceed floors, so target values used
    expect(result).toEqual({ maxFeePerGas: 200n, maxPriorityFeePerGas: 50n })
  })

  it('uses protocol floor when target is below it', () => {
    const current = { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }
    const target = { maxFeePerGas: 50n, maxPriorityFeePerGas: 5n }   // both below floors
    const result = bumpForReplacement(current, target)
    expect(result.maxFeePerGas).toBe(111n)   // floor
    expect(result.maxPriorityFeePerGas).toBe(12n)   // floor
  })

  it('guarantees maxFeePerGas >= maxPriorityFeePerGas (well-formed tx)', () => {
    // Degenerate input: target.maxFeePerGas < target.maxPriorityFeePerGas
    const current = { maxFeePerGas: 100n, maxPriorityFeePerGas: 10n }
    const target = { maxFeePerGas: 10n, maxPriorityFeePerGas: 200n }
    const result = bumpForReplacement(current, target)
    expect(result.maxFeePerGas).toBeGreaterThanOrEqual(result.maxPriorityFeePerGas)
  })
})
```

- [ ] **Step 6: Run — should fail.**

```bash
yarn workspace @valve-tech/gas-oracle test -- replacement.test --run --reporter=verbose
```

Expected: FAIL — `bumpForReplacement` not yet exported.

- [ ] **Step 7: Implement `bumpForReplacement`.**

Append to `replacement.ts`:

```ts
export interface ReplacementGas {
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

/**
 * Compute (maxFeePerGas, maxPriorityFeePerGas) for replacing a 1559 tx.
 * Per-field rule: max(target, protocolFloor). Final guard ensures
 * `result.maxFeePerGas >= result.maxPriorityFeePerGas` so the result is
 * a well-formed tx even on degenerate target inputs.
 *
 * 1559-scoped — for blob replacement use `minimumReplacementFee(_,
 * TxType.blob)` directly per fee field.
 */
export const bumpForReplacement = (
  currentGas: ReplacementGas,
  targetGas: ReplacementGas,
): ReplacementGas => {
  const maxFeeFloor = minimumReplacementFee(currentGas.maxFeePerGas, TxType.eip1559)
  const priorityFloor = minimumReplacementFee(currentGas.maxPriorityFeePerGas, TxType.eip1559)
  const maxPriorityFeePerGas = targetGas.maxPriorityFeePerGas > priorityFloor
    ? targetGas.maxPriorityFeePerGas
    : priorityFloor
  let maxFeePerGas = targetGas.maxFeePerGas > maxFeeFloor
    ? targetGas.maxFeePerGas
    : maxFeeFloor
  if (maxFeePerGas < maxPriorityFeePerGas) maxFeePerGas = maxPriorityFeePerGas
  return { maxFeePerGas, maxPriorityFeePerGas }
}
```

- [ ] **Step 8: Run — should pass.**

```bash
yarn workspace @valve-tech/gas-oracle test -- replacement.test --run --reporter=verbose
```

Expected: PASS.

- [ ] **Step 9: Add `BumpStrategy` + `recommendBumpTier` tests.**

Append to `replacement.test.ts`:

```ts
const buildSnapshot = (
  tiers: GasOracleState['tiers'],
  mempoolSamples: TipSample[] = [],
): GasOracleState => ({
  chainId: 1,
  blockNumber: 100n,
  timestamp: 0n,
  baseFee: 1n,
  baseFeeTrend: 'stable',
  baseFeeHistory: [1n],
  mempool: { pendingCount: 0n, queuedCount: 0n, pendingGasDemand: 0n, blockGasLimit: 30_000_000n },
  blob: null,
  tiers,
  ring: [],
  mempoolSamples,
})

const buildTiers = (slow: bigint, standard: bigint, fast: bigint, instant: bigint): GasOracleState['tiers'] => ({
  [TierName.slow]: { maxPriorityFeePerGas: slow, maxFeePerGas: slow * 2n, gasPrice: slow * 2n, maxFeePerBlobGas: null },
  [TierName.standard]: { maxPriorityFeePerGas: standard, maxFeePerGas: standard * 2n, gasPrice: standard * 2n, maxFeePerBlobGas: null },
  [TierName.fast]: { maxPriorityFeePerGas: fast, maxFeePerGas: fast * 2n, gasPrice: fast * 2n, maxFeePerBlobGas: null },
  [TierName.instant]: { maxPriorityFeePerGas: instant, maxFeePerGas: instant * 2n, gasPrice: instant * 2n, maxFeePerBlobGas: null },
})

describe('BumpStrategy', () => {
  it('exposes three named strategies', () => {
    expect(BumpStrategy.cheapestThatLands).toBe('cheapestThatLands')
    expect(BumpStrategy.oneStepFasterThanRecommended).toBe('oneStepFasterThanRecommended')
    expect(BumpStrategy.instant).toBe('instant')
  })
})

describe('recommendBumpTier', () => {
  const tiers = buildTiers(10n, 50n, 100n, 200n)
  const snapshot = buildSnapshot(tiers)

  it('default strategy is cheapestThatLands — picks lowest tier above protocol floor', () => {
    // current tip 5; floor = floor(5*11/10)+1 = 6
    // tiers: slow=10, standard=50, fast=100, instant=200
    // cheapest > 6 is slow (10)
    expect(recommendBumpTier(snapshot, { priorityTip: 5n })).toBe(TierName.slow)
  })

  it('cheapestThatLands strategy — explicit', () => {
    expect(recommendBumpTier(snapshot, { priorityTip: 30n }, { strategy: BumpStrategy.cheapestThatLands })).toBe(TierName.standard)
  })

  it('oneStepFasterThanRecommended bumps one tier above cheapest', () => {
    // current tip 5 → cheapest = slow → one step faster = standard
    expect(recommendBumpTier(snapshot, { priorityTip: 5n }, { strategy: BumpStrategy.oneStepFasterThanRecommended })).toBe(TierName.standard)
  })

  it('oneStepFasterThanRecommended caps at instant', () => {
    // current tip 110 → cheapest = instant (200 clears floor 122) → one step faster = instant (cap)
    expect(recommendBumpTier(snapshot, { priorityTip: 110n }, { strategy: BumpStrategy.oneStepFasterThanRecommended })).toBe(TierName.instant)
  })

  it('instant strategy returns instant when it clears the floor', () => {
    expect(recommendBumpTier(snapshot, { priorityTip: 5n }, { strategy: BumpStrategy.instant })).toBe(TierName.instant)
  })

  it('returns null when even instant does not clear the protocol floor', () => {
    // current tip 200 → floor = floor(200*11/10)+1 = 221
    // instant tier = 200 — does not clear 221
    expect(recommendBumpTier(snapshot, { priorityTip: 200n })).toBeNull()
  })

  it('outpace correction raises the floor when stuck-tx identifier provided', () => {
    // mempool has the stuck tx at tip 30, plus a competitor at tip 60
    const stuckHash = '0xstuck'
    const stuckSamples: TipSample[] = [
      { tip: 30n, gas: 21_000n, txType: TxType.eip1559, hash: stuckHash, address: '0x1', nonce: '1' },
      { tip: 60n, gas: 21_000n, txType: TxType.eip1559, hash: '0xother', address: '0x2', nonce: '1' },
    ]
    const snapshotWithMempool = buildSnapshot(tiers, stuckSamples)
    // outpace floor for the stuck tx = competitor.tip + 1 = 61 (need to outpace the competitor at 60)
    // protocol floor = floor(30*11/10)+1 = 34
    // effective floor = max(34, 61) = 61 — cheapest tier above that is fast (100)
    expect(recommendBumpTier(
      snapshotWithMempool,
      { priorityTip: 30n, identifier: { hash: stuckHash } },
    )).toBe(TierName.fast)
  })

  it('outpace identifier missing in mempool falls back to protocol floor', () => {
    const snapshotEmpty = buildSnapshot(tiers, [])
    // outpace floor = 0 (tx not found), protocol floor = 6 → cheapest = slow
    expect(recommendBumpTier(
      snapshotEmpty,
      { priorityTip: 5n, identifier: { hash: '0xnotpresent' } },
    )).toBe(TierName.slow)
  })

  it('returns null on empty/zero tiers', () => {
    const zeroSnapshot = buildSnapshot(buildTiers(0n, 0n, 0n, 0n))
    expect(recommendBumpTier(zeroSnapshot, { priorityTip: 0n })).toBeNull()
  })
})
```

- [ ] **Step 10: Run — should fail (BumpStrategy / recommendBumpTier not yet exported).**

```bash
yarn workspace @valve-tech/gas-oracle test -- replacement.test --run --reporter=verbose
```

Expected: FAIL.

- [ ] **Step 11: Implement `BumpStrategy` and `recommendBumpTier`.**

Append to `replacement.ts`:

```ts
export const BumpStrategy = {
  cheapestThatLands: 'cheapestThatLands',
  oneStepFasterThanRecommended: 'oneStepFasterThanRecommended',
  instant: 'instant',
} as const
export type BumpStrategy = (typeof BumpStrategy)[keyof typeof BumpStrategy]

export interface RecommendBumpTierOptions {
  /** Default: `BumpStrategy.cheapestThatLands`. */
  strategy?: BumpStrategy
}

const TIER_LADDER: readonly TierName[] = [
  TierName.slow,
  TierName.standard,
  TierName.fast,
  TierName.instant,
]

/**
 * Pick a tier to bump to for a same-nonce EIP-1559 replacement. The
 * effective floor is `max(protocolFloor, outpaceFloor)`:
 *   - protocolFloor = `minimumReplacementFee(stuckTx.priorityTip,
 *     TxType.eip1559)` — the geth +10% rule.
 *   - outpaceFloor = `tipForBlockPosition({ kind: 'aheadOf', tx:
 *     identifier }).requiredTip` over `snapshot.mempoolSamples`, when
 *     `stuckTx.identifier` is provided. Without identifier, this floor
 *     is `0n` and only the protocol floor applies.
 *
 * Returns `null` when no tier clears the effective floor — the original
 * was already paying above the top of the ladder, or the snapshot has
 * no tip data.
 */
export const recommendBumpTier = (
  snapshot: GasOracleState,
  stuckTx: { priorityTip: bigint; identifier?: TxIdentifier },
  options: RecommendBumpTierOptions = {},
): TierName | null => {
  const strategy = options.strategy ?? BumpStrategy.cheapestThatLands
  const protocolFloor = minimumReplacementFee(stuckTx.priorityTip, TxType.eip1559)
  const outpaceFloor = stuckTx.identifier
    ? tipForBlockPosition(snapshot.mempoolSamples, {
        kind: 'aheadOf',
        tx: stuckTx.identifier,
      }).requiredTip
    : 0n
  const floor = protocolFloor > outpaceFloor ? protocolFloor : outpaceFloor

  const cheapestIndex = TIER_LADDER.findIndex(
    (tier) => snapshot.tiers[tier].maxPriorityFeePerGas > floor,
  )
  if (cheapestIndex === -1) return null

  if (strategy === BumpStrategy.cheapestThatLands) return TIER_LADDER[cheapestIndex]
  if (strategy === BumpStrategy.instant) return TierName.instant
  // oneStepFasterThanRecommended
  return TIER_LADDER[Math.min(cheapestIndex + 1, TIER_LADDER.length - 1)]
}
```

- [ ] **Step 12: Run — should pass.**

```bash
yarn workspace @valve-tech/gas-oracle test -- replacement.test --run --reporter=verbose
```

Expected: PASS.

- [ ] **Step 13: Re-export from `index.ts`.**

```ts
// index.ts — append
export {
  minimumReplacementFee,
  bumpForReplacement,
  recommendBumpTier,
  BumpStrategy,
  ReplacementBumpPercent,
  type RecommendBumpTierOptions,
  type ReplacementGas,
} from './replacement.js'
```

- [ ] **Step 14: Verification gate.**

```bash
yarn workspace @valve-tech/gas-oracle typecheck && \
yarn workspace @valve-tech/gas-oracle test && \
yarn workspace @valve-tech/gas-oracle lint && \
yarn workspace @valve-tech/gas-oracle test:coverage
```

Expected: All green; coverage 100/100/100/100.

- [ ] **Step 15: Commit.**

```bash
git add -A packages/gas-oracle/src && \
git commit -m "$(cat <<'EOF'
feat(gas-oracle): replacement helpers — minimumReplacementFee, bumpForReplacement, recommendBumpTier

Three paired primitives for same-nonce EIP-1559 replacement, pure
functions over snapshot/inputs:

- `minimumReplacementFee(current, txType)` — protocol-replacement floor
  per fee field. +10% for legacy/1559/2930/7702 (geth legacypool default),
  +100% for blob txs (geth blobpool default). The +1n term clears geth's
  strict `old < tx` check at small values where the integer-floor
  threshold collapses.

- `bumpForReplacement(currentGas, targetGas)` — 1559-scoped per-field
  max(target, floor) with a final guard ensuring well-formed tx
  (maxFeePerGas >= maxPriorityFeePerGas).

- `recommendBumpTier(snapshot, stuckTx, options?)` — picks a TierName
  given the snapshot's tiers, the stuck tx's submitted priorityTip, and
  optionally an identifier for outpace correction (uses
  tipForBlockPosition over snapshot.mempoolSamples to compute the tip
  required to outpace the stuck tx in the live distribution). Strategies:
  cheapestThatLands (default) / oneStepFasterThanRecommended / instant.
  Returns null when the effective floor is unclearable.

Math verified against geth core/txpool/legacypool/list.go:Add and
blobpool config, reth crates/transaction-pool/src/config.rs, PulseChain
go-pulse legacypool. Tested with table-driven cases including small-value
edge cases (current=0,1,9,10,80,83,100) and outpace correction.
EOF
)"
```

---

## Task 6: `classifyTip` (`classify-tip.ts`)

**Dependencies:** Tasks 1-4 (uses `mempoolSamples`).

**Files:**
- Create: `packages/gas-oracle/src/classify-tip.ts`
- Create: `packages/gas-oracle/src/classify-tip.test.ts`
- Modify: `packages/gas-oracle/src/index.ts`

- [ ] **Step 1: Write failing test.**

Create `packages/gas-oracle/src/classify-tip.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { classifyTip } from './classify-tip.js'
import { TierName, TxType, type GasOracleState, type TipSample } from './types.js'

const buildSnapshot = (
  tiers: GasOracleState['tiers'],
  mempoolSamples: TipSample[] = [],
  ringTips: TipSample[] = [],
): GasOracleState => ({
  chainId: 1,
  blockNumber: 100n,
  timestamp: 0n,
  baseFee: 1n,
  baseFeeTrend: 'stable',
  baseFeeHistory: [1n],
  mempool: { pendingCount: 0n, queuedCount: 0n, pendingGasDemand: 0n, blockGasLimit: 30_000_000n },
  blob: null,
  tiers,
  ring: ringTips.length === 0 ? [] : [{
    number: 99n,
    hash: '0xb',
    parentHash: '0xp',
    baseFee: 1n,
    gasUsed: 0n,
    tips: ringTips,
  }],
  mempoolSamples,
})

const tiers: GasOracleState['tiers'] = {
  [TierName.slow]: { maxPriorityFeePerGas: 10n, maxFeePerGas: 20n, gasPrice: 20n, maxFeePerBlobGas: null },
  [TierName.standard]: { maxPriorityFeePerGas: 50n, maxFeePerGas: 100n, gasPrice: 100n, maxFeePerBlobGas: null },
  [TierName.fast]: { maxPriorityFeePerGas: 100n, maxFeePerGas: 200n, gasPrice: 200n, maxFeePerBlobGas: null },
  [TierName.instant]: { maxPriorityFeePerGas: 200n, maxFeePerGas: 400n, gasPrice: 400n, maxFeePerBlobGas: null },
}

describe('classifyTip', () => {
  it('tip below slow → tier null, requiredForNextTier = slow floor', () => {
    const result = classifyTip(buildSnapshot(tiers), 5n)
    expect(result.tier).toBeNull()
    expect(result.requiredForNextTier).toBe(10n)
  })

  it('tip exactly at slow → tier slow, requiredForNextTier = standard floor', () => {
    const result = classifyTip(buildSnapshot(tiers), 10n)
    expect(result.tier).toBe(TierName.slow)
    expect(result.requiredForNextTier).toBe(50n)
  })

  it('tip in standard band', () => {
    const result = classifyTip(buildSnapshot(tiers), 75n)
    expect(result.tier).toBe(TierName.standard)
    expect(result.requiredForNextTier).toBe(100n)
  })

  it('tip at instant → tier instant, requiredForNextTier null', () => {
    const result = classifyTip(buildSnapshot(tiers), 250n)
    expect(result.tier).toBe(TierName.instant)
    expect(result.requiredForNextTier).toBeNull()
  })

  it('empty distribution → percentile/rank/gasFromTop all 0n', () => {
    const result = classifyTip(buildSnapshot(tiers), 50n)
    expect(result.percentile).toBe(0n)
    expect(result.rank).toBe(0n)
    expect(result.gasFromTop).toBe(0n)
  })

  it('with samples → percentile/rank/gasFromTop reflect distribution', () => {
    const samples: TipSample[] = [
      { tip: 100n, gas: 21_000n, txType: TxType.eip1559, hash: '0xa', address: '0x1', nonce: '1' },
      { tip: 80n, gas: 21_000n, txType: TxType.eip1559, hash: '0xb', address: '0x2', nonce: '1' },
      { tip: 60n, gas: 21_000n, txType: TxType.eip1559, hash: '0xc', address: '0x3', nonce: '1' },
      { tip: 40n, gas: 21_000n, txType: TxType.eip1559, hash: '0xd', address: '0x4', nonce: '1' },
    ]
    // Sorted desc by tip: 100, 80, 60, 40 — tip=70 lands between 80 and 60 (rank=2)
    const result = classifyTip(buildSnapshot(tiers, samples), 70n)
    expect(result.rank).toBe(2n)
    expect(result.percentile).toBe(50n)   // round(2/4 * 100) = 50
    expect(result.gasFromTop).toBe(42_000n)   // sum of first two samples
  })

  it('combines mempool + ring samples for distribution', () => {
    const mempoolSamples: TipSample[] = [
      { tip: 100n, gas: 21_000n, txType: TxType.eip1559, hash: '0xm1', address: '0x1', nonce: '1' },
    ]
    const ringTips: TipSample[] = [
      { tip: 80n, gas: 21_000n, txType: TxType.eip1559, hash: '0xr1', address: '0x2', nonce: '1' },
    ]
    // Combined desc: 100, 80 — tip=90 lands at rank 1 (between)
    const result = classifyTip(buildSnapshot(tiers, mempoolSamples, ringTips), 90n)
    expect(result.rank).toBe(1n)
  })
})
```

- [ ] **Step 2: Run — should fail.**

```bash
yarn workspace @valve-tech/gas-oracle test -- classify-tip.test --run --reporter=verbose
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `classifyTip`.**

Create `packages/gas-oracle/src/classify-tip.ts`:

```ts
/**
 * Inverse of `tipForBlockPosition`. Given a tip and a snapshot, find
 * where the tip would land in the live distribution and which named
 * tier it falls in. Pure: no I/O, no oracle dependency, no wall-clock.
 *
 * Useful for "you priced at the Xth percentile" UI affordances and for
 * post-hoc "why is my tx slow" diagnostics.
 */

import { TierName, type GasOracleState, type TipSample } from './types.js'

export interface ClassifyTipResult {
  /**
   * Named tier the tip falls in. `null` when below `TierName.slow`'s
   * `maxPriorityFeePerGas` floor.
   */
  tier: TierName | null
  /**
   * `maxPriorityFeePerGas` floor of the next tier above `tier`. `null`
   * when `tier === TierName.instant` (already at top).
   */
  requiredForNextTier: bigint | null
  /**
   * Approximate percentile in the live distribution (block ring tips +
   * mempool samples), 0n..100n. `0n` = top of block (highest tip);
   * `100n` = bottom. `0n` when distribution empty.
   */
  percentile: bigint
  /** Approximate rank, 0n-indexed from top. `0n` when distribution empty. */
  rank: bigint
  /** Accumulated gas above this tip's position. `0n` when empty. */
  gasFromTop: bigint
}

const TIER_LADDER: readonly TierName[] = [
  TierName.slow,
  TierName.standard,
  TierName.fast,
  TierName.instant,
]

const tierForTip = (
  tiers: GasOracleState['tiers'],
  tipWei: bigint,
): TierName | null => {
  for (let i = TIER_LADDER.length - 1; i >= 0; i -= 1) {
    const tier = TIER_LADDER[i]
    if (tipWei >= tiers[tier].maxPriorityFeePerGas) return tier
  }
  return null
}

const requiredForNextTierAbove = (
  tiers: GasOracleState['tiers'],
  currentTier: TierName | null,
): bigint | null => {
  const currentIndex = currentTier ? TIER_LADDER.indexOf(currentTier) : -1
  const nextIndex = currentIndex + 1
  if (nextIndex >= TIER_LADDER.length) return null
  return tiers[TIER_LADDER[nextIndex]].maxPriorityFeePerGas
}

const collectDistribution = (snapshot: GasOracleState): TipSample[] => [
  ...snapshot.ring.flatMap((block) => block.tips),
  ...snapshot.mempoolSamples,
]

export const classifyTip = (
  snapshot: GasOracleState,
  tipWei: bigint,
): ClassifyTipResult => {
  const tier = tierForTip(snapshot.tiers, tipWei)
  const requiredForNextTier = requiredForNextTierAbove(snapshot.tiers, tier)

  const samples = collectDistribution(snapshot)
  if (samples.length === 0) {
    return { tier, requiredForNextTier, percentile: 0n, rank: 0n, gasFromTop: 0n }
  }

  // Sort by tip desc, equal-tip arm folded into descending side
  // (matches block-position.ts convention).
  const sorted = [...samples].sort((a, b) => (a.tip > b.tip ? -1 : 1))
  const firstWeakerIndexNum = sorted.findIndex((s) => s.tip <= tipWei)
  const samplesLen = BigInt(sorted.length)
  const rank: bigint = firstWeakerIndexNum === -1
    ? samplesLen
    : BigInt(firstWeakerIndexNum)

  // Round-half-away-from-zero percentile, all bigint:
  const percentile = samplesLen === 0n
    ? 0n
    : (rank * 100n + samplesLen / 2n) / samplesLen

  let gasFromTop = 0n
  for (let i = 0n; i < rank; i += 1n) gasFromTop += sorted[Number(i)].gas

  return { tier, requiredForNextTier, percentile, rank, gasFromTop }
}
```

- [ ] **Step 4: Run — should pass.**

```bash
yarn workspace @valve-tech/gas-oracle test -- classify-tip.test --run --reporter=verbose
```

Expected: PASS.

- [ ] **Step 5: Re-export from `index.ts`.**

```ts
// index.ts — append
export { classifyTip, type ClassifyTipResult } from './classify-tip.js'
```

- [ ] **Step 6: Verification gate.**

```bash
yarn workspace @valve-tech/gas-oracle typecheck && \
yarn workspace @valve-tech/gas-oracle test && \
yarn workspace @valve-tech/gas-oracle lint && \
yarn workspace @valve-tech/gas-oracle test:coverage
```

Expected: All green; coverage 100/100/100/100.

- [ ] **Step 7: Commit.**

```bash
git add -A packages/gas-oracle/src && \
git commit -m "$(cat <<'EOF'
feat(gas-oracle): classifyTip — inverse of tipForBlockPosition

Given a tip and a snapshot, classify it: which named tier it falls in
(or null if below slow), the floor of the next tier up (for upsell UI),
and its position in the live distribution (rank/percentile/gasFromTop
from snapshot.ring tips + snapshot.mempoolSamples combined).

Mirrors tipForBlockPosition's empty-input convention (0n/0n/0n) and its
sort-tip-desc + equal-tip-arm-into-descending convention. All math
bigint; loop counters bigint with Number(i) only at array-access
boundary.
EOF
)"
```

---

## Task 7: Inclusion labels (`inclusion-labels.ts`)

**Dependencies:** Task 1.

**Files:**
- Create: `packages/gas-oracle/src/inclusion-labels.ts`
- Create: `packages/gas-oracle/src/inclusion-labels.test.ts`
- Modify: `packages/gas-oracle/src/index.ts`

- [ ] **Step 1: Write failing test.**

Create `packages/gas-oracle/src/inclusion-labels.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { defaultInclusionLabels, inclusionLabel } from './inclusion-labels.js'
import { TierName } from './types.js'

describe('defaultInclusionLabels', () => {
  it('has an entry for every TierName', () => {
    const tiers = Object.values(TierName)
    for (const tier of tiers) {
      expect(defaultInclusionLabels[tier]).toBeTruthy()
      expect(typeof defaultInclusionLabels[tier]).toBe('string')
    }
  })

  it('has a label for each named tier', () => {
    expect(defaultInclusionLabels[TierName.slow]).toBe('Within a few blocks')
    expect(defaultInclusionLabels[TierName.standard]).toBe('Next block')
    expect(defaultInclusionLabels[TierName.fast]).toBe('Top of next block')
    expect(defaultInclusionLabels[TierName.instant]).toBe('Front of next block')
  })
})

describe('inclusionLabel', () => {
  it('returns the default for every tier when no overrides', () => {
    for (const tier of Object.values(TierName)) {
      expect(inclusionLabel(tier)).toBe(defaultInclusionLabels[tier])
    }
  })

  it('returns the override when present', () => {
    const overrides = { [TierName.standard]: 'Próximo bloque' }
    expect(inclusionLabel(TierName.standard, overrides)).toBe('Próximo bloque')
  })

  it('falls back to default for tiers not in overrides', () => {
    const overrides = { [TierName.standard]: 'Próximo bloque' }
    expect(inclusionLabel(TierName.slow, overrides)).toBe(defaultInclusionLabels[TierName.slow])
    expect(inclusionLabel(TierName.fast, overrides)).toBe(defaultInclusionLabels[TierName.fast])
  })

  it('spread pattern produces a complete replacement map', () => {
    const partial = { [TierName.slow]: 'Patience' }
    const full = { ...defaultInclusionLabels, ...partial }
    expect(full[TierName.slow]).toBe('Patience')
    expect(full[TierName.standard]).toBe(defaultInclusionLabels[TierName.standard])
  })
})
```

- [ ] **Step 2: Run — should fail.**

```bash
yarn workspace @valve-tech/gas-oracle test -- inclusion-labels.test --run --reporter=verbose
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement.**

Create `packages/gas-oracle/src/inclusion-labels.ts`:

```ts
/**
 * Default English UI copy mapping each tier to a user-facing inclusion
 * label, plus a small helper that resolves a tier with optional partial
 * overrides (locale or branded copy without forking the whole map).
 *
 * Conservative phrasing — labels describe relative position in the next
 * block, not hard guarantees. Real inclusion is probabilistic.
 */

import { TierName } from './types.js'

export const defaultInclusionLabels: Record<TierName, string> = {
  [TierName.slow]: 'Within a few blocks',
  [TierName.standard]: 'Next block',
  [TierName.fast]: 'Top of next block',
  [TierName.instant]: 'Front of next block',
}

/**
 * Resolve a tier to its inclusion label, falling back to
 * `defaultInclusionLabels` for any tier not present in `overrides`.
 *
 * Locale / branded-copy pattern (no fork required):
 *
 * ```ts
 * const es: Partial<Record<TierName, string>> = {
 *   [TierName.standard]: 'Próximo bloque',
 *   [TierName.fast]: 'Cabeza del próximo bloque',
 * }
 * inclusionLabel(TierName.standard, es) // 'Próximo bloque'
 * inclusionLabel(TierName.slow, es)     // falls back to default English
 * ```
 *
 * Consumers can also fully replace the map by spreading:
 * `const myLabels = { ...defaultInclusionLabels, ...partial }`.
 */
export const inclusionLabel = (
  tier: TierName,
  overrides?: Partial<Record<TierName, string>>,
): string => overrides?.[tier] ?? defaultInclusionLabels[tier]
```

- [ ] **Step 4: Run — should pass.**

```bash
yarn workspace @valve-tech/gas-oracle test -- inclusion-labels.test --run --reporter=verbose
```

Expected: PASS.

- [ ] **Step 5: Re-export from `index.ts`.**

```ts
// index.ts — append
export { defaultInclusionLabels, inclusionLabel } from './inclusion-labels.js'
```

- [ ] **Step 6: Verification gate.**

```bash
yarn workspace @valve-tech/gas-oracle typecheck && \
yarn workspace @valve-tech/gas-oracle test && \
yarn workspace @valve-tech/gas-oracle lint && \
yarn workspace @valve-tech/gas-oracle test:coverage
```

Expected: All green; coverage 100/100/100/100.

- [ ] **Step 7: Commit.**

```bash
git add -A packages/gas-oracle/src && \
git commit -m "$(cat <<'EOF'
feat(gas-oracle): inclusion labels with locale override

Default English UI copy for tier inclusion labels (Within a few blocks /
Next block / Top of next block / Front of next block) plus an
`inclusionLabel(tier, overrides?)` helper that lets consumers supply
partial per-tier overrides without forking the full map. Locale and
branded-copy use cases handled by passing a Partial<Record<TierName,
string>>; missing entries fall back to the default English copy.

No i18n machinery in the package — consumers manage their own
translation tables.
EOF
)"
```

---

## Task 8: Chain presets (`presets.ts`)

**Dependencies:** Tasks 1, 3.

**Files:**
- Create: `packages/gas-oracle/src/presets.ts`
- Create: `packages/gas-oracle/src/presets.test.ts`
- Modify: `packages/gas-oracle/src/index.ts`

- [ ] **Step 1: Write failing test.**

Create `packages/gas-oracle/src/presets.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { chainPresets, presetForChainId } from './presets.js'
import { PriorityModel } from './types.js'

describe('chainPresets', () => {
  it('has a pulsechain entry with chainId 369 and PriorityModel.flat', () => {
    expect(chainPresets.pulsechain).toBeDefined()
    expect(chainPresets.pulsechain.chainId).toBe(369)
    expect(chainPresets.pulsechain.priorityModel).toBe(PriorityModel.flat)
  })

  it('every entry carries a chainId', () => {
    for (const preset of Object.values(chainPresets)) {
      expect(typeof preset.chainId).toBe('number')
      expect(preset.chainId).toBeGreaterThan(0)
    }
  })
})

describe('presetForChainId', () => {
  it('returns the preset for a known chainId', () => {
    const preset = presetForChainId(369)
    expect(preset).toBe(chainPresets.pulsechain)
  })

  it('returns undefined for unknown chains', () => {
    expect(presetForChainId(1)).toBeUndefined()
    expect(presetForChainId(8453)).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run — should fail.**

```bash
yarn workspace @valve-tech/gas-oracle test -- presets.test --run --reporter=verbose
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement.**

Create `packages/gas-oracle/src/presets.ts`:

```ts
/**
 * Per-chain configuration presets for `createGasOracle`. Most chains
 * need NO entry — the package default (PriorityModel.eip1559, no
 * decay-cap override, default polling cadence) is correct. Add an entry
 * only after verifying the chain's actual validator behavior against
 * block-level data; the cost of being wrong is silent under-pricing
 * and stuck transactions.
 *
 * PulseChain (chain 369) is the canonical exception: extractive
 * validators ignore the EIP-2718 type byte and maximize fee/gas
 * regardless of tx envelope, so percentile math has to draw from the
 * full distribution (PriorityModel.flat).
 */

import type { CreateGasOracleOptions } from './oracle.js'
import { PriorityModel } from './types.js'

/**
 * Chain-specific configuration overrides. Includes the fields whose
 * correct value varies by chain — transport (`client`/`source`),
 * error handling (`onError`), and other non-chain-specific options
 * are NOT here (those are caller-supplied, never preset).
 */
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

/**
 * Look up a preset by chainId. Returns `undefined` when no preset is
 * registered — caller should treat that as "default behavior is correct"
 * and call `createGasOracle` without spreading any preset.
 */
export const presetForChainId = (
  chainId: number,
): ChainPreset | undefined =>
  Object.values(chainPresets).find((preset) => preset.chainId === chainId)
```

- [ ] **Step 4: Run — should pass.**

```bash
yarn workspace @valve-tech/gas-oracle test -- presets.test --run --reporter=verbose
```

Expected: PASS.

- [ ] **Step 5: Re-export from `index.ts`.**

```ts
// index.ts — append
export {
  chainPresets,
  presetForChainId,
  type ChainPreset,
} from './presets.js'
```

- [ ] **Step 6: Verification gate.**

```bash
yarn workspace @valve-tech/gas-oracle typecheck && \
yarn workspace @valve-tech/gas-oracle test && \
yarn workspace @valve-tech/gas-oracle lint && \
yarn workspace @valve-tech/gas-oracle test:coverage
```

Expected: All green; coverage 100/100/100/100.

- [ ] **Step 7: Commit.**

```bash
git add -A packages/gas-oracle/src && \
git commit -m "$(cat <<'EOF'
feat(gas-oracle): chainPresets entry-point with PulseChain exception

Per-chain configuration presets. ChainPreset shape uses Pick over
CreateGasOracleOptions to keep the preset surface in lockstep with the
chain-specific option fields (priorityModel, priorityFeeDecayCap,
pollIntervalMs). Each entry carries its own chainId so spreading at
the consumer site fills both the ID and the chain-specific overrides:
createGasOracle({ client, ...chainPresets.pulsechain }).

Pulsechain (chain 369) is the only entry today — extractive validators
ignore the EIP-2718 type byte, so PriorityModel.flat is required.
Future chains added only after validator-behavior verification; default
(eip1559) is correct for every chain we haven't proven otherwise.

presetForChainId(chainId) is the runtime lookup for callers with only
a numeric chain identifier.
EOF
)"
```

---

## Task 9: Docs and skills update

**Dependencies:** Tasks 1-8.

**Files:**
- Modify: `packages/gas-oracle/README.md`
- Modify: `packages/gas-oracle/skills/gas-oracle-integration/SKILL.md`
- Modify: `.claude/skills/contributing-to-evm-toolkit/SKILL.md`
- Modify: `packages/tx-tracker/skills/tx-tracker-integration/SKILL.md`

- [ ] **Step 1: Read current README to anchor the rewrite.**

```bash
cat packages/gas-oracle/README.md | head -120
```

Note the structure: feature blurb, install/import, quick example with `priorityModel: 'eip1559'`, "Choosing priorityModel" section.

- [ ] **Step 2: Update README — flip "Choosing priorityModel" framing.**

Find the section currently titled like "Choosing `priorityModel`" or referenced from line 76/98. Rewrite to:

```markdown
### Choosing `priorityModel`

The default is `PriorityModel.eip1559` and is correct for every chain whose validators honor the EIP-2718 type byte and the EIP-1559 fee-market shape. **You should only override this if you've verified your target chain's validators are extractive** — that is, they ignore the type byte and maximize fee per gas regardless of tx envelope.

The canonical example is **PulseChain (chain 369)**: extractive validators mean the percentile math has to draw from the full tx distribution (`PriorityModel.flat`) instead of filtering to type-2+ samples. Setting the wrong model here silently under-prices, and your tx stalls.

For chains we know about, the `chainPresets` entry-point handles this for you:

```ts
import { createGasOracle, chainPresets } from '@valve-tech/gas-oracle'

const oracle = createGasOracle({
  client,
  ...chainPresets.pulsechain,   // chainId: 369, priorityModel: PriorityModel.flat
})
```
```

- [ ] **Step 3: Update README — quick-example block.**

Find the example near line 39 with `priorityModel: 'eip1559'`. Update to use the const namespace and (optionally) drop the field if the example is on Mainnet:

```ts
import { createGasOracle, PriorityModel } from '@valve-tech/gas-oracle'

const oracle = createGasOracle({
  client,
  chainId: 1,
  // priorityModel defaults to PriorityModel.eip1559 — explicit only if you need to override
})
```

For PulseChain examples, set `PriorityModel.flat` explicitly or use the preset.

- [ ] **Step 4: Update README — add new sections for the helpers.**

Append (or insert in the appropriate section) walkthroughs for each new helper. Pattern:

```markdown
## Replacement workflow

When a tx gets stuck and you need to bump it past the EIP-1559 protocol replacement floor (and optionally past the live mempool distribution):

```ts
import {
  createGasOracle,
  recommendBumpTier,
  bumpForReplacement,
  BumpStrategy,
} from '@valve-tech/gas-oracle'

// 1. Pick a tier to bump to:
const tier = recommendBumpTier(
  state,
  { priorityTip: stuckTx.maxPriorityFeePerGas, identifier: { hash: stuckTx.hash } },
  { strategy: BumpStrategy.cheapestThatLands },
)

if (tier === null) {
  // Stuck tx is already paying above the top of the tier ladder, or
  // the snapshot has no tip data. Caller's call: hold, or push instant.
  return
}

// 2. Compute the gas object that satisfies both the protocol floor and the target tier:
const target = state.tiers[tier]
const gas = bumpForReplacement(
  { maxFeePerGas: stuckTx.maxFeePerGas, maxPriorityFeePerGas: stuckTx.maxPriorityFeePerGas },
  { maxFeePerGas: target.maxFeePerGas, maxPriorityFeePerGas: target.maxPriorityFeePerGas },
)

// 3. Send the replacement
walletClient.sendTransaction({ ...stuckTx, ...gas })
```

## Tip classification

Inverse of `tipForBlockPosition`: given a tip, find where it lands in the live distribution and which named tier it falls in.

```ts
import { classifyTip } from '@valve-tech/gas-oracle'

const result = classifyTip(state, myTip)
// result.tier            — TierName | null (null if below slow)
// result.requiredForNextTier — bigint floor of next tier above (null at instant)
// result.percentile      — bigint 0-100 (0 = top, 100 = bottom)
// result.rank            — bigint 0-indexed from top
// result.gasFromTop      — bigint accumulated gas above this tip
```

## UI labels

```ts
import { defaultInclusionLabels, inclusionLabel, TierName } from '@valve-tech/gas-oracle'

defaultInclusionLabels[TierName.standard]   // 'Next block'

// Locale / branded copy via partial overrides — no fork:
const es = { [TierName.standard]: 'Próximo bloque' }
inclusionLabel(TierName.standard, es)        // 'Próximo bloque'
inclusionLabel(TierName.slow, es)            // falls back to default English
```

## Chain presets

```ts
import { createGasOracle, chainPresets, presetForChainId } from '@valve-tech/gas-oracle'

// Static — direct preset access
createGasOracle({ client, ...chainPresets.pulsechain })

// Dynamic — runtime lookup by chainId
const preset = presetForChainId(chainId)
createGasOracle({ client, chainId, ...preset })
```

PulseChain (chain 369) is the only entry shipped today. Adding more requires verifying the chain's actual validator behavior against block-level data; the default (eip1559) is correct for every chain we haven't proven otherwise.
```

- [ ] **Step 5: Read current `gas-oracle-integration/SKILL.md`.**

```bash
cat packages/gas-oracle/skills/gas-oracle-integration/SKILL.md | head -80
```

Note the structure to know where to insert new sections.

- [ ] **Step 6: Update `gas-oracle-integration/SKILL.md`.**

Add new sections matching the README's coverage of the four new helper groups. The skill is structured as a how-to for end consumers; new sections should be at the same depth as existing how-to sections.

Default-flip note: add a heads-up near the top:

```markdown
> **v0.8.0 default change**: `priorityModel` now defaults to `PriorityModel.eip1559` (was `flat`). Examples that previously omitted the field silently get the new default. Set `PriorityModel.flat` explicitly for PulseChain (chain 369) — or use `...chainPresets.pulsechain`.
```

- [ ] **Step 7: Update `.claude/skills/contributing-to-evm-toolkit/SKILL.md`.**

```bash
cat .claude/skills/contributing-to-evm-toolkit/SKILL.md | head -100
```

Add two new sections (placement: after any "code style" or "conventions" section):

```markdown
## Project style — no magic strings

Every string-union type lands as a const-namespace pair: the value object (`as const`) and the derived type alias share the identifier. Call sites reference the const, never the bare literal.

```ts
export const PriorityModel = {
  flat: 'flat',
  eip1559: 'eip1559',
} as const
export type PriorityModel = (typeof PriorityModel)[keyof typeof PriorityModel]

// At call sites:
if (model === PriorityModel.flat) { ... }     // ✓
if (model === 'flat') { ... }                  // ✗ — magic string
```

Examples in the codebase: `PriorityModel`, `TierName`, `Trend`, `TxType` (gas-oracle), more emerging across other packages over time. When you add a new string-union type, this is the shape.

## Project style — bigint discipline

Numeric values that participate in math are `bigint`. Convert to `number` only at JS-platform-API boundaries:

- `arr[Number(i)]` for array indexing where `i: bigint`
- `setInterval(_, Number(ms))` for timers
- `BigInt(arr.length)` to lift array length into bigint math

```ts
// ✓ — math in bigint, conversion only at array access
const samplesLen = BigInt(sorted.length)
let gasFromTop = 0n
for (let i = 0n; i < rank; i += 1n) {
  gasFromTop += sorted[Number(i)].gas
}

// ✗ — number propagates through arithmetic
let gasFromTop = 0
for (let i = 0; i < rank; i += 1) {
  gasFromTop += Number(sorted[i].gas)
}
```

**Carve-out**: identifier-like fields that never participate in math stay `number`: `chainId`, EIP-2718 type bytes (`TxType` values, `RawTx.type`).
```

- [ ] **Step 8: Update `tx-tracker-integration/SKILL.md`.**

```bash
cat packages/tx-tracker/skills/tx-tracker-integration/SKILL.md | head -60
```

Add a cross-reference section near the end:

```markdown
## Speed-up workflow (cross-package)

For callers tracking a tx via `@valve-tech/tx-tracker` who want to bump it when it stalls or drops, pair with `@valve-tech/gas-oracle`'s `recommendBumpTier` + `bumpForReplacement` helpers:

```ts
import { recommendBumpTier, bumpForReplacement } from '@valve-tech/gas-oracle'

// tx-tracker tells you the tx is stuck:
tracker.on('stuck', (stuck) => {
  const tier = recommendBumpTier(
    gasOracleState,
    { priorityTip: stuck.maxPriorityFeePerGas, identifier: { hash: stuck.hash } },
  )
  if (tier === null) return  // Already paying above top tier — caller's call

  const target = gasOracleState.tiers[tier]
  const gas = bumpForReplacement(
    { maxFeePerGas: stuck.maxFeePerGas, maxPriorityFeePerGas: stuck.maxPriorityFeePerGas },
    { maxFeePerGas: target.maxFeePerGas, maxPriorityFeePerGas: target.maxPriorityFeePerGas },
  )
  walletClient.sendTransaction({ ...stuck, ...gas })
})
```

Outpace correction (passing `identifier`) reads `gasOracleState.mempoolSamples` to compute the tip needed to outpace the stuck tx in the live distribution, on top of the EIP-1559 +10% protocol floor.
```

- [ ] **Step 9: Verification gate (lint covers Markdown only via repo conventions; verify by build/test).**

```bash
yarn workspace @valve-tech/gas-oracle build 2>&1 | tail -20
```

Expected: build succeeds (sanity check that nothing broke).

- [ ] **Step 10: Commit.**

```bash
git add -A packages/gas-oracle/README.md \
        packages/gas-oracle/skills/gas-oracle-integration/SKILL.md \
        .claude/skills/contributing-to-evm-toolkit/SKILL.md \
        packages/tx-tracker/skills/tx-tracker-integration/SKILL.md && \
git commit -m "$(cat <<'EOF'
docs(gas-oracle): README + skills updates for new defaults, helpers, presets

- README: flip Choosing priorityModel framing (default is eip1559;
  override only for extractive chains). New sections for replacement
  workflow, tip classification, UI labels, chain presets. Existing
  examples migrated to const-namespace references.
- gas-oracle-integration skill: same coverage as README for end-user
  consumers; default-flip heads-up at the top.
- contributing-to-evm-toolkit skill: project-wide style sections for
  no-magic-strings (const namespace pattern) and bigint discipline
  (with the identifier-like carve-out).
- tx-tracker-integration skill: cross-reference to the gas-oracle
  speed-up workflow with the typical recommendBumpTier +
  bumpForReplacement caller pattern.
EOF
)"
```

---

## Task 10: Release narrative — CHANGELOG widening + memory hygiene

**Dependencies:** Tasks 1-9.

**Files:**
- Modify: `packages/gas-oracle/CHANGELOG.md`
- Modify: `CHANGELOG.md` (root)
- Update memory files (post-implementation hygiene; not in repo, lives in `~/.claude/projects/...`)

- [ ] **Step 1: Read current CHANGELOG entries to anchor format.**

```bash
head -40 packages/gas-oracle/CHANGELOG.md
echo "---"
head -40 CHANGELOG.md
```

- [ ] **Step 2: Update `packages/gas-oracle/CHANGELOG.md` v0.8.0 entry.**

Locate the v0.8.0 section. The current entry covers tx-tracker completion + WS-push (since it's a monorepo CHANGELOG entry, gas-oracle's package CHANGELOG might or might not have it — check). Widen to include gas-oracle additions:

```markdown
## 0.8.0

### Added

- **Replacement helpers** (`replacement.ts`): `minimumReplacementFee(current, txType)`, `bumpForReplacement(currentGas, targetGas)`, `recommendBumpTier(snapshot, stuckTx, options?)` with three named strategies (`BumpStrategy.cheapestThatLands` / `oneStepFasterThanRecommended` / `instant`). Outpace correction via optional `stuckTx.identifier` reads `snapshot.mempoolSamples` to find the tip needed to outpace the stuck tx in the live distribution, on top of the EIP-1559 +10% protocol floor (verified against geth/reth/PulseChain go-pulse sources).
- **`classifyTip(snapshot, tipWei)`** (`classify-tip.ts`): inverse of `tipForBlockPosition`. Returns `{ tier, requiredForNextTier, percentile, rank, gasFromTop }`.
- **Inclusion labels** (`inclusion-labels.ts`): `defaultInclusionLabels` (Record<TierName, string>) and `inclusionLabel(tier, overrides?)` for locale/branded copy without forking.
- **Chain presets** (`presets.ts`): `chainPresets.pulsechain` (chainId: 369, priorityModel: PriorityModel.flat) plus `presetForChainId(chainId)` runtime lookup.
- **Const-namespace exports**: `PriorityModel`, `TierName`, `Trend`, `TxType` are now exported as both values (const namespaces) and types. Use `PriorityModel.flat` instead of `'flat'` etc.
- **`mempoolSamples: TipSample[]`** on `GasOracleState`. Producer-local — wire publishers should strip before serializing (same convention as `ring`).

### Changed

- **`priorityModel` default flips from `'flat'` to `PriorityModel.eip1559`**. Most chains honor the EIP-2718 type byte and the EIP-1559 fee-market; the default is now correct for the majority case. PulseChain (chain 369) becomes the explicit exception — set `priorityModel: PriorityModel.flat` (or use `...chainPresets.pulsechain`).
- **BigInt migration of public numeric fields**: `MempoolStats.pendingCount`, `MempoolStats.queuedCount`, `BlockPositionQuery.rank`, `BlockPositionQuery.percentile`, `BlockPositionResult.rank`, `CreateGasOracleOptions.pollIntervalMs` are now `bigint`. Identifier-like fields (`chainId`, EIP-2718 type bytes) stay `number`.

### Migration notes

- Examples that previously omitted `priorityModel` silently get `PriorityModel.eip1559` after upgrade. Verify against your target chain.
- `Math` operations on the migrated bigint fields need `n` literals (`0n`, `1n`, etc.) and integer-floor division semantics.
- `pollIntervalMs: 5000` becomes `pollIntervalMs: 5000n`.
```

- [ ] **Step 3: Update root `CHANGELOG.md` v0.8.0 entry.**

Mirror the gas-oracle additions into the root CHANGELOG under the v0.8.0 section, in the same format used for tx-tracker / WS-push entries.

- [ ] **Step 4: Verify the docs build.**

```bash
yarn workspace @valve-tech/gas-oracle build && \
yarn workspace @valve-tech/gas-oracle typecheck && \
yarn workspace @valve-tech/gas-oracle test && \
yarn workspace @valve-tech/gas-oracle lint
```

Expected: all green.

- [ ] **Step 5: Update memory files (post-implementation hygiene).**

These live outside the repo at `~/.claude/projects/-Users-michaelmclaughlin-Documents-3commascapital-gitlab-pulsechainorg-pulsechain-gas-oracle/memory/`:

- `pulsechain-gas-pricing-footgun.md` — append: "**Resolution (v0.8.0)**: shipped `chainPresets.pulsechain` with the verified config (`PriorityModel.flat`). Use `createGasOracle({ client, ...chainPresets.pulsechain })`."
- `upstream-candidates.md` — under the `@valve-tech/gas-oracle` (extend in place) section, mark items 1-5 (`recommendBumpTier`, `bumpForReplacement`, `classifyTip`, `defaultInclusionLabels`, `inclusionLabel`) as "✅ shipped in v0.8.0."
- `architecture-primitive-layer.md` — append a note: "v0.8.0 adds `mempoolSamples: TipSample[]` to `GasOracleState`. Still pure-functions-over-snapshots in spirit; the sample list is producer-local and strippable for wire serialization (same convention as `ring`)."

These edits are file-system writes outside the git repo, no commit involved.

- [ ] **Step 6: Commit (CHANGELOG only — memory edits are not in git).**

```bash
git add packages/gas-oracle/CHANGELOG.md CHANGELOG.md && \
git commit -m "$(cat <<'EOF'
chore(release): widen v0.8.0 changelog to include gas-oracle additions

Capture the gas-oracle upstream helpers, const-namespace exports,
bigint migration, default flip, and chain-presets entry-point in the
v0.8.0 changelog. The original release-prep commit (eec81ce) covered
tx-tracker completion + WS-push only; this widens the narrative to the
final v0.8.0 scope.

No code change. The existing release-prep commit stays in history; this
is a follow-up changelog correction, not a history rewrite.
EOF
)"
```

- [ ] **Step 7: Final verification.**

```bash
yarn workspace @valve-tech/gas-oracle typecheck && \
yarn workspace @valve-tech/gas-oracle test && \
yarn workspace @valve-tech/gas-oracle lint && \
yarn workspace @valve-tech/gas-oracle test:coverage && \
git log --oneline b3caa04..HEAD
```

Expected: all green; ten commits between the spec commit (`b3caa04`) and HEAD, matching Tasks 1-10.

---

## Self-review checklist

After completing all tasks, verify against the spec:

- [ ] All five new helpers present (`recommendBumpTier`, `bumpForReplacement`, `classifyTip`, `defaultInclusionLabels`/`inclusionLabel`, `chainPresets`/`presetForChainId`)
- [ ] All four const namespaces exported as values (`PriorityModel`, `TierName`, `Trend`, `TxType`)
- [ ] Default `priorityModel` is `PriorityModel.eip1559`
- [ ] `GasOracleState.mempoolSamples` field exists and is populated by the poll cycle
- [ ] All public numeric fields per Section 1B table are `bigint`
- [ ] `minimumReplacementFee` table-driven tests cover small-value edge cases (0, 1, 9, 10, 80, 83, 100)
- [ ] `recommendBumpTier` tests cover each of the three strategies, the null-return cases, and outpace correction with/without identifier
- [ ] `classifyTip` tests cover empty distribution, samples-present, mempool+ring combination
- [ ] Coverage is 100/100/100/100 for the package
- [ ] README "Choosing priorityModel" reframed; new helper sections present
- [ ] Three skill files updated; the contributing-to-evm-toolkit skill carries the project-wide style rules
- [ ] CHANGELOG (package + root) widened with the v0.8.0 additions

If any item is missing, identify which task should have produced it and add a follow-up commit before declaring the plan complete.
