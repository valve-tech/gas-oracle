/**
 * `watchTransaction` — one-shot convenience over createChainSource +
 * createTxTracker. Provex upstream item 4 (memory:
 * upstream-candidates.md#L43). Use this when you don't need the full
 * tracker API — just "tell me when this hash mines or drops."
 *
 * Internally constructs a private ChainSource and TxTracker, sets up
 * a single-hash subscription, and tears down both source + tracker on
 * terminal state or explicit stop.
 */

import type { PublicClient } from 'viem'

import {
  createChainSource,
  type ChainSource,
} from '@valve-tech/chain-source'

import type {
  Hash,
  TxEventSeenInBlock,
} from './events.js'
import { createTxTracker } from './tracker.js'

export interface WatchTransactionOptions {
  client: PublicClient
  hash: Hash
  /** Required confirmations before onMined fires. Default 1. */
  confirmations?: number
  /** Blocks of "no observation" before onDropped fires. Default 12. */
  staleAfterBlocks?: number
  /**
   * Tag emitted events with this chainId. Falls back to
   * `client.chain?.id`, then `0`. Consumers piping events from multiple
   * watchers into one stream should set this for unambiguous routing.
   */
  chainId?: number
  /** Pass through to the internal ChainSource. */
  pollIntervalMs?: number
  onMined?: (event: TxEventSeenInBlock) => void
  onDropped?: () => void
  onError?: (method: string, err: unknown) => void
}

/**
 * Extended options for internal use only — not part of the public API.
 * The `_sourceOverride` seam allows tests to inject a pre-built
 * `ChainSource` (driven by `emitBlock`/`emitMempool`) in place of the
 * default `createChainSource(client)` path. Production callers never
 * need this.
 *
 * @internal
 */
export interface WatchTransactionInternalOptions extends WatchTransactionOptions {
  /** @internal — test injection seam; do not use in production code. */
  _sourceOverride?: ChainSource
}

/**
 * Watch a single tx hash. Returns an unsubscribe function — calling
 * it before terminal cancels the watch and tears down the internal
 * source/tracker.
 *
 * @example
 *   const stop = watchTransaction({
 *     client,
 *     hash: '0xabc...',
 *     confirmations: 3,
 *     onMined: (event) => console.log('mined at', event.blockNumber),
 *     onDropped: () => console.log('dropped'),
 *   })
 *   // ... later, before terminal
 *   stop()
 */
export const watchTransaction = (
  options: WatchTransactionOptions | WatchTransactionInternalOptions,
): (() => void) => {
  const confirmations = options.confirmations ?? 1
  const staleAfterBlocks = options.staleAfterBlocks ?? 12

  const internal = options as WatchTransactionInternalOptions
  const source: ChainSource = internal._sourceOverride ?? createChainSource({
    client: options.client,
    pollIntervalMs: options.pollIntervalMs,
    onError: options.onError,
  })
  const tracker = createTxTracker({
    source,
    chainId: options.chainId ?? options.client.chain?.id ?? 0,
    onError: options.onError,
  })

  source.start()
  tracker.start()

  let teardown: (() => void) | null = null
  let done = false

  const finish = (): void => {
    if (done) return
    done = true
    teardown?.()
    teardown = null
    tracker.stop()
    source.stop()
  }

  const unsub = tracker.subscribe(
    options.hash,
    (event) => {
      if (done) return
      if (event.kind === 'seen-in-block' && event.confirmations >= confirmations) {
        options.onMined?.(event)
        finish()
        return
      }
      if (event.kind === 'unseen-for-N-blocks' && event.blocks >= staleAfterBlocks) {
        options.onDropped?.()
        finish()
        return
      }
    },
    {
      emitInitial: false,
      unseenThresholdBlocks: staleAfterBlocks,
    },
  )
  teardown = unsub

  return () => finish()
}
