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
  /**
   * Tag emitted events with this chainId. Falls back to
   * `client.chain?.id`, then `0`. Consumers piping events from multiple
   * watchers into one stream should set this for unambiguous routing.
   */
  chainId?: number
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
      chainId: options.chainId ?? options.client.chain?.id ?? 0,
      onError: options.onError,
    })

    source.start()
    tracker.start()

    let teardownSubscribe: (() => void) | null = null

    // No `settled` flag: tracker.stop() / source.stop() / teardownSubscribe
    // are all idempotent, and Promise resolve is a no-op on second call.
    // The first finish() detaches the subscription, so subsequent events
    // for this hash don't reach the callback — no double-call path remains.
    const finish = (outcome: WaitForTransactionOutcome): void => {
      teardownSubscribe?.()
      tracker.stop()
      source.stop()
      resolve(outcome)
    }

    teardownSubscribe = tracker.subscribe(
      options.hash,
      (event) => {
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
