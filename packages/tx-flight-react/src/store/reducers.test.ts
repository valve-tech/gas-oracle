import { test, expect, vi } from 'vitest'
import type { TrackedTx } from '@valve-tech/wallet-adapter'

import { emptyState } from '../types.js'
import {
  addReducer,
  updateReducer,
  removeReducer,
  evictReducer,
} from './reducers.js'

const makeTx = (overrides: Partial<TrackedTx> = {}): TrackedTx => ({
  id: 'tx-1',
  chainId: 1,
  flow: 'send',
  submittedAt: 1_000_000,
  submittedTier: 'standard',
  status: 'pending',
  ...overrides,
})

// ─── addReducer ────────────────────────────────────────────────────────────

test('addReducer inserts a new tx without a watcher', () => {
  const tx = makeTx()
  const next = addReducer(emptyState, tx, null)
  expect(next.txs.size).toBe(1)
  expect(next.txs.get('tx-1')).toBe(tx)
  expect(next.watchers.has('tx-1')).toBe(false)
})

test('addReducer inserts a watcher when provided', () => {
  const tx = makeTx()
  const unsub = vi.fn()
  const next = addReducer(emptyState, tx, unsub)
  expect(next.watchers.get('tx-1')).toBe(unsub)
  // Reducer is pure — it does not invoke the watcher.
  expect(unsub).not.toHaveBeenCalled()
})

test('addReducer overwrites an existing tx; watcher: null clears any prior watcher', () => {
  const oldUnsub = vi.fn()
  const seeded = addReducer(emptyState, makeTx({ status: 'pending' }), oldUnsub)
  const next = addReducer(seeded, makeTx({ status: 'confirmed' }), null)
  expect(next.txs.get('tx-1')?.status).toBe('confirmed')
  expect(next.watchers.has('tx-1')).toBe(false)
})

test('addReducer with a different id leaves the prior tx + watcher intact', () => {
  const unsubA = vi.fn()
  const seeded = addReducer(emptyState, makeTx({ id: 'tx-a' }), unsubA)
  const next = addReducer(seeded, makeTx({ id: 'tx-b' }), null)
  expect(next.txs.size).toBe(2)
  expect(next.watchers.get('tx-a')).toBe(unsubA)
  expect(next.watchers.has('tx-b')).toBe(false)
})

// ─── updateReducer ─────────────────────────────────────────────────────────

test('updateReducer patches existing fields and returns a new state', () => {
  const seeded = addReducer(emptyState, makeTx(), null)
  const next = updateReducer(seeded, 'tx-1', { hash: '0xabc', status: 'pending' }, 2_000_000)
  expect(next).not.toBe(seeded)
  expect(next.txs.get('tx-1')?.hash).toBe('0xabc')
})

test('updateReducer no-ops on a missing id and returns the same state reference', () => {
  const seeded = addReducer(emptyState, makeTx(), null)
  const next = updateReducer(seeded, 'tx-missing', { status: 'confirmed' }, 2_000_000)
  expect(next).toBe(seeded)
})

test('updateReducer stamps confirmedAt when status flips to a terminal value', () => {
  const seeded = addReducer(emptyState, makeTx({ status: 'pending' }), null)
  const next = updateReducer(seeded, 'tx-1', { status: 'confirmed' }, 2_000_500)
  expect(next.txs.get('tx-1')?.confirmedAt).toBe(2_000_500)
})

test('updateReducer does NOT overwrite an already-set confirmedAt', () => {
  const seeded = addReducer(
    emptyState,
    makeTx({ status: 'confirmed', confirmedAt: 1_500_000 }),
    null,
  )
  const next = updateReducer(seeded, 'tx-1', { notes: 'still confirmed' }, 9_999_999)
  expect(next.txs.get('tx-1')?.confirmedAt).toBe(1_500_000)
})

test('updateReducer stamps confirmedAt for failed/dropped/replaced too', () => {
  for (const terminal of ['failed', 'dropped', 'replaced'] as const) {
    const seeded = addReducer(emptyState, makeTx({ status: 'pending' }), null)
    const next = updateReducer(seeded, 'tx-1', { status: terminal }, 5_000_000)
    expect(next.txs.get('tx-1')?.confirmedAt).toBe(5_000_000)
  }
})

test('updateReducer does NOT stamp confirmedAt for non-terminal patches', () => {
  const seeded = addReducer(emptyState, makeTx({ status: 'pending' }), null)
  const next = updateReducer(seeded, 'tx-1', { hash: '0xabc' }, 5_000_000)
  expect(next.txs.get('tx-1')?.confirmedAt).toBeUndefined()
})

// ─── removeReducer ─────────────────────────────────────────────────────────

test('removeReducer drops the tx and its watcher entry', () => {
  const unsub = vi.fn()
  const seeded = addReducer(emptyState, makeTx(), unsub)
  const next = removeReducer(seeded, 'tx-1')
  expect(next.txs.size).toBe(0)
  expect(next.watchers.size).toBe(0)
  // Reducer is pure — it does not invoke the watcher.
  expect(unsub).not.toHaveBeenCalled()
})

test('removeReducer no-ops on a missing id and returns the same state reference', () => {
  const seeded = addReducer(emptyState, makeTx(), null)
  const next = removeReducer(seeded, 'tx-missing')
  expect(next).toBe(seeded)
})

// ─── evictReducer ──────────────────────────────────────────────────────────

const evictOpts = (now: number, overrides: Partial<{ maxItems: number; terminalRetentionMs: number }> = {}) => ({
  maxItems: 50,
  terminalRetentionMs: 60_000,
  now,
  ...overrides,
})

test('evictReducer drops terminals past terminalRetentionMs', () => {
  let state = emptyState
  state = addReducer(state, makeTx({ id: 'old', status: 'confirmed', confirmedAt: 1_000 }), null)
  state = addReducer(state, makeTx({ id: 'recent', status: 'confirmed', confirmedAt: 100_000 }), null)
  const next = evictReducer(state, evictOpts(120_000))
  // old: 120_000 - 1_000 = 119_000ms > 60_000 → evict
  // recent: 120_000 - 100_000 = 20_000ms <= 60_000 → keep
  expect(next.txs.has('old')).toBe(false)
  expect(next.txs.has('recent')).toBe(true)
})

test('evictReducer keeps non-terminal entries regardless of age', () => {
  let state = emptyState
  state = addReducer(state, makeTx({ id: 'pending-old', status: 'pending', submittedAt: 1_000 }), null)
  const next = evictReducer(state, evictOpts(999_999_999))
  expect(next.txs.has('pending-old')).toBe(true)
})

test('evictReducer truncates over maxItems by dropping oldest terminals first', () => {
  let state = emptyState
  // 3 terminals (within retention) + 1 non-terminal, maxItems=2
  state = addReducer(state, makeTx({ id: 't-1', status: 'confirmed', confirmedAt: 100 }), null)
  state = addReducer(state, makeTx({ id: 't-2', status: 'confirmed', confirmedAt: 200 }), null)
  state = addReducer(state, makeTx({ id: 't-3', status: 'confirmed', confirmedAt: 300 }), null)
  state = addReducer(state, makeTx({ id: 'p-1', status: 'pending', submittedAt: 50 }), null)
  const next = evictReducer(state, evictOpts(400, { maxItems: 2 }))
  // expired: none (all confirmedAt within retention from now=400)
  // truncate: 4 -> 2; drop terminals oldest-first: t-1, t-2
  expect(next.txs.has('t-1')).toBe(false)
  expect(next.txs.has('t-2')).toBe(false)
  expect(next.txs.has('t-3')).toBe(true)
  expect(next.txs.has('p-1')).toBe(true)
})

test('evictReducer drops oldest non-terminals only when no terminals remain to evict', () => {
  let state = emptyState
  state = addReducer(state, makeTx({ id: 'p-old', status: 'pending', submittedAt: 100 }), null)
  state = addReducer(state, makeTx({ id: 'p-new', status: 'pending', submittedAt: 200 }), null)
  state = addReducer(state, makeTx({ id: 'p-newer', status: 'pending', submittedAt: 300 }), null)
  const next = evictReducer(state, evictOpts(400, { maxItems: 2 }))
  expect(next.txs.has('p-old')).toBe(false)
  expect(next.txs.has('p-new')).toBe(true)
  expect(next.txs.has('p-newer')).toBe(true)
})

test('evictReducer drops watcher map entries for evicted txs', () => {
  const unsub = vi.fn()
  let state = emptyState
  state = addReducer(state, makeTx({ id: 'old', status: 'confirmed', confirmedAt: 1_000 }), unsub)
  const next = evictReducer(state, evictOpts(120_000))
  expect(next.watchers.has('old')).toBe(false)
})

test('evictReducer returns the same state reference when nothing changed', () => {
  const state = addReducer(emptyState, makeTx({ status: 'pending' }), null)
  const next = evictReducer(state, evictOpts(2_000))
  expect(next).toBe(state)
})

test('evictReducer falls back to submittedAt when confirmedAt is not set on a terminal', () => {
  // Failed tx without confirmedAt — falls back to submittedAt.
  let state = emptyState
  state = addReducer(
    state,
    makeTx({ id: 'failed-no-confirmed', status: 'failed', submittedAt: 1_000 }),
    null,
  )
  const next = evictReducer(state, evictOpts(120_000))
  expect(next.txs.has('failed-no-confirmed')).toBe(false)
})

test('evictReducer combines Pass 1 expiry and Pass 2 truncation in one tick', () => {
  let state = emptyState
  // 2 expired terminals (Pass 1 evicts both) + 3 fresh terminals + 1 non-terminal.
  // After Pass 1: 4 entries left. maxItems=3 → Pass 2 drops 1 more (oldest fresh terminal).
  state = addReducer(state, makeTx({ id: 'old-1', status: 'confirmed', confirmedAt: 1_000 }), null)
  state = addReducer(state, makeTx({ id: 'old-2', status: 'confirmed', confirmedAt: 1_500 }), null)
  state = addReducer(state, makeTx({ id: 'fresh-1', status: 'confirmed', confirmedAt: 100_000 }), null)
  state = addReducer(state, makeTx({ id: 'fresh-2', status: 'confirmed', confirmedAt: 110_000 }), null)
  state = addReducer(state, makeTx({ id: 'fresh-3', status: 'confirmed', confirmedAt: 120_000 }), null)
  state = addReducer(state, makeTx({ id: 'p-1', status: 'pending', submittedAt: 50_000 }), null)
  const next = evictReducer(state, evictOpts(125_000, { maxItems: 3 }))
  expect(next.txs.has('old-1')).toBe(false)   // expired in Pass 1
  expect(next.txs.has('old-2')).toBe(false)   // expired in Pass 1
  expect(next.txs.has('fresh-1')).toBe(false) // truncated in Pass 2
  expect(next.txs.has('fresh-2')).toBe(true)
  expect(next.txs.has('fresh-3')).toBe(true)
  expect(next.txs.has('p-1')).toBe(true)
})
