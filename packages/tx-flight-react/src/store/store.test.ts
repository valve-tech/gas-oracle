import { test, expect, vi } from 'vitest'
import type { TrackedTx } from '@valve-tech/wallet-adapter'

import { createTxFlightStore } from './store.js'

const makeTx = (overrides: Partial<TrackedTx> = {}): TrackedTx => ({
  id: 'tx-1',
  chainId: 1,
  flow: 'send',
  submittedAt: 1_000_000,
  submittedTier: 'standard',
  status: 'pending',
  ...overrides,
})

const makeStore = (overrides: Partial<Parameters<typeof createTxFlightStore>[0]> = {}) =>
  createTxFlightStore({ maxItems: 50, terminalRetentionMs: 60_000, ...overrides })

// ─── initial state ─────────────────────────────────────────────────────────

test('createTxFlightStore returns an empty initial state', () => {
  const store = makeStore()
  expect(store.getState().txs.size).toBe(0)
  expect(store.getState().watchers.size).toBe(0)
  expect(store.getTxs()).toEqual([])
})

test('getTxs caches between calls without state changes', () => {
  const store = makeStore()
  store.dispatch.addWithTx(makeTx(), null)
  const a = store.getTxs()
  const b = store.getTxs()
  expect(a).toBe(b)
})

test('getTxs invalidates the cache when state changes', () => {
  const store = makeStore()
  store.dispatch.addWithTx(makeTx(), null)
  const a = store.getTxs()
  store.dispatch.addWithTx(makeTx({ id: 'tx-2' }), null)
  const b = store.getTxs()
  expect(a).not.toBe(b)
  expect(b.length).toBe(2)
})

// ─── subscribe / unsubscribe ──────────────────────────────────────────────

test('subscribe fires the listener on every dispatch that mutates state', () => {
  const store = makeStore()
  const listener = vi.fn()
  store.subscribe(listener)
  store.dispatch.addWithTx(makeTx(), null)
  store.dispatch.update('tx-1', { status: 'confirmed' })
  store.dispatch.remove('tx-1')
  expect(listener).toHaveBeenCalledTimes(3)
})

test('subscribe returns an unsubscribe; the listener no longer fires after it', () => {
  const store = makeStore()
  const listener = vi.fn()
  const unsubscribe = store.subscribe(listener)
  store.dispatch.addWithTx(makeTx(), null)
  expect(listener).toHaveBeenCalledTimes(1)
  unsubscribe()
  store.dispatch.addWithTx(makeTx({ id: 'tx-2' }), null)
  expect(listener).toHaveBeenCalledTimes(1)
})

test('listener is NOT fired when a dispatch produces an identity-equal state', () => {
  const store = makeStore()
  const listener = vi.fn()
  store.subscribe(listener)
  // update on a non-existent id is a no-op (returns same state ref).
  store.dispatch.update('missing', { status: 'confirmed' })
  // remove on a non-existent id is also a no-op.
  store.dispatch.remove('missing')
  expect(listener).not.toHaveBeenCalled()
})

// ─── addWithTx ─────────────────────────────────────────────────────────────

test('addWithTx inserts the tx and registers the watcher', () => {
  const store = makeStore()
  const unsub = vi.fn()
  store.dispatch.addWithTx(makeTx(), unsub)
  expect(store.getState().txs.get('tx-1')?.id).toBe('tx-1')
  expect(store.getState().watchers.get('tx-1')).toBe(unsub)
})

test('addWithTx unsubs the prior watcher when overwriting under the same id', () => {
  const store = makeStore()
  const oldUnsub = vi.fn()
  const newUnsub = vi.fn()
  store.dispatch.addWithTx(makeTx({ status: 'pending' }), oldUnsub)
  store.dispatch.addWithTx(makeTx({ status: 'confirmed' }), newUnsub)
  expect(oldUnsub).toHaveBeenCalledOnce()
  expect(store.getState().watchers.get('tx-1')).toBe(newUnsub)
})

// ─── update ────────────────────────────────────────────────────────────────

test('update merges patch into the existing tx', () => {
  const store = makeStore()
  store.dispatch.addWithTx(makeTx(), null)
  store.dispatch.update('tx-1', { status: 'confirmed', notes: 'ok' })
  expect(store.getState().txs.get('tx-1')?.status).toBe('confirmed')
  expect(store.getState().txs.get('tx-1')?.notes).toBe('ok')
})

// ─── remove ────────────────────────────────────────────────────────────────

test('remove drops the tx and calls its watcher unsub', () => {
  const store = makeStore()
  const unsub = vi.fn()
  store.dispatch.addWithTx(makeTx(), unsub)
  store.dispatch.remove('tx-1')
  expect(unsub).toHaveBeenCalledOnce()
  expect(store.getState().txs.has('tx-1')).toBe(false)
})

test('remove with no watcher is fine', () => {
  const store = makeStore()
  store.dispatch.addWithTx(makeTx(), null)
  store.dispatch.remove('tx-1')
  expect(store.getState().txs.has('tx-1')).toBe(false)
})

// ─── clear ─────────────────────────────────────────────────────────────────

test('clear empties state and calls every watcher unsub', () => {
  const store = makeStore()
  const a = vi.fn()
  const b = vi.fn()
  store.dispatch.addWithTx(makeTx({ id: 'a' }), a)
  store.dispatch.addWithTx(makeTx({ id: 'b' }), b)
  store.dispatch.clear()
  expect(a).toHaveBeenCalledOnce()
  expect(b).toHaveBeenCalledOnce()
  expect(store.getState().txs.size).toBe(0)
  expect(store.getState().watchers.size).toBe(0)
})

// ─── evict ─────────────────────────────────────────────────────────────────

test('evict prunes terminal entries past their retention window and unsubs their watchers', () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
  const store = makeStore({ terminalRetentionMs: 1000 })
  const unsub = vi.fn()
  store.dispatch.addWithTx(
    makeTx({ status: 'confirmed', confirmedAt: 1_000_000 - 5_000 }),
    unsub,
  )
  store.dispatch.evict()
  expect(unsub).toHaveBeenCalledOnce()
  expect(store.getState().txs.size).toBe(0)
  now.mockRestore()
})

test('evict only unsubs watchers for evicted entries; survivors keep theirs', () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000)
  const store = makeStore({ terminalRetentionMs: 1000 })
  const oldUnsub = vi.fn()
  const newUnsub = vi.fn()
  store.dispatch.addWithTx(
    makeTx({ id: 'old', status: 'confirmed', confirmedAt: 1_000_000 - 5_000 }),
    oldUnsub,
  )
  store.dispatch.addWithTx(
    makeTx({ id: 'new', status: 'pending' }),
    newUnsub,
  )
  store.dispatch.evict()
  expect(oldUnsub).toHaveBeenCalledOnce()
  expect(newUnsub).not.toHaveBeenCalled()
  expect(store.getState().txs.has('new')).toBe(true)
  expect(store.getState().txs.has('old')).toBe(false)
  now.mockRestore()
})

test('evict is a no-op (no listener fire) when nothing changes', () => {
  const store = makeStore()
  const listener = vi.fn()
  store.subscribe(listener)
  store.dispatch.evict()
  expect(listener).not.toHaveBeenCalled()
})

// ─── error handling ────────────────────────────────────────────────────────

test('a watcher unsub that throws is swallowed and routed to onError', () => {
  const onError = vi.fn()
  const store = makeStore({ onError })
  const bad = (): void => {
    throw new Error('unsub blew up')
  }
  store.dispatch.addWithTx(makeTx(), bad)
  store.dispatch.remove('tx-1')
  expect(onError).toHaveBeenCalledOnce()
  expect(onError.mock.calls[0]?.[0]).toBe('watcher-unsub')
  expect(onError.mock.calls[0]?.[1]).toBeInstanceOf(Error)
})

test('a watcher unsub that throws without onError set still does not propagate', () => {
  const store = makeStore()
  const bad = (): void => {
    throw new Error('unsub blew up')
  }
  store.dispatch.addWithTx(makeTx(), bad)
  expect(() => store.dispatch.remove('tx-1')).not.toThrow()
})
