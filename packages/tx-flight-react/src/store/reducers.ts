/**
 * @fileoverview Pure reducers for the tx-flight store.
 *
 * Side effects (start watcher, save storage, call unsub) belong in the
 * Provider. Reducers fold state changes only. The Provider invokes
 * reducers with `now` parameters so timestamping is testable.
 */

import type { TrackedTx, TrackedTxStatus } from '@valve-tech/wallet-adapter'

import type { InternalState } from '../types.js'

const TERMINAL_STATUSES: ReadonlySet<TrackedTxStatus> = new Set<TrackedTxStatus>([
  'confirmed',
  'failed',
  'dropped',
  'replaced',
])

const isTerminal = (tx: TrackedTx): boolean => TERMINAL_STATUSES.has(tx.status)

/**
 * The "when did this tx settle / start" timestamp used for both
 * eviction passes. For terminals: `confirmedAt` if set (the Provider
 * stamps it on status flip via `updateReducer`), else `submittedAt`
 * as a conservative fallback for terminals that were added directly
 * (e.g., via `addManual`). For non-terminals: `submittedAt`.
 */
const settledOrSubmittedAt = (tx: TrackedTx): number =>
  isTerminal(tx) ? (tx.confirmedAt ?? tx.submittedAt) : tx.submittedAt

/**
 * Insert (or overwrite) a TrackedTx and an optional watcher unsub.
 *
 * When overwriting a tx that previously had a watcher, the caller MUST
 * call the previous watcher's unsub BEFORE invoking this reducer —
 * reducers are pure and don't perform side effects. The Provider owns
 * watcher lifecycle.
 */
export const addReducer = (
  state: InternalState,
  tx: TrackedTx,
  watcher: (() => void) | null,
): InternalState => {
  const txs = new Map(state.txs)
  txs.set(tx.id, tx)
  const watchers = new Map(state.watchers)
  if (watcher) {
    watchers.set(tx.id, watcher)
  } else {
    watchers.delete(tx.id)
  }
  return { txs, watchers }
}

/**
 * Patch an existing tx's fields. No-op (returns the same state
 * reference) on a missing id.
 *
 * If the patch flips status to a terminal value and `confirmedAt` is
 * not yet set, stamps `confirmedAt` to `now`. This gives `evictReducer`
 * a uniform "settled at" timestamp regardless of which terminal status
 * the tx ended in.
 */
export const updateReducer = (
  state: InternalState,
  txId: string,
  patch: Partial<TrackedTx>,
  now: number,
): InternalState => {
  const existing = state.txs.get(txId)
  if (!existing) return state
  const next: TrackedTx = { ...existing, ...patch }
  if (isTerminal(next) && next.confirmedAt === undefined) {
    next.confirmedAt = now
  }
  const txs = new Map(state.txs)
  txs.set(txId, next)
  return { txs, watchers: state.watchers }
}

/**
 * Drop a tx and its watcher map entry. The Provider is responsible for
 * calling the watcher's unsub BEFORE this reducer runs.
 *
 * No-op (returns the same state reference) on a missing id.
 */
export const removeReducer = (
  state: InternalState,
  txId: string,
): InternalState => {
  if (!state.txs.has(txId) && !state.watchers.has(txId)) return state
  const txs = new Map(state.txs)
  txs.delete(txId)
  const watchers = new Map(state.watchers)
  watchers.delete(txId)
  return { txs, watchers }
}

/**
 * Two-pass eviction. Returns the same state reference when nothing
 * changed.
 *
 * Pass 1: drop terminal entries older than `terminalRetentionMs` —
 *   `now - (confirmedAt ?? submittedAt) > terminalRetentionMs`.
 * Pass 2: if the surviving set is still larger than `maxItems`, drop
 *   in priority order: terminals first (oldest first by their settled
 *   timestamp), then non-terminals (oldest first by submittedAt).
 *   Non-terminals are preserved over terminals at the same age — an
 *   active in-flight tx is more valuable than a settled one.
 */
export const evictReducer = (
  state: InternalState,
  opts: { maxItems: number; terminalRetentionMs: number; now: number },
): InternalState => {
  const { maxItems, terminalRetentionMs, now } = opts

  // Pass 1: collect terminals past their retention window.
  const expired = new Set<string>()
  for (const [id, tx] of state.txs) {
    if (!isTerminal(tx)) continue
    if (now - settledOrSubmittedAt(tx) > terminalRetentionMs) expired.add(id)
  }

  // Pass 2: if still over cap, sort survivors by (terminal-first,
  // then oldest-first) and slice off the head until under cap.
  const survivorsAfterPass1 = state.txs.size - expired.size
  let extraEvictions: string[] = []
  if (survivorsAfterPass1 > maxItems) {
    const survivors: TrackedTx[] = []
    for (const [id, tx] of state.txs) {
      if (!expired.has(id)) survivors.push(tx)
    }
    survivors.sort((a, b) => {
      const aT = isTerminal(a) ? 0 : 1
      const bT = isTerminal(b) ? 0 : 1
      if (aT !== bT) return aT - bT
      return settledOrSubmittedAt(a) - settledOrSubmittedAt(b)
    })
    const evictCount = survivorsAfterPass1 - maxItems
    extraEvictions = survivors.slice(0, evictCount).map((t) => t.id)
  }

  if (expired.size === 0 && extraEvictions.length === 0) return state

  const txs = new Map(state.txs)
  const watchers = new Map(state.watchers)
  for (const id of expired) {
    txs.delete(id)
    watchers.delete(id)
  }
  for (const id of extraEvictions) {
    txs.delete(id)
    watchers.delete(id)
  }
  return { txs, watchers }
}
