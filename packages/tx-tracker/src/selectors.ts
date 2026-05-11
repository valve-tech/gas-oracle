/**
 * Bulk-subscription matchers — pure functions over `RawTx`.
 *
 * Per `docs/tx-tracker-spec.md` §11. Indexers want "all txs from
 * these senders" or "all txs touching this contract"; the tracker
 * supports `from` / `to` / `predicate` selectors. The matchers
 * themselves are pure (no I/O, no cached state) — `tracker.ts`
 * iterates the source's mempool snapshots and the canonical block's
 * `transactions` array per tick and asks each registered selector
 * whether each tx matches.
 *
 * `from` and `to` selectors normalize addresses to lowercase ASCII
 * before comparison because upstream RPCs are inconsistent about
 * checksum vs lowercase. Mempool snapshots are already lowercased
 * by `chain-source`'s `normalizeMempool`, but the same matcher is
 * called against block-tx records (where the upstream may emit
 * checksum form), so the selector normalizes its own
 * pre-stored target once and compares lowercase-vs-lowercase.
 *
 * Predicate selectors are caller-defined. The tracker calls them
 * O(N) per tick per matched-tx; spec §11.3 documents that slow
 * predicates degrade the tick.
 */

import type { RawTx } from '@valve-tech/chain-source'

import type { Address, Hash } from './events.js'
import type { BulkSelector } from './store.js'

/**
 * One match the bulk subscription is about to emit. The tracker
 * builds the surrounding `TxMatchEvent` envelope (`source`,
 * `at`, etc.) before pushing to the consumer; this shape is just
 * the matcher's payload.
 */
export interface BulkMatchPayload {
  hash: Hash
  matchedBy: 'from' | 'to' | 'predicate'
  selector: BulkSelector
  tx: RawTx
}

/**
 * One compiled selector — `selector` is the original consumer-facing
 * shape, `match` is the cached pure function the tracker calls per
 * tx. The tracker compiles each registered selector once at
 * registration time so the per-tick fanout pays only the function
 * call, not a dispatch on `selector.kind`.
 */
export interface CompiledSelector {
  selector: BulkSelector
  match: (tx: RawTx) => boolean
}

/**
 * Compile a `BulkSelector` into its pure matcher. `from` / `to`
 * cache the lowercased address once; `predicate` returns the
 * caller's function as-is.
 *
 * Throws on a malformed selector (`from` / `to` without an address,
 * `predicate` without a function) — caught at registration time
 * rather than at the per-tick callsite, where the failure mode would
 * be silent zero matches.
 */
export const compileSelector = (selector: BulkSelector): CompiledSelector => {
  switch (selector.kind) {
    case 'from': {
      if (!selector.address) {
        throw new Error('compileSelector: "from" selector requires an address')
      }
      const target = selector.address.toLowerCase()
      return {
        selector,
        match: (tx) => (tx.from ? tx.from.toLowerCase() === target : false),
      }
    }
    case 'to': {
      if (!selector.address) {
        throw new Error('compileSelector: "to" selector requires an address')
      }
      const target = selector.address.toLowerCase()
      return {
        selector,
        match: (tx) =>
          // RawTx in chain-source's wire shape doesn't carry `to`
          // explicitly (it's loose for portability across
          // mempool/block payloads); the matcher reads the field
          // off the structurally-typed object so block-side txs
          // (which DO carry `to`) match correctly. Mempool snapshots
          // also carry `to`; both are read off the same field name
          // upstream clients use.
          extractTo(tx) ? extractTo(tx)?.toLowerCase() === target : false,
      }
    }
    case 'predicate': {
      if (typeof selector.match !== 'function') {
        throw new Error(
          'compileSelector: "predicate" selector requires a match function',
        )
      }
      const fn = selector.match
      return { selector, match: (tx) => fn(tx) }
    }
  }
}

/**
 * Read `tx.to` off a RawTx without losing type-safety. The
 * `chain-source` `RawTx` is intentionally loose (no `to` field) —
 * mempool / block payloads carry `to` even though it's not in the
 * narrow type, and `to`-selectors must compare against it. Safe
 * cast through `Record<string, unknown>` keeps lint clean and
 * avoids `any`.
 */
const extractTo = (tx: RawTx): Address | undefined => {
  const value = (tx as Record<string, unknown>).to
  return typeof value === 'string' ? value : undefined
}

/**
 * Iterate `txs` against every compiled selector and yield one
 * `BulkMatchPayload` per (tx, selector) match. Used by the tracker's
 * per-tick fan-out over both `block.transactions` (after a new tip
 * lands) and the source's mempool snapshot deltas.
 *
 * The tracker, not this helper, decides whether to auto-track each
 * matched hash — `BulkTrackOptions.autoTrackMatched` (default true)
 * lives in `tracker.ts`.
 */
export const matchAll = (
  txs: ReadonlyArray<RawTx>,
  compiled: ReadonlyArray<CompiledSelector>,
): BulkMatchPayload[] => {
  const matches: BulkMatchPayload[] = []
  for (const tx of txs) {
    if (!tx.hash) continue // can't bulk-track an unhashed tx
    for (const cs of compiled) {
      if (!cs.match(tx)) continue
      matches.push({
        hash: tx.hash,
        matchedBy: cs.selector.kind,
        selector: cs.selector,
        tx,
      })
    }
  }
  return matches
}

/**
 * Default per-tracker bulk-subscription cap (§11.3). Higher fan-out
 * is technically allowed but indicates the consumer should be
 * running an indexer-shaped store rather than the in-memory default.
 */
export const defaultMaxBulkSubscriptions = 16

/**
 * Reverse-lookup: find the bulk subscription whose compiled selector
 * is the same reference as `selector`. Returns `null` on miss.
 *
 * Pure / data-flow only — exported here so the tracker's
 * runBulkOn{Block,Mempool} paths can resolve match→bulk without
 * exposing the bulk registry, and so the defensive null-on-miss
 * branch is unit-testable (audit #7 hardening). The current public
 * API can't reach a miss in fanout (matchSubs has no sync subscribers,
 * so a sub can't be deleted between the `compiled` snapshot and the
 * lookup), but future internal changes that add synchronous matchSubs
 * subscribers, or any other path that mutates the registry mid-fanout,
 * would otherwise crash the entire emit loop.
 */
export const findBulkSubBySelector = <T extends { compiled: CompiledSelector }>(
  bulkSubs: ReadonlyMap<string, T>,
  selector: BulkSelector,
): T | null => {
  for (const sub of bulkSubs.values()) {
    if (sub.compiled.selector === selector) return sub
  }
  return null
}
