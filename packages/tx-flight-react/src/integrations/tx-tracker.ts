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
import type { Hex, PublicClient } from 'viem'

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

interface SubscribeWatcherOptions {
  store: TxFlightStore
  txId: string
  hash: Hex
  chainId: number
  client: PublicClient
  confirmations: number
  staleAfterBlocks: number
  withReceipts: boolean | undefined
  onError: ((method: string, err: unknown) => void) | undefined
  sourceOverride: ChainSource | undefined
}

/** Build the private ChainSource + TxTracker pair and return a single unsub. */
const subscribeWatcher = async (
  opts: SubscribeWatcherOptions,
): Promise<() => void> => {
  // Dynamic import — keeps the bundle cost off the wallet-adapter-only
  // consumer path. Resolves the workspace packages on demand.
  const [{ createChainSource }, { createTxTracker }] = await Promise.all([
    import('@valve-tech/chain-source'),
    import('@valve-tech/tx-tracker'),
  ])

  const ownsSource = opts.sourceOverride === undefined
  const source: ChainSource = opts.sourceOverride ?? createChainSource({
    client: opts.client,
    onError: opts.onError,
  })
  const tracker = createTxTracker({
    source,
    chainId: opts.chainId,
    onError: opts.onError,
  })

  source.start()
  tracker.start()

  const trackerUnsub = tracker.subscribe(
    opts.hash,
    (event) => {
      const patch = patchFromTxEvent(event, opts.confirmations)
      if (patch !== null) opts.store.dispatch.update(opts.txId, patch)
    },
    {
      emitInitial: false,
      withReceipts: opts.withReceipts,
      unseenThresholdBlocks: opts.staleAfterBlocks,
    },
  )

  return () => {
    trackerUnsub()
    tracker.stop()
    // Don't stop a source we don't own — the test seam owns it.
    if (ownsSource) source.stop()
  }
}

export const addByHashImpl = async (
  store: TxFlightStore,
  input: AddByHashInput,
  onError?: (method: string, err: unknown) => void,
  internal?: AddByHashInternalOptions,
): Promise<string> => {
  const id = generateTxId()
  const unsub = await subscribeWatcher({
    store,
    txId: id,
    hash: input.hash,
    chainId: input.chainId,
    client: input.client,
    confirmations: input.confirmations ?? DEFAULT_CONFIRMATIONS,
    staleAfterBlocks: input.staleAfterBlocks ?? DEFAULT_STALE_AFTER_BLOCKS,
    withReceipts: input.withReceipts,
    onError,
    sourceOverride: internal?._sourceOverride,
  })

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

/**
 * Resume watching an already-persisted TrackedTx. Used by Provider on
 * rehydrate to re-attach a tx-tracker subscription to a `pending` tx
 * we loaded from storage. Overwrites the existing entry with itself
 * plus the new watcher.
 *
 * No-op if `tx.hash` is missing — those entries were caught earlier
 * in the rehydrate path and translated to `failed`.
 */
export const resumeByHashWatcher = async (
  store: TxFlightStore,
  tx: TrackedTx,
  client: PublicClient,
  onError?: (method: string, err: unknown) => void,
  internal?: AddByHashInternalOptions,
): Promise<void> => {
  if (tx.hash === undefined) return
  let unsub: (() => void)
  try {
    unsub = await subscribeWatcher({
      store,
      txId: tx.id,
      hash: tx.hash,
      chainId: tx.chainId,
      client,
      confirmations: DEFAULT_CONFIRMATIONS,
      staleAfterBlocks: DEFAULT_STALE_AFTER_BLOCKS,
      withReceipts: undefined,
      onError,
      sourceOverride: internal?._sourceOverride,
    })
  } catch (err) {
    onError?.('rehydrate-watcher', err)
    return
  }
  // The current state still holds the entry — overwrite with the same
  // tx + the new watcher unsub.
  const current = store.getState().txs.get(tx.id)
  if (!current) {
    // Tx was removed (e.g., user dispatched remove) before our async
    // subscribe completed. Tear down rather than reattach.
    unsub()
    return
  }
  store.dispatch.addWithTx(current, unsub)
}
