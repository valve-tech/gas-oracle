/**
 * @fileoverview wallet-adapter integration for `addWithWalletAdapter`.
 *
 * Two pieces:
 *
 *  - `wrapHooks(userHooks, store, txId, onError?)`: returns a new
 *    `WriteHookParams` bag where every named callback fans out to
 *    BOTH the consumer's original callback AND a `store.dispatch.update`
 *    that reflects the new lifecycle state on the strip's TrackedTx.
 *    Errors thrown by user callbacks are routed to `onError` and
 *    swallowed so a buggy user callback can't break the store update.
 *
 *  - `addWithWalletAdapterImpl(store, input, onError?)`: builds the
 *    initial `preparing`-status TrackedTx, inserts it via
 *    `store.dispatch.addWithTx`, and returns `{ id, hooks }` so the
 *    consumer can pipe the wrapped hooks straight into
 *    `sendTransactionWithHooks`.
 *
 * No runtime `import` from `@valve-tech/wallet-adapter` — only `import
 * type`. wallet-adapter is an optional peer dep; consumers who never
 * use `addWithWalletAdapter` shouldn't pay the dependency cost. The
 * status values (`'preparing'`, `'pending'`, etc.) live as string
 * literals here, typed against `TrackedTxStatus`.
 */

import type {
  TrackedTx,
  WriteHookParams,
} from '@valve-tech/wallet-adapter'

import type { AddWithWalletAdapterInput } from '../types.js'
import type { TxFlightStore } from '../store/store.js'

let txIdCounter = 0
const generateTxId = (): string => `txflight-${Date.now()}-${++txIdCounter}`

const safeFire = <T>(
  fn: ((arg: T) => void) | undefined,
  arg: T,
  onError: ((method: string, err: unknown) => void) | undefined,
): void => {
  if (!fn) return
  try {
    fn(arg)
  } catch (err) {
    onError?.('user-hook', err)
  }
}

export const wrapHooks = (
  userHooks: WriteHookParams,
  store: TxFlightStore,
  txId: string,
  onError?: (method: string, err: unknown) => void,
): WriteHookParams => ({
  onAwaitingSignature: (info) => {
    safeFire(userHooks.onAwaitingSignature, info, onError)
    store.dispatch.update(txId, { status: 'awaiting-signature' })
  },
  onTransactionHash: (info) => {
    safeFire(userHooks.onTransactionHash, info, onError)
    store.dispatch.update(txId, { status: 'pending', hash: info.hash })
  },
  onConfirmed: (info) => {
    safeFire(userHooks.onConfirmed, info, onError)
    store.dispatch.update(txId, { status: 'confirmed', hash: info.hash })
  },
  onFailed: (info) => {
    safeFire(userHooks.onFailed, info, onError)
    const patch: Partial<TrackedTx> = {
      status: 'failed',
      notes: info.error.message,
    }
    if (info.hash !== undefined) patch.hash = info.hash
    store.dispatch.update(txId, patch)
  },
  onDropped: (info) => {
    safeFire(userHooks.onDropped, info, onError)
    store.dispatch.update(txId, { status: 'dropped', hash: info.hash })
  },
  onReplaced: (info) => {
    safeFire(userHooks.onReplaced, info, onError)
    store.dispatch.update(txId, {
      status: 'replaced',
      replacedBy: info.replacement,
      hash: info.original,
    })
  },
  // `onPhase` only fans out to the consumer's onPhase; the named-hook
  // path above is what writes to the store. wallet-adapter fires both
  // shapes for every transition, so we don't lose any updates by
  // attaching the dispatch to one side only — and we avoid double-
  // writes when the same transition fires both shapes.
  onPhase: (event) => {
    safeFire(userHooks.onPhase, event, onError)
  },
})

export interface AddWithWalletAdapterResult {
  id: string
  hooks: WriteHookParams
}

export const addWithWalletAdapterImpl = (
  store: TxFlightStore,
  input: AddWithWalletAdapterInput,
  onError?: (method: string, err: unknown) => void,
): AddWithWalletAdapterResult => {
  const id = generateTxId()
  const initialTx: TrackedTx = {
    id,
    chainId: input.chainId,
    flow: input.flow,
    submittedAt: Date.now(),
    // Default tier; addManual is the path for consumers who need a
    // specific gas-oracle tier echoed onto the record.
    submittedTier: 'standard',
    status: 'preparing',
  }
  store.dispatch.addWithTx(initialTx, null)
  const hooks = wrapHooks(input.hooks, store, id, onError)
  return { id, hooks }
}
