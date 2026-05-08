import {
  test,
  expect,
  vi,
  afterEach,
  beforeEach,
} from 'vitest'
import { act, renderHook } from '@testing-library/react'
import type { TrackedTx } from '@valve-tech/wallet-adapter'

import { TxFlightProvider, _resetRegistry } from './provider.js'
import { useTxFlight } from './use-tx-flight.js'

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
  if (typeof globalThis.window !== 'undefined') {
    globalThis.window.localStorage.clear()
  }
})

const wrapper = (id?: string) => ({ children }: { children: React.ReactNode }) => (
  <TxFlightProvider id={id} storage={null}>
    {children}
  </TxFlightProvider>
)

// ─── error path ────────────────────────────────────────────────────────────

test('throws if called outside any provider', () => {
  // Suppress the React error-boundary log from the throw inside renderHook.
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  expect(() => renderHook(() => useTxFlight())).toThrow(
    /No <TxFlightProvider id="default"> found in tree/,
  )
  spy.mockRestore()
})

test('throws if explicit id has no matching provider', () => {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
  expect(() =>
    renderHook(() => useTxFlight('missing'), { wrapper: wrapper('default') }),
  ).toThrow(/No <TxFlightProvider id="missing"> found in tree/)
  spy.mockRestore()
})

// ─── basic reads ───────────────────────────────────────────────────────────

test('returns an empty txs array initially', () => {
  const { result } = renderHook(() => useTxFlight(), { wrapper: wrapper() })
  expect(result.current.txs).toEqual([])
})

test('reads ambient context id when no argument supplied', () => {
  const { result } = renderHook(() => useTxFlight(), {
    wrapper: wrapper('ambient-id'),
  })
  expect(result.current.txs).toEqual([])
})

test('explicit id arg overrides ambient context', () => {
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <TxFlightProvider id="outer" storage={null}>
      <TxFlightProvider id="inner" storage={null}>
        {children}
      </TxFlightProvider>
    </TxFlightProvider>
  )
  const { result } = renderHook(() => useTxFlight('outer'), { wrapper: Wrapper })
  expect(result.current.txs).toEqual([])
})

// ─── addManual ─────────────────────────────────────────────────────────────

test('addManual lands the tx in state and returns the id', () => {
  const { result } = renderHook(() => useTxFlight(), { wrapper: wrapper() })

  let id = ''
  act(() => {
    id = result.current.addManual({ tx: makeTx({ id: 'manual-1' }) })
  })
  expect(id).toBe('manual-1')
  expect(result.current.txs.length).toBe(1)
  expect(result.current.txs[0]?.id).toBe('manual-1')
})

test('addManual overwrites an existing entry under the same id', () => {
  const { result } = renderHook(() => useTxFlight(), { wrapper: wrapper() })
  act(() => {
    result.current.addManual({ tx: makeTx({ status: 'pending' }) })
  })
  act(() => {
    result.current.addManual({ tx: makeTx({ status: 'confirmed', notes: 'done' }) })
  })
  expect(result.current.txs.length).toBe(1)
  expect(result.current.txs[0]?.status).toBe('confirmed')
  expect(result.current.txs[0]?.notes).toBe('done')
})

// ─── remove / clear ────────────────────────────────────────────────────────

test('remove drops a tx', () => {
  const { result } = renderHook(() => useTxFlight(), { wrapper: wrapper() })
  act(() => {
    result.current.addManual({ tx: makeTx({ id: 'a' }) })
    result.current.addManual({ tx: makeTx({ id: 'b' }) })
  })
  act(() => {
    result.current.remove('a')
  })
  expect(result.current.txs.length).toBe(1)
  expect(result.current.txs[0]?.id).toBe('b')
})

test('clear empties the strip', () => {
  const { result } = renderHook(() => useTxFlight(), { wrapper: wrapper() })
  act(() => {
    result.current.addManual({ tx: makeTx({ id: 'a' }) })
    result.current.addManual({ tx: makeTx({ id: 'b' }) })
  })
  act(() => {
    result.current.clear()
  })
  expect(result.current.txs).toEqual([])
})

// ─── get ───────────────────────────────────────────────────────────────────

test('get returns the tx by id', () => {
  const { result } = renderHook(() => useTxFlight(), { wrapper: wrapper() })
  act(() => {
    result.current.addManual({ tx: makeTx({ id: 'find-me', notes: 'hi' }) })
  })
  expect(result.current.get('find-me')?.notes).toBe('hi')
})

test('get returns null for an unknown id', () => {
  const { result } = renderHook(() => useTxFlight(), { wrapper: wrapper() })
  expect(result.current.get('nope')).toBeNull()
})

// ─── reactivity ────────────────────────────────────────────────────────────

test('re-renders when state changes', () => {
  const { result } = renderHook(() => useTxFlight(), { wrapper: wrapper() })
  expect(result.current.txs.length).toBe(0)
  act(() => {
    result.current.addManual({ tx: makeTx() })
  })
  expect(result.current.txs.length).toBe(1)
})

// ─── addByHash ────────────────────────────────────────────────────────────

test('addByHash dynamic-imports tx-tracker and seeds a pending TrackedTx', async () => {
  const { result } = renderHook(() => useTxFlight(), { wrapper: wrapper() })
  let id = ''
  await act(async () => {
    id = await result.current.addByHash({
      hash: '0xabc',
      chainId: 1,
      // Stub PublicClient — addByHash builds an internal source from
      // it; teardown via remove() doesn't drive any real RPC traffic.
      client: { transport: { type: 'http' }, request: async () => null } as unknown as Parameters<
        typeof result.current.addByHash
      >[0]['client'],
    })
  })
  expect(result.current.get(id)?.status).toBe('pending')
  expect(result.current.get(id)?.hash).toBe('0xabc')
})

// ─── addWithWalletAdapter ─────────────────────────────────────────────────

test('addWithWalletAdapter seeds a preparing-status tx and returns wrapped hooks', () => {
  const { result } = renderHook(() => useTxFlight(), { wrapper: wrapper() })
  let id = ''
  let hooks: ReturnType<typeof result.current.addWithWalletAdapter>['hooks']
    | undefined
  act(() => {
    const out = result.current.addWithWalletAdapter({
      hooks: {},
      flow: 'send',
      chainId: 1,
      request: { to: '0x0000000000000000000000000000000000000000' },
    })
    id = out.id
    hooks = out.hooks
  })
  expect(result.current.get(id)?.status).toBe('preparing')
  expect(hooks?.onConfirmed).toBeDefined()
})

test('multi-instance scoping: two ids are independent', () => {
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <TxFlightProvider id="a" storage={null}>
      <TxFlightProvider id="b" storage={null}>
        {children}
      </TxFlightProvider>
    </TxFlightProvider>
  )
  const { result: ra } = renderHook(() => useTxFlight('a'), { wrapper: Wrapper })
  const { result: rb } = renderHook(() => useTxFlight('b'), { wrapper: Wrapper })
  act(() => {
    ra.current.addManual({ tx: makeTx({ id: 'in-a' }) })
  })
  expect(ra.current.txs.length).toBe(1)
  expect(rb.current.txs.length).toBe(0)
})
