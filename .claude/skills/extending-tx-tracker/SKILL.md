---
name: extending-tx-tracker
description: Project-local contributor guide for @valve-tech/tx-tracker — state-machine layout, the every-event-must-carry-source invariant, the reorg-events-never-from-receipt-poll rule, the predicate-selectors-non-durable carve-out, and the per-record-decisions-live-in-pure-functions pattern. Triggered when modifying any file under packages/tx-tracker/src/.
---

# Extending `@valve-tech/tx-tracker`

When modifying any file in `packages/tx-tracker/src/`, follow these
load-bearing rules. They prevent silent contract drift on the
event taxonomy and the per-method capability disclosure.

## State-machine layout

```
events.ts              — TxEvent discriminated union + pure builders
store.ts               — TxTrackerStore interface + createInMemoryStore
reorg.ts               — pure reorg detector (BlockSample ring, detectDivergences)
selectors.ts           — bulk-subscription matchers
observations.ts        — per-record decision functions (pure)
tracker.ts             — orchestrator: source.subscribeBlocks/Mempool wiring,
                         mutable per-record state, emit fan-out
group.ts               — cross-tx synthesis layer (since v0.8.0)
group-events.ts        — TxGroupEvent shapes + builders (since v0.8.0)
watch-transaction.ts   — top-level convenience export (since v0.8.0)
wait-for-transaction.ts — promise-based convenience wrapper (since v0.8.0)
wait-for-pending.ts    — waits for mempool visibility before block-watch (since v0.8.0)
replace-transaction.ts — write-side helper: speed-bump / cancellation (since v0.8.0)
```

### Layer responsibilities at a glance

| Layer | Files | Owns | Does NOT own |
|-------|-------|------|--------------|
| Pure math | `events.ts`, `reorg.ts`, `observations.ts` | decision logic, event shapes | I/O, subscriptions, state |
| Store contract | `store.ts` | persistence interface + in-memory default | transport, emission |
| Subscription surface | `selectors.ts` | predicate + hash-set matching | state mutation |
| Orchestrator | `tracker.ts` | wiring + state mutation + fan-out | decision branches |
| Synthesis | `group.ts`, `group-events.ts` | cross-tx correlation | per-tx state |
| Convenience exports | `watch-transaction.ts`, `wait-for-transaction.ts`, `wait-for-pending.ts`, `replace-transaction.ts` | ergonomic top-level API | orchestration internals |

The rule: pure functions at the bottom, stateful wiring at the top. Cross-file
direction is always downward — `tracker.ts` imports from `observations.ts`, never
the reverse.

## Invariants — never break these

### 1. Every emitted event must carry `source`

Per `tx-tracker-spec.md` §2.2 — no silent downgrade. The `source`
discriminator is part of the event envelope (`Envelope` in `events.ts`)
and every builder in `events.ts` carries it forward unchanged. If you
add a new event variant, its builder MUST take a full `Envelope` input
including `source`.

Concretely: `Envelope` is `{ hash: Hex; source: TxSource }` where
`TxSource = 'subscription' | 'block-poll' | 'mempool-snapshot' | 'receipt-poll'`.
Builder functions take an `Envelope` as their first argument and spread it into the
returned event — do not peel off `source` and reconstruct without it.

### 2. `vanished-from-block` events must NOT have `source: 'receipt-poll'`

Per `tx-tracker-spec.md` §12.3. Most providers cheerfully return a
receipt for a tx in a no-longer-canonical block, so the receipt-poll
path cannot detect a reorg authoritatively. `buildVanishedFromBlock`
in `events.ts` enforces this with a runtime throw — never relax that
guard.

The throw is intentional and is covered by a dedicated test in
`events.test.ts`. If you see a `/* c8 ignore */` on a catch around
that throw, do not remove it without also deleting the guard itself.

### 3. Predicate bulk subscriptions are non-durable

Per `tx-tracker-spec.md` §13.2. A serialized closure isn't a thing,
so predicate selectors can't survive a process restart. The store
interface skips them. If a caller passes `durable: true` with
`kind: 'predicate'`, surface a warning via `onError` and treat as
non-durable. Do not silently honor the flag.

Detection point: the subscription-router in `tracker.ts` checks
`sub.selector.kind === 'predicate' && sub.durable === true`
and calls `onError` before continuing with ephemeral handling.

### 4. Per-record decisions live in pure functions

`observations.ts` holds `decideBlockObservation` / `decideMempoolObservation`
— pure inputs → pure outputs (status patches + events). `tracker.ts`
orchestrates: subscribes to the source, calls the pure functions, and
applies returned patches. **Do not put state-machine branches in
`tracker.ts`.** This split is what makes 100% branch coverage tractable
— literal-input fixture tests in `observations.test.ts` cover every
arm without spinning up a stub source.

If you find yourself needing to add a `if (...)` arm inside an `onBlock`
or `onMempool` callback in `tracker.ts`, ask: should this go in
`observations.ts` instead? The answer is almost always yes.

### 5. tx-tracker MUST NOT import from `@valve-tech/gas-oracle`

Sibling packages, kept independent. The bump-rule helper ships in
gas-oracle separately; tx-tracker helpers that need gas values accept
them from the caller. Verify after any new import:

```bash
grep -rn "@valve-tech/gas-oracle" packages/tx-tracker/src/ || echo "OK: no gas-oracle imports"
```

If you need gas-oracle math (e.g., bump rule) inside a tx-tracker
helper, change the API to accept the result from the caller instead.
`replaceTransaction` in `replace-transaction.ts` is the canonical
example — `newGas` is a caller-provided parameter, not computed
internally.

## Coverage gate

Before opening a PR or cutting a release, all four metrics must be
100% per package:

```bash
yarn workspace @valve-tech/tx-tracker test --coverage --run
```

Lines / branches / functions / statements all 100%. If the table
omits a file, that file is at 100% and got filtered by Vitest's
text reporter — confirm via the JSON reporter (`--coverage.reporter=json`).

`/* c8 ignore */` annotations exist for genuinely unreachable
defensive guards, each carrying an in-line comment explaining why.
Never drop one without first deleting the dead code itself.

## When you add a new event kind

1. Add the interface to `events.ts` (`TxEventXyz extends Envelope`).
2. Add it to the `TxEvent` union.
3. Write the builder (`buildXyz`) — same envelope pattern as existing
   builders: accept `Envelope` + event-specific fields, return a
   spread that includes `kind` and all fields.
4. Add the appropriate decision arm in `observations.ts` if it's a
   per-record observation; or in the relevant orchestrator path in
   `tracker.ts` (e.g. `handleReorgs` for reorg-derived events).
5. Test the builder pure (`events.test.ts`), the decision arm
   (`observations.test.ts`), and the integration (`tracker.test.ts`).
6. Update the consumer skill at
   `packages/tx-tracker/skills/tx-tracker-integration/SKILL.md` if
   the new kind is consumer-facing.

## When you add a new group event kind (v0.8.0+)

`group-events.ts` follows the same builder pattern as `events.ts` but
shapes are in `TxGroupEvent`. The orchestrator lives in `group.ts`
(`createTxGroup`), not in `tracker.ts`.

1. Add the interface to `group-events.ts` (`TxGroupEventXyz extends GroupEnvelope`).
2. Add it to the `TxGroupEvent` union.
3. Write `buildGroupXyz` — same pattern.
4. Add the synthesis arm in `group.ts`.
5. Test in `group-events.test.ts` (pure builder) and `group.test.ts`
   (integration matrix: all-confirm, partial-fail, all-fail).

## Adding a new top-level convenience export (v0.8.0+)

Top-level helpers (`watch-transaction.ts`, `wait-for-transaction.ts`,
`wait-for-pending.ts`, `replace-transaction.ts`) are thin wrappers —
they may not add new state-machine logic. They must:

- Accept a `PublicClient` (or `WalletClient` for write-side) + a
  `ChainSource` or tracker instance; never spin up their own poll loop.
- Re-use the existing tracker subscription surface; do not bypass
  `tracker.subscribe`.
- Be stateless with respect to the tracker internals — no direct
  mutation of the per-record store.
- Be exported from `src/index.ts`.
- Have their own `*.test.ts` covering `onMined`, `onDropped`, and
  the unsubscribe path.

## Pre-PR checks specific to tx-tracker

Run from the workspace root:

```bash
yarn typecheck
yarn lint
yarn workspace @valve-tech/tx-tracker test --coverage --run
yarn build
```

And confirm the sibling-isolation invariant:

```bash
grep -rn "@valve-tech/gas-oracle" packages/tx-tracker/src/ || echo "OK: no gas-oracle imports"
```

All must pass before opening a PR or tagging a release.
