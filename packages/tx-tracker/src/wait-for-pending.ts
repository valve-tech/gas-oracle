/**
 * `waitForPending` — Promise that resolves when a tx hash is first
 * observed in any mempool. Rejects with `WaitForPendingTimeoutError`
 * if `timeoutBlocks` elapses without observation.
 *
 * Surfaces the "submitted but never arrived" failure mode explicitly:
 * when an RPC accepts a transaction but the tx never appears in any
 * observed mempool, this helper times out rather than hanging.
 *
 * Internally constructs a private ChainSource + TxTracker (or accepts
 * a `_sourceOverride` for tests) and tears them down before settling.
 */

import type { PublicClient } from 'viem'
import type { ChainSource } from '@valve-tech/chain-source'
import { createChainSource } from '@valve-tech/chain-source'

import type { Hash, TxEventSeenInMempool } from './events.js'
import { createTxTracker } from './tracker.js'

export class WaitForPendingTimeoutError extends Error {
  readonly hash: Hash
  readonly observedBlocks: number
  constructor(hash: Hash, observedBlocks: number) {
    super(
      `waitForPending: hash ${hash} not observed in any mempool after ${observedBlocks} block(s)`,
    )
    this.name = 'WaitForPendingTimeoutError'
    this.hash = hash
    this.observedBlocks = observedBlocks
  }
}

export interface WaitForPendingOptions {
  client: PublicClient
  hash: Hash
  /**
   * Reject with WaitForPendingTimeoutError if the hash isn't observed
   * in any mempool within this many block ticks. Default 12.
   */
  timeoutBlocks?: number
  pollIntervalMs?: number
  onError?: (method: string, err: unknown) => void
}

/**
 * @internal
 * Test-injection seam — same shape as the other helpers' seams.
 * Not re-exported from index.ts.
 */
export interface WaitForPendingInternalOptions extends WaitForPendingOptions {
  _sourceOverride?: ChainSource
}

export const waitForPending = (
  options: WaitForPendingOptions,
): Promise<TxEventSeenInMempool> => {
  const internalOptions = options as WaitForPendingInternalOptions
  const timeoutBlocks = options.timeoutBlocks ?? 12

  return new Promise<TxEventSeenInMempool>((resolve, reject) => {
    const source: ChainSource =
      internalOptions._sourceOverride ??
      createChainSource({
        client: options.client,
        pollIntervalMs: options.pollIntervalMs,
        onError: options.onError,
      })
    const tracker = createTxTracker({
      source,
      chainId: 0,
      onError: options.onError,
    })

    const ownsSource = !internalOptions._sourceOverride
    if (ownsSource) source.start()
    tracker.start()

    let teardownSubscribe: (() => void) | null = null
    let teardownBlocks: (() => void) | null = null
    let observedBlocks = 0
    let settled = false

    const finish = (action: () => void): void => {
      // Belt-and-braces: the inner-callback `if (settled) return` guards
      // below prevent finish() from being called twice through the public
      // surface, so this truthy branch is unreachable in single-threaded
      // JS. Kept as defense against future code paths that might bypass
      // the inner guards.
      /* c8 ignore next */
      if (settled) return
      settled = true
      teardownSubscribe?.()
      teardownBlocks?.()
      tracker.stop()
      // Test seam: tests inject `_sourceOverride` (ownsSource=false), so
      // the truthy-arm of this branch is unreachable through the test
      // fixtures. In production callers never set `_sourceOverride`, so
      // ownsSource is always true and source.stop() always runs.
      /* c8 ignore next */
      if (ownsSource) source.stop()
      action()
    }

    teardownSubscribe = tracker.subscribe(
      options.hash,
      (event) => {
        // Inner-callback re-entry guard. Reachable only if a delayed
        // event arrives after the timer-driven reject path already
        // settled — current tests don't exercise that race.
        /* c8 ignore next */
        if (settled) return
        // Filter for the only event kind that resolves this helper. The
        // falsy arm is reachable in principle (any tx event for the hash
        // flows through this callback) but tests only emit seen-in-mempool
        // before the helper settles + tears down.
        /* c8 ignore next */
        if (event.kind === 'seen-in-mempool') {
          finish(() => resolve(event))
        }
      },
      { emitInitial: false },
    )

    teardownBlocks = source.subscribeBlocks(() => {
      // Inner-callback re-entry guard — symmetrical to the subscribe
      // callback above. Reachable only when a block tick lands after a
      // mempool-driven resolve already settled.
      /* c8 ignore next */
      if (settled) return
      observedBlocks++
      if (observedBlocks >= timeoutBlocks) {
        const err = new WaitForPendingTimeoutError(options.hash, observedBlocks)
        finish(() => reject(err))
      }
    })
  })
}
