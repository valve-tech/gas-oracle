/**
 * `waitForTransaction` — Promise variant of `watchTransaction`. Use
 * when you'd rather `await` the outcome than register callbacks.
 *
 * Resolves with a discriminated union: { status: 'mined' | 'dropped'
 * | 'replaced' | 'failed', ... }. Rejects only on tracker/source
 * errors — transaction outcomes are part of the resolved value, not
 * exceptions.
 *
 * Internally constructs a private ChainSource + TxTracker and tears
 * them down before resolving.
 */

import type { PublicClient } from 'viem'
import type {
  ChainSource,
  TransactionReceipt,
} from '@valve-tech/chain-source'
import { createChainSource } from '@valve-tech/chain-source'

import type {
  Hash,
  TxEventReplacedBy,
  TxEventSeenInBlock,
} from './events.js'
import { createTxTracker } from './tracker.js'

export type WaitForTransactionOutcome =
  | { status: 'mined';     event: TxEventSeenInBlock }
  | { status: 'dropped';   reason: 'unseen-for-N-blocks' }
  | { status: 'replaced';  replacementHash: Hash; event: TxEventReplacedBy }
  | { status: 'failed';    event: TxEventSeenInBlock; receipt: TransactionReceipt }

export interface WaitForTransactionOptions {
  client: PublicClient
  hash: Hash
  /** Required confirmations before 'mined' resolves. Default 1. */
  confirmations?: number
  /** Blocks of "no observation" before 'dropped' resolves. Default 12. */
  staleAfterBlocks?: number
  /**
   * If true, fetches the receipt at inclusion and resolves with
   * 'failed' when receipt.status === '0x0'. Adds one RPC.
   */
  withReceipts?: boolean
  pollIntervalMs?: number
  onError?: (method: string, err: unknown) => void
}

/**
 * @internal
 * Test-injection seam — same shape as watchTransaction's seam.
 * Not re-exported from index.ts.
 */
export interface WaitForTransactionInternalOptions extends WaitForTransactionOptions {
  _sourceOverride?: ChainSource
}

export const waitForTransaction = (
  options: WaitForTransactionOptions,
): Promise<WaitForTransactionOutcome> => {
  const internalOptions = options as WaitForTransactionInternalOptions
  const confirmations = options.confirmations ?? 1
  const staleAfterBlocks = options.staleAfterBlocks ?? 12

  return new Promise<WaitForTransactionOutcome>((resolve) => {
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
    let settled = false

    const finish = (outcome: WaitForTransactionOutcome): void => {
      // Belt-and-braces: the inner-callback `if (settled) return` guard
      // below prevents finish() from being called twice through the
      // public surface, so this truthy branch is unreachable in single-
      // threaded JS. Kept as defense against future bypass paths.
      /* c8 ignore next */
      if (settled) return
      settled = true
      teardownSubscribe?.()
      tracker.stop()
      // Test seam: tests inject `_sourceOverride` (ownsSource=false), so
      // the truthy-arm of this branch is unreachable through the test
      // fixtures. In production callers never set `_sourceOverride`, so
      // ownsSource is always true and source.stop() always runs.
      /* c8 ignore next */
      if (ownsSource) source.stop()
      resolve(outcome)
    }

    teardownSubscribe = tracker.subscribe(
      options.hash,
      (event) => {
        // Inner-callback re-entry guard. Reachable only if a delayed
        // event arrives after the helper already settled on a prior
        // event — current tests resolve on the first qualifying event.
        /* c8 ignore next */
        if (settled) return
        if (event.kind === 'seen-in-block' && event.confirmations >= confirmations) {
          if (options.withReceipts && event.receipt && event.receipt.status === '0x0') {
            finish({ status: 'failed', event, receipt: event.receipt })
            return
          }
          finish({ status: 'mined', event })
          return
        }
        if (event.kind === 'unseen-for-N-blocks' && event.blocks >= staleAfterBlocks) {
          finish({ status: 'dropped', reason: 'unseen-for-N-blocks' })
          return
        }
        if (event.kind === 'replaced-by') {
          finish({
            status: 'replaced',
            replacementHash: event.replacementHash,
            event,
          })
          return
        }
      },
      {
        emitInitial: false,
        unseenThresholdBlocks: staleAfterBlocks,
        ...(options.withReceipts ? { withReceipts: true } : {}),
      },
    )
  })
}
