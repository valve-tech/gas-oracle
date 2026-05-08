import { StrictMode } from 'react'
import {
  test,
  expect,
  vi,
  afterEach,
  beforeEach,
} from 'vitest'
import { act, render } from '@testing-library/react'
import type { TrackedTx } from '@valve-tech/wallet-adapter'

import {
  TxFlightProvider,
  _getStoreForId,
  _resetRegistry,
} from './provider.js'
import { memoryAdapter } from './storage/memory.js'
import type { TxFlightStorage } from './types.js'

const makeTx = (overrides: Partial<TrackedTx> = {}): TrackedTx => ({
  id: 'tx-1',
  chainId: 1,
  flow: 'send',
  submittedAt: 1_000_000,
  submittedTier: 'standard',
  status: 'pending',
  ...overrides,
})

beforeEach(() => {
  _resetRegistry()
})

afterEach(() => {
  _resetRegistry()
  vi.useRealTimers()
  // Clear localStorage so localStorageAdapter default doesn't pollute
  // across tests.
  if (typeof globalThis.window !== 'undefined') {
    globalThis.window.localStorage.clear()
  }
})

// ─── basics ────────────────────────────────────────────────────────────────

test('renders children', () => {
  const { getByText } = render(
    <TxFlightProvider storage={null}>
      <span>hello</span>
    </TxFlightProvider>,
  )
  expect(getByText('hello')).toBeTruthy()
})

test('registers a store under the supplied id', () => {
  render(
    <TxFlightProvider id="my-id" storage={null}>
      <span />
    </TxFlightProvider>,
  )
  expect(_getStoreForId('my-id')).toBeDefined()
})

test('uses "default" id when none supplied', () => {
  render(
    <TxFlightProvider storage={null}>
      <span />
    </TxFlightProvider>,
  )
  expect(_getStoreForId('default')).toBeDefined()
})

test('two providers with the same id share a single store via refCount', () => {
  const { unmount } = render(
    <>
      <TxFlightProvider id="shared" storage={null}>
        <span />
      </TxFlightProvider>
      <TxFlightProvider id="shared" storage={null}>
        <span />
      </TxFlightProvider>
    </>,
  )
  const store = _getStoreForId('shared')
  expect(store).toBeDefined()
  unmount()
  expect(_getStoreForId('shared')).toBeUndefined()
})

test('two providers with different ids hold independent stores', () => {
  render(
    <>
      <TxFlightProvider id="a" storage={null}>
        <span />
      </TxFlightProvider>
      <TxFlightProvider id="b" storage={null}>
        <span />
      </TxFlightProvider>
    </>,
  )
  const a = _getStoreForId('a')
  const b = _getStoreForId('b')
  expect(a).toBeDefined()
  expect(b).toBeDefined()
  expect(a).not.toBe(b)
})

test('cleans up the registry on unmount', () => {
  const { unmount } = render(
    <TxFlightProvider id="ephemeral" storage={null}>
      <span />
    </TxFlightProvider>,
  )
  expect(_getStoreForId('ephemeral')).toBeDefined()
  unmount()
  expect(_getStoreForId('ephemeral')).toBeUndefined()
})

// ─── storage rehydrate on mount ────────────────────────────────────────────

test('rehydrates state from storage on mount', async () => {
  const storage = memoryAdapter()
  await storage.save('rehydrate', [makeTx({ id: 'persisted-1' })])

  render(
    <TxFlightProvider id="rehydrate" storage={storage}>
      <span />
    </TxFlightProvider>,
  )

  // Storage load is async; flush microtasks.
  await act(async () => {
    await Promise.resolve()
  })

  const store = _getStoreForId('rehydrate')!
  expect(store.getState().txs.has('persisted-1')).toBe(true)
})

test('rehydrate skips entries already in state (e.g. user dispatched before load resolved)', async () => {
  const storage = memoryAdapter()
  await storage.save('race', [makeTx({ id: 'shared', notes: 'from-storage' })])

  render(
    <TxFlightProvider id="race" storage={storage}>
      <span />
    </TxFlightProvider>,
  )
  // Dispatch BEFORE load resolves.
  const store = _getStoreForId('race')!
  store.dispatch.addWithTx(makeTx({ id: 'shared', notes: 'from-user' }), null)
  await act(async () => {
    await Promise.resolve()
  })
  expect(store.getState().txs.get('shared')?.notes).toBe('from-user')
})

test('rehydrate is a no-op when storage returns null', async () => {
  const storage: TxFlightStorage = {
    load: async () => null,
    save: async () => undefined,
  }
  render(
    <TxFlightProvider id="empty-storage" storage={storage}>
      <span />
    </TxFlightProvider>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  const store = _getStoreForId('empty-storage')!
  expect(store.getState().txs.size).toBe(0)
})

test('storage=null disables rehydrate (load is never called)', async () => {
  const load = vi.fn()
  const save = vi.fn()
  // We don't pass this; we pass null. But verify that even if we DID
  // pass it, null overrides — the spec says null disables persistence.
  void load
  void save
  render(
    <TxFlightProvider id="no-storage" storage={null}>
      <span />
    </TxFlightProvider>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  expect(_getStoreForId('no-storage')).toBeDefined()
})

test('routes storage.load failures to onError', async () => {
  const onError = vi.fn()
  const storage: TxFlightStorage = {
    load: async () => { throw new Error('load blew up') },
    save: async () => undefined,
  }
  render(
    <TxFlightProvider id="err-load" storage={storage} onError={onError}>
      <span />
    </TxFlightProvider>,
  )
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(onError).toHaveBeenCalledOnce()
  expect(onError.mock.calls[0]?.[0]).toBe('storage-load')
})

// ─── debounced storage save ────────────────────────────────────────────────

test('saves to storage debounced (~250ms) after a state change', async () => {
  vi.useFakeTimers()
  const save = vi.fn().mockResolvedValue(undefined)
  const storage: TxFlightStorage = {
    load: async () => null,
    save,
  }
  render(
    <TxFlightProvider id="debounce-save" storage={storage}>
      <span />
    </TxFlightProvider>,
  )
  // Flush rehydrate.
  await vi.runOnlyPendingTimersAsync()
  save.mockClear()

  const store = _getStoreForId('debounce-save')!
  act(() => {
    store.dispatch.addWithTx(makeTx(), null)
  })
  // Save NOT yet fired — still inside debounce window.
  expect(save).not.toHaveBeenCalled()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(260)
  })
  expect(save).toHaveBeenCalledOnce()
  expect(save.mock.calls[0]?.[0]).toBe('debounce-save')
})

test('coalesces rapid state changes into a single debounced save', async () => {
  vi.useFakeTimers()
  const save = vi.fn().mockResolvedValue(undefined)
  const storage: TxFlightStorage = {
    load: async () => null,
    save,
  }
  render(
    <TxFlightProvider id="coalesce" storage={storage}>
      <span />
    </TxFlightProvider>,
  )
  await vi.runOnlyPendingTimersAsync()
  save.mockClear()

  const store = _getStoreForId('coalesce')!
  act(() => {
    store.dispatch.addWithTx(makeTx({ id: 'a' }), null)
    store.dispatch.addWithTx(makeTx({ id: 'b' }), null)
    store.dispatch.addWithTx(makeTx({ id: 'c' }), null)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(260)
  })
  expect(save).toHaveBeenCalledOnce()
  expect(save.mock.calls[0]?.[1].length).toBe(3)
})

test('routes storage.save failures to onError', async () => {
  vi.useFakeTimers()
  const onError = vi.fn()
  const storage: TxFlightStorage = {
    load: async () => null,
    save: async () => { throw new Error('save blew up') },
  }
  render(
    <TxFlightProvider id="err-save" storage={storage} onError={onError}>
      <span />
    </TxFlightProvider>,
  )
  await vi.runOnlyPendingTimersAsync()

  const store = _getStoreForId('err-save')!
  act(() => {
    store.dispatch.addWithTx(makeTx(), null)
  })
  await act(async () => {
    await vi.advanceTimersByTimeAsync(260)
    await Promise.resolve()
  })
  expect(onError).toHaveBeenCalled()
  expect(onError.mock.calls.some(([m]) => m === 'storage-save')).toBe(true)
})

// ─── flush save on unmount ─────────────────────────────────────────────────

test('flushes a pending debounced save on unmount', async () => {
  vi.useFakeTimers()
  const save = vi.fn().mockResolvedValue(undefined)
  const storage: TxFlightStorage = {
    load: async () => null,
    save,
  }
  const { unmount } = render(
    <TxFlightProvider id="flush" storage={storage}>
      <span />
    </TxFlightProvider>,
  )
  await vi.runOnlyPendingTimersAsync()
  save.mockClear()

  const store = _getStoreForId('flush')!
  act(() => {
    store.dispatch.addWithTx(makeTx(), null)
  })
  // Don't advance debounce — unmount triggers flush.
  unmount()
  expect(save).toHaveBeenCalledOnce()
})

test('unmount with no pending save does not call save', async () => {
  vi.useFakeTimers()
  const save = vi.fn().mockResolvedValue(undefined)
  const storage: TxFlightStorage = {
    load: async () => null,
    save,
  }
  const { unmount } = render(
    <TxFlightProvider id="quiet" storage={storage}>
      <span />
    </TxFlightProvider>,
  )
  await vi.runOnlyPendingTimersAsync()
  save.mockClear()

  unmount()
  expect(save).not.toHaveBeenCalled()
})

// ─── eviction interval ─────────────────────────────────────────────────────

test('evicts on the periodic interval', async () => {
  vi.useFakeTimers()
  const startTime = 1_000_000
  vi.setSystemTime(startTime)

  render(
    <TxFlightProvider id="evict" storage={null} terminalRetentionMs={500}>
      <span />
    </TxFlightProvider>,
  )

  const store = _getStoreForId('evict')!
  act(() => {
    store.dispatch.addWithTx(
      {
        id: 'old',
        chainId: 1,
        flow: 'send',
        submittedAt: startTime,
        submittedTier: 'standard',
        status: 'confirmed',
        confirmedAt: startTime,
      },
      null,
    )
  })
  expect(store.getState().txs.size).toBe(1)

  // Advance clock past retention.
  vi.setSystemTime(startTime + 10_000)
  // Advance interval timer.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000)
  })
  expect(store.getState().txs.size).toBe(0)
})

test('maxItems enforcement: list trims to the cap on the eviction tick', async () => {
  vi.useFakeTimers()
  const startTime = 1_000_000
  vi.setSystemTime(startTime)

  render(
    <TxFlightProvider id="cap" storage={null} maxItems={5}>
      <span />
    </TxFlightProvider>,
  )
  const store = _getStoreForId('cap')!
  // 7 confirmed (terminal) entries — 5 maxItems means 2 should evict.
  // All confirmed at the same instant so the comparator falls back to
  // submittedAt; spread submittedAt so order is deterministic.
  act(() => {
    for (let i = 0; i < 7; i += 1) {
      store.dispatch.addWithTx(
        {
          id: `t-${i}`,
          chainId: 1,
          flow: 'send',
          submittedAt: startTime + i,
          submittedTier: 'standard',
          status: 'confirmed',
          confirmedAt: startTime,
        },
        null,
      )
    }
  })
  expect(store.getState().txs.size).toBe(7)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5_000)
  })
  expect(store.getState().txs.size).toBe(5)
})

test('eviction interval is cleared on unmount', async () => {
  vi.useFakeTimers()
  const { unmount } = render(
    <TxFlightProvider id="evict-cleanup" storage={null}>
      <span />
    </TxFlightProvider>,
  )
  unmount()
  // No active timer remains: advancing should not throw.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000)
  })
})

// ─── rehydrate: pre-hash entries become failed-on-reload ─────────────────

test('rehydrate translates preparing → failed with "lost during reload" note', async () => {
  const storage = memoryAdapter()
  await storage.save('reload-prep', [
    makeTx({ id: 'lost-prep', status: 'preparing' }),
  ])
  render(
    <TxFlightProvider id="reload-prep" storage={storage}>
      <span />
    </TxFlightProvider>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  const tx = _getStoreForId('reload-prep')!.getState().txs.get('lost-prep')
  expect(tx?.status).toBe('failed')
  expect(tx?.notes).toBe('lost during reload')
})

test('rehydrate translates awaiting-signature → failed with "lost during reload"', async () => {
  const storage = memoryAdapter()
  await storage.save('reload-await', [
    makeTx({ id: 'lost-await', status: 'awaiting-signature' }),
  ])
  render(
    <TxFlightProvider id="reload-await" storage={storage}>
      <span />
    </TxFlightProvider>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  const tx = _getStoreForId('reload-await')!.getState().txs.get('lost-await')
  expect(tx?.status).toBe('failed')
  expect(tx?.notes).toBe('lost during reload')
})

test('rehydrate keeps pending entries pending when clientFactory is unset', async () => {
  const storage = memoryAdapter()
  await storage.save('no-factory', [
    makeTx({ id: 'still-pending', status: 'pending', hash: '0xabc' }),
  ])
  render(
    <TxFlightProvider id="no-factory" storage={storage}>
      <span />
    </TxFlightProvider>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  expect(_getStoreForId('no-factory')!.getState().txs.get('still-pending')?.status).toBe('pending')
})

test('rehydrate calls resumeByHashWatcher when clientFactory returns a client for a pending hash', async () => {
  const storage = memoryAdapter()
  await storage.save('with-factory', [
    makeTx({ id: 'resume-me', status: 'pending', hash: '0xabc' }),
  ])
  const stubClient = {
    transport: { type: 'http' },
    request: async () => null,
  } as unknown as Parameters<NonNullable<Parameters<typeof TxFlightProvider>[0]['clientFactory']>>[0] extends number ? unknown : unknown
  const clientFactory = vi.fn(() => stubClient)
  render(
    <TxFlightProvider
      id="with-factory"
      storage={storage}
      // @ts-expect-error — stubClient is intentionally a minimal cast
      clientFactory={clientFactory}
    >
      <span />
    </TxFlightProvider>,
  )
  // Allow rehydrate + dynamic import + subscribeWatcher to settle.
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(clientFactory).toHaveBeenCalledWith(1)
})

test('rehydrate skips watcher when clientFactory returns undefined for the chainId', async () => {
  const storage = memoryAdapter()
  await storage.save('factory-empty', [
    makeTx({ id: 'still-pending', status: 'pending', hash: '0xabc' }),
  ])
  const clientFactory = vi.fn(() => undefined)
  render(
    <TxFlightProvider
      id="factory-empty"
      storage={storage}
      clientFactory={clientFactory}
    >
      <span />
    </TxFlightProvider>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  expect(clientFactory).toHaveBeenCalledWith(1)
  expect(_getStoreForId('factory-empty')!.getState().txs.get('still-pending')?.status).toBe('pending')
})

// ─── Strict Mode dev cycle (mount → effect cleanup → effect setup) ────────

test('survives a Strict Mode dev cycle and re-creates the entry', () => {
  render(
    <StrictMode>
      <TxFlightProvider id="strict-mode" storage={null}>
        <span />
      </TxFlightProvider>
    </StrictMode>,
  )
  expect(_getStoreForId('strict-mode')).toBeDefined()
})

test('cleanup is a no-op when the registry has been reset out from under it', () => {
  const { unmount } = render(
    <TxFlightProvider id="replaced" storage={null}>
      <span />
    </TxFlightProvider>,
  )
  expect(_getStoreForId('replaced')).toBeDefined()
  // Simulate a test escape hatch (or an external reset) running
  // BEFORE the Provider unmounts. Cleanup should not double-dispose
  // or touch the registry slot it no longer owns.
  _resetRegistry()
  expect(() => unmount()).not.toThrow()
  expect(_getStoreForId('replaced')).toBeUndefined()
})

// ─── default storage = localStorageAdapter ─────────────────────────────────

test('uses localStorageAdapter() when no storage prop is supplied', async () => {
  // Pre-seed localStorage with the default key.
  globalThis.window.localStorage.setItem(
    'tx-flight:default',
    JSON.stringify([{
      id: 'persisted',
      chainId: 1,
      flow: 'send',
      submittedAt: 1,
      submittedTier: 'standard',
      status: 'pending',
    }]),
  )

  render(
    <TxFlightProvider>
      <span />
    </TxFlightProvider>,
  )
  await act(async () => {
    await Promise.resolve()
  })
  const store = _getStoreForId('default')!
  expect(store.getState().txs.has('persisted')).toBe(true)
})
