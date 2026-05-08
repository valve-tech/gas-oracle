import { test, expect, vi } from 'vitest'
import type {
  TrackedTx,
  WriteHookParams,
  WritePhaseSteps,
  TxContext,
} from '@valve-tech/wallet-adapter'
import type {
  Block,
  Hex,
  TransactionReceipt,
  Address,
} from 'viem'

import { createTxFlightStore } from '../store/store.js'
import { wrapHooks, addWithWalletAdapterImpl } from './wallet-adapter.js'

// ─── shared fixtures ──────────────────────────────────────────────────────

const REQUEST = { to: '0x0000000000000000000000000000000000000000' as Address } as const
const HASH: Hex = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
const REPLACEMENT_HASH: Hex = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
const FAKE_RECEIPT = { transactionHash: HASH } as unknown as TransactionReceipt
const FAKE_BLOCK = { number: 1n } as unknown as Block

const ctx = <K extends keyof WritePhaseSteps>(extra: WritePhaseSteps[K]): TxContext<WritePhaseSteps[K]> => ({
  chainId: 1,
  request: REQUEST,
  ...extra,
})

const makeStore = () =>
  createTxFlightStore({ maxItems: 50, terminalRetentionMs: 60_000 })

const seedTx = (overrides: Partial<TrackedTx> = {}): TrackedTx => ({
  id: 'wrap-tgt',
  chainId: 1,
  flow: 'send',
  submittedAt: 1_000_000,
  submittedTier: 'standard',
  status: 'preparing',
  ...overrides,
})

// ─── wrapHooks ─────────────────────────────────────────────────────────────

test('wrapped onAwaitingSignature dispatches awaiting-signature and forwards', () => {
  const store = makeStore()
  store.dispatch.addWithTx(seedTx(), null)
  const onAwaitingSignature = vi.fn()
  const wrapped = wrapHooks({ onAwaitingSignature }, store, 'wrap-tgt')
  wrapped.onAwaitingSignature!(ctx<'awaiting-signature'>({}))
  expect(onAwaitingSignature).toHaveBeenCalledOnce()
  expect(store.getState().txs.get('wrap-tgt')?.status).toBe('awaiting-signature')
})

test('wrapped onTransactionHash dispatches pending and sets hash', () => {
  const store = makeStore()
  store.dispatch.addWithTx(seedTx(), null)
  const onTransactionHash = vi.fn()
  const wrapped = wrapHooks({ onTransactionHash }, store, 'wrap-tgt')
  wrapped.onTransactionHash!(ctx<'pending'>({ hash: HASH }))
  expect(onTransactionHash).toHaveBeenCalledOnce()
  const tx = store.getState().txs.get('wrap-tgt')
  expect(tx?.status).toBe('pending')
  expect(tx?.hash).toBe(HASH)
})

test('wrapped onConfirmed dispatches confirmed', () => {
  const store = makeStore()
  store.dispatch.addWithTx(seedTx(), null)
  const onConfirmed = vi.fn()
  const wrapped = wrapHooks({ onConfirmed }, store, 'wrap-tgt')
  wrapped.onConfirmed!(ctx<'confirmed'>({ hash: HASH, receipt: FAKE_RECEIPT, block: FAKE_BLOCK }))
  expect(onConfirmed).toHaveBeenCalledOnce()
  expect(store.getState().txs.get('wrap-tgt')?.status).toBe('confirmed')
})

test('wrapped onFailed dispatches failed with notes from error.message', () => {
  const store = makeStore()
  store.dispatch.addWithTx(seedTx(), null)
  const onFailed = vi.fn()
  const wrapped = wrapHooks({ onFailed }, store, 'wrap-tgt')
  wrapped.onFailed!(ctx<'failed'>({ error: new Error('reverted') }))
  expect(onFailed).toHaveBeenCalledOnce()
  const tx = store.getState().txs.get('wrap-tgt')
  expect(tx?.status).toBe('failed')
  expect(tx?.notes).toBe('reverted')
})

test('wrapped onFailed sets hash on the tx when the error carried one', () => {
  const store = makeStore()
  store.dispatch.addWithTx(seedTx(), null)
  const wrapped = wrapHooks({}, store, 'wrap-tgt')
  wrapped.onFailed!(ctx<'failed'>({ error: new Error('revert'), hash: HASH }))
  expect(store.getState().txs.get('wrap-tgt')?.hash).toBe(HASH)
})

test('wrapped onDropped dispatches dropped with hash', () => {
  const store = makeStore()
  store.dispatch.addWithTx(seedTx(), null)
  const onDropped = vi.fn()
  const wrapped = wrapHooks({ onDropped }, store, 'wrap-tgt')
  wrapped.onDropped!(ctx<'dropped'>({ hash: HASH }))
  expect(onDropped).toHaveBeenCalledOnce()
  expect(store.getState().txs.get('wrap-tgt')?.status).toBe('dropped')
  expect(store.getState().txs.get('wrap-tgt')?.hash).toBe(HASH)
})

test('wrapped onReplaced dispatches replaced with replacedBy + original hash', () => {
  const store = makeStore()
  store.dispatch.addWithTx(seedTx(), null)
  const onReplaced = vi.fn()
  const wrapped = wrapHooks({ onReplaced }, store, 'wrap-tgt')
  wrapped.onReplaced!(ctx<'replaced'>({ original: HASH, replacement: REPLACEMENT_HASH }))
  expect(onReplaced).toHaveBeenCalledOnce()
  const tx = store.getState().txs.get('wrap-tgt')
  expect(tx?.status).toBe('replaced')
  expect(tx?.replacedBy).toBe(REPLACEMENT_HASH)
  expect(tx?.hash).toBe(HASH)
})

test('wrapped onPhase fires user onPhase but does NOT double-write to the store', () => {
  const store = makeStore()
  store.dispatch.addWithTx(seedTx(), null)
  const listener = vi.fn()
  store.subscribe(listener)
  const onPhase = vi.fn()
  const wrapped = wrapHooks({ onPhase }, store, 'wrap-tgt')
  wrapped.onPhase!({ phase: 'awaiting-signature', ...ctx<'awaiting-signature'>({}) })
  expect(onPhase).toHaveBeenCalledOnce()
  expect(listener).not.toHaveBeenCalled()
})

// ─── undefined user callbacks ────────────────────────────────────────────

test('undefined user callbacks still update the store', () => {
  const store = makeStore()
  store.dispatch.addWithTx(seedTx(), null)
  const wrapped = wrapHooks({}, store, 'wrap-tgt')
  wrapped.onConfirmed!(ctx<'confirmed'>({ hash: HASH, receipt: FAKE_RECEIPT }))
  expect(store.getState().txs.get('wrap-tgt')?.status).toBe('confirmed')
})

// ─── user callback that throws ────────────────────────────────────────────

test('a throwing user callback is swallowed and the store still updates', () => {
  const store = makeStore()
  store.dispatch.addWithTx(seedTx(), null)
  const onError = vi.fn()
  const onConfirmed = vi.fn(() => { throw new Error('user blew up') })
  const wrapped = wrapHooks({ onConfirmed }, store, 'wrap-tgt', onError)
  wrapped.onConfirmed!(ctx<'confirmed'>({ hash: HASH, receipt: FAKE_RECEIPT }))
  expect(onError).toHaveBeenCalledOnce()
  expect(onError.mock.calls[0]?.[0]).toBe('user-hook')
  expect(store.getState().txs.get('wrap-tgt')?.status).toBe('confirmed')
})

test('a throwing user callback without onError still does not propagate', () => {
  const store = makeStore()
  store.dispatch.addWithTx(seedTx(), null)
  const wrapped = wrapHooks(
    { onConfirmed: () => { throw new Error('boom') } } as WriteHookParams,
    store,
    'wrap-tgt',
  )
  expect(() =>
    wrapped.onConfirmed!(ctx<'confirmed'>({ hash: HASH, receipt: FAKE_RECEIPT })),
  ).not.toThrow()
})

// ─── addWithWalletAdapterImpl ────────────────────────────────────────────

test('addWithWalletAdapterImpl seeds an initial preparing-status TrackedTx', () => {
  const store = makeStore()
  const { id } = addWithWalletAdapterImpl(store, {
    hooks: {},
    flow: 'send',
    chainId: 137,
    request: REQUEST,
  })
  const tx = store.getState().txs.get(id)
  expect(tx?.status).toBe('preparing')
  expect(tx?.chainId).toBe(137)
  expect(tx?.flow).toBe('send')
})

test('addWithWalletAdapterImpl returns hooks that update the seeded tx', () => {
  const store = makeStore()
  const { id, hooks } = addWithWalletAdapterImpl(store, {
    hooks: {},
    flow: 'send',
    chainId: 1,
    request: REQUEST,
  })
  hooks.onTransactionHash!(ctx<'pending'>({ hash: HASH }))
  expect(store.getState().txs.get(id)?.status).toBe('pending')
})

test('addWithWalletAdapterImpl assigns a unique id per call', () => {
  const store = makeStore()
  const a = addWithWalletAdapterImpl(store, { hooks: {}, flow: 'send', chainId: 1, request: REQUEST })
  const b = addWithWalletAdapterImpl(store, { hooks: {}, flow: 'send', chainId: 1, request: REQUEST })
  expect(a.id).not.toBe(b.id)
})
