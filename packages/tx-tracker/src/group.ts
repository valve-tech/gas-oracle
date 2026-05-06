/**
 * `createTxGroup` — synthesis layer on top of per-hash tracker
 * subscriptions. Spec §18.1, v0.8.0 design F3.
 *
 * Listens to each member hash via the tracker's existing subscribe API,
 * tracks confirmed/failed counters, and emits group-progress /
 * group-complete / group-failed once per terminal transition. Member
 * unsubscribes are torn down on stop().
 *
 * Replacement does NOT auto-promote — if a member is replaced via
 * same-nonce bump, the group emits group-failed with reason
 * 'replaced'. The consumer constructs a new group with the new hash
 * if they want the replacement to count.
 *
 * Edge case: an empty hashes array immediately emits group-complete
 * with total=0 (vacuously all confirmed) and marks the group terminal.
 * This is a safe, predictable default and matches the mathematical
 * sense of "all zero members confirmed."
 */

import { Subscriptions } from '@valve-tech/chain-source'

import type { Hash, TxEvent, TxStatus } from './events.js'
import {
  buildGroupComplete,
  buildGroupFailed,
  buildGroupProgress,
  buildGroupStopped,
  type TxGroupEvent,
} from './group-events.js'
import type {
  GroupOptions,
  TrackOptions,
  TxGroupSubscription,
  TxTracker,
} from './tracker.js'

/**
 * Construct a group subscription that synthesises per-member `TxEvent`
 * streams into group-level events.
 *
 * @param tracker - The tracker instance to call `subscribe` on.
 * @param hashes  - Member transaction hashes. Order is not significant.
 * @param options - Optional group-level and member-level overrides.
 */
export const createTxGroup = (
  tracker: TxTracker,
  hashes: Hash[],
  options: GroupOptions = {},
): TxGroupSubscription => {
  const groupId =
    options.groupId ??
    `grp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const memberOptions: TrackOptions = options.memberOptions ?? {}
  const subs = new Subscriptions<TxGroupEvent>()
  const total = hashes.length
  const confirmedSet = new Set<Hash>()
  let terminal = false
  const memberUnsubs: (() => void)[] = []

  const emit = (event: TxGroupEvent): void => subs.emit(event)

  // Empty group — vacuously all confirmed. Emit complete immediately
  // (synchronously; no member subscriptions to set up).
  if (total === 0) {
    terminal = true
    const zeroAt = { blockNumber: 0n, timestamp: 0n }
    emit(buildGroupComplete({ groupId, at: zeroAt, total: 0 }))
  }

  const handleMemberEvent = (memberHash: Hash, event: TxEvent): void => {
    if (terminal) return
    const at = event.at

    if (event.kind === 'seen-in-block' && event.confirmations >= 1) {
      // Idempotency guard: same hash can emit multiple seen-in-block
      // events (confirmations 1, 2, 3 …) — only count it once.
      if (confirmedSet.has(memberHash)) return
      confirmedSet.add(memberHash)
      if (confirmedSet.size < total) {
        emit(
          buildGroupProgress({
            groupId,
            at,
            confirmed: confirmedSet.size,
            total,
            lastHash: memberHash,
          }),
        )
      } else {
        terminal = true
        emit(buildGroupComplete({ groupId, at, total }))
      }
      return
    }

    if (event.kind === 'unseen-for-N-blocks') {
      terminal = true
      emit(
        buildGroupFailed({
          groupId,
          at,
          failedHash: memberHash,
          reason: 'dropped',
        }),
      )
      return
    }

    if (event.kind === 'replaced-by') {
      terminal = true
      emit(
        buildGroupFailed({
          groupId,
          at,
          failedHash: memberHash,
          reason: 'replaced',
        }),
      )
      return
    }
  }

  for (const hash of hashes) {
    const unsub = tracker.subscribe(
      hash,
      (event) => handleMemberEvent(hash, event),
      { ...memberOptions, emitInitial: false },
    )
    memberUnsubs.push(unsub)
  }

  let stopped = false

  const stop = (): void => {
    if (stopped) return
    stopped = true
    for (const unsub of memberUnsubs) {
      try {
        unsub()
      } catch {
        // Swallow per-sub teardown errors — we always emit group-stopped.
      }
    }
    emit(buildGroupStopped({ groupId, at: { blockNumber: 0n, timestamp: 0n } }))
  }

  const snapshot = (): Record<Hash, TxStatus | null> => {
    const out: Record<Hash, TxStatus | null> = {}
    for (const hash of hashes) out[hash] = tracker.getTxStatus(hash)
    return out
  }

  /**
   * Async-iterable surface over the group event stream. Resolves each
   * `next()` call with the next queued event, or parks the caller in a
   * waiter array until one arrives. Terminal events (group-complete /
   * group-failed / group-stopped) flip `done` so subsequent `next()`
   * calls resolve immediately with `done: true`.
   */
  const events = (): AsyncIterable<TxGroupEvent> => ({
    [Symbol.asyncIterator]: () => {
      const queue: TxGroupEvent[] = []
      const waiters: ((value: IteratorResult<TxGroupEvent>) => void)[] = []
      let done = false

      const unsub = subs.subscribe((event) => {
        if (
          event.kind === 'group-stopped' ||
          event.kind === 'group-complete' ||
          event.kind === 'group-failed'
        ) {
          done = true
        }
        const waiter = waiters.shift()
        if (waiter) {
          waiter({ value: event, done: false })
          if (done) {
            // Drain any remaining waiters with done after a terminal event.
            // Single-iterator usage parks at most one waiter at a time, so
            // this loop body is unreachable through the public API; kept
            // as belt-and-braces against future code paths that might park
            // multiple waiters concurrently. Mirrors tracker.ts:1313.
            while (waiters.length > 0) {
              /* c8 ignore next 4 */
              waiters.shift()!({
                value: undefined as unknown as TxGroupEvent,
                done: true,
              })
            }
          }
        } else {
          queue.push(event)
        }
      })

      return {
        next: () => {
          if (queue.length > 0) {
            const value = queue.shift()!
            return Promise.resolve({ value, done: false })
          }
          if (done) {
            return Promise.resolve({
              value: undefined as unknown as TxGroupEvent,
              done: true,
            })
          }
          return new Promise<IteratorResult<TxGroupEvent>>((resolve) => {
            waiters.push(resolve)
          })
        },
        return: () => {
          unsub()
          done = true
          while (waiters.length > 0) {
            waiters.shift()!({
              value: undefined as unknown as TxGroupEvent,
              done: true,
            })
          }
          return Promise.resolve({
            value: undefined as unknown as TxGroupEvent,
            done: true,
          })
        },
      }
    },
  })

  return {
    events,
    subscribe: (cb: (event: TxGroupEvent) => void) => subs.subscribe(cb),
    snapshot,
    stop,
  }
}
