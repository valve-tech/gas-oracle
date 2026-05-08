/**
 * @fileoverview tx-tracker integration for `addByHash`.
 *
 * Dynamic-imports `@valve-tech/tx-tracker` and `@valve-tech/chain-source`
 * inside the call so wallet-adapter-only consumers don't pay the
 * bundle cost. This is what makes `addByHash` async (the only async
 * method on the hook).
 *
 * Internally builds a private `ChainSource` + `TxTracker` pair (same
 * pattern as `watchTransaction` in tx-tracker), subscribes to the
 * hash, and routes every relevant event into a `store.dispatch.update`
 * patch. The watcher-unsub is registered with the tx so `remove(id)`
 * (and Provider unmount via `dispatch.clear`) cleans up the
 * subscription.
 *
 * Tests inject a stub `ChainSource` via `_sourceOverride`; this
 * mirrors the seam used by `watchTransaction` and keeps test runs
 * hermetic (no real RPC, no live timers).
 */

import type { ChainSource } from '@valve-tech/chain-source'
import type { TxEvent } from '@valve-tech/tx-tracker'
import type { TrackedTx } from '@valve-tech/wallet-adapter'
import type { Hex } from 'viem'

import type { AddByHashInput } from '../types.js'
import type { TxFlightStore } from '../store/store.js'

const DEFAULT_CONFIRMATIONS = 1
const DEFAULT_STALE_AFTER_BLOCKS = 12
const DEFAULT_FLOW = 'unknown'

let txIdCounter = 0
const generateTxId = (): string => `txflight-${Date.now()}-${++txIdCounter}`

/**
 * Translate a tx-tracker event into a TrackedTx patch (or `null` to
 * skip). The translation is conservative: events that don't change
 * lifecycle state (`started`, `stopped`, signal-*, `left-mempool`)
 * return null.
 *
 * Confirmations gate: a `seen-in-block` event only flips to
 * `confirmed` when `event.confirmations >= input.confirmations`. With
 * receipts, a reverted receipt flips to `failed` instead.
 *
 * `staleAfterBlocks` is enforced by the tracker via the
 * `unseenThresholdBlocks` option; this function trusts the threshold
 * and turns every `unseen-for-N-blocks` it receives into `dropped`.
 */
const patchFromTxEvent = (
  event: TxEvent,
  confirmations: number,
): Partial<TrackedTx> | null => {
  switch (event.kind) {
    case 'seen-in-mempool':
      return { status: 'pending' }
    case 'seen-in-block': {
      if (event.confirmations < confirmations) return null
      if (event.receipt && event.receipt.status === 'reverted') {
        return { status: 'failed', notes: 'Transaction reverted', hash: event.hash as Hex }
      }
      return { status: 'confirmed', hash: event.hash as Hex }
    }
    case 'vanished-from-block':
      return { status: 'pending' }
    case 'replaced-by':
      return {
        status: 'replaced',
        replacedBy: event.replacementHash as Hex,
      }
    case 'unseen-for-N-blocks':
      return { status: 'dropped' }
    default:
      return null
  }
}

/**
 * Internal options — not part of the public API.
 *
 * `_sourceOverride` is a test-only seam (mirrors the pattern in
 * `watchTransaction`'s `WatchTransactionInternalOptions`). Production
 * callers never use it.
 *
 * @internal
 */
export interface AddByHashInternalOptions {
  _sourceOverride?: ChainSource
}

export const addByHashImpl = async (
  store: TxFlightStore,
  input: AddByHashInput,
  onError?: (method: string, err: unknown) => void,
  internal?: AddByHashInternalOptions,
): Promise<string> => {
  // Dynamic import — keeps the bundle cost off the wallet-adapter-only
  // consumer path. Resolves the workspace packages on demand.
  const [{ createChainSource }, { createTxTracker }] = await Promise.all([
    import('@valve-tech/chain-source'),
    import('@valve-tech/tx-tracker'),
  ])

  const ownsSource = internal?._sourceOverride === undefined
  const source: ChainSource = internal?._sourceOverride ?? createChainSource({
    client: input.client,
    onError,
  })
  const tracker = createTxTracker({
    source,
    chainId: input.chainId,
    onError,
  })

  source.start()
  tracker.start()

  const confirmations = input.confirmations ?? DEFAULT_CONFIRMATIONS
  const staleAfterBlocks = input.staleAfterBlocks ?? DEFAULT_STALE_AFTER_BLOCKS

  const id = generateTxId()

  const trackerUnsub = tracker.subscribe(
    input.hash,
    (event) => {
      const patch = patchFromTxEvent(event, confirmations)
      if (patch !== null) store.dispatch.update(id, patch)
    },
    {
      emitInitial: false,
      withReceipts: input.withReceipts,
      unseenThresholdBlocks: staleAfterBlocks,
    },
  )

  const unsub = (): void => {
    trackerUnsub()
    tracker.stop()
    // Don't stop a source we don't own — the test seam owns it.
    if (ownsSource) source.stop()
  }

  const initialTx: TrackedTx = {
    id,
    hash: input.hash,
    chainId: input.chainId,
    flow: input.flow ?? DEFAULT_FLOW,
    submittedAt: Date.now(),
    submittedTier: 'standard',
    status: 'pending',
  }
  store.dispatch.addWithTx(initialTx, unsub)

  return id
}
