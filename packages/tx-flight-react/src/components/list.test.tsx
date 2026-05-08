import {
  test,
  expect,
  vi,
  afterEach,
  beforeEach,
} from 'vitest'
import { act, render, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import type { TrackedTx } from '@valve-tech/wallet-adapter'

import { TxFlightProvider, _resetRegistry } from '../provider.js'
import { useTxFlight } from '../use-tx-flight.js'
import { TxFlightList } from './list.js'

const makeTx = (overrides: Partial<TrackedTx> = {}): TrackedTx => ({
  id: 'list-1',
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
})

const wrapper = ({ children }: { children: ReactNode }) => (
  <TxFlightProvider storage={null}>{children}</TxFlightProvider>
)

test('renders nothing when the strip is empty and no `empty` is supplied', () => {
  const { container } = render(<TxFlightList />, { wrapper })
  expect(container.firstChild).toBeNull()
})

test('renders the empty placeholder when supplied and the list is empty', () => {
  const { container } = render(
    <TxFlightList empty={<span>no txs</span>} />,
    { wrapper },
  )
  expect(container.textContent).toBe('no txs')
})

test('renders the default item layout for each tx', async () => {
  vi.useFakeTimers()
  const { result } = renderHook(() => useTxFlight(), { wrapper })
  act(() => {
    result.current.addManual({ tx: makeTx({ id: 'a' }) })
    result.current.addManual({ tx: makeTx({ id: 'b' }) })
  })
  const { container } = render(<TxFlightList />, { wrapper })
  expect(container.querySelectorAll('[data-tx-id]').length).toBeGreaterThanOrEqual(2)
})

test('default sort is newest-first by submittedAt', async () => {
  vi.useFakeTimers()
  const { result } = renderHook(() => useTxFlight(), { wrapper })
  act(() => {
    result.current.addManual({ tx: makeTx({ id: 'older', submittedAt: 1 }) })
    result.current.addManual({ tx: makeTx({ id: 'newer', submittedAt: 2 }) })
  })
  const { container } = render(<TxFlightList />, { wrapper })
  const ids = Array.from(
    container.querySelectorAll('[data-tx-id]'),
  ).map((el) => el.getAttribute('data-tx-id'))
  expect(ids[0]).toBe('newer')
})

test('honors custom sort comparator', async () => {
  vi.useFakeTimers()
  const { result } = renderHook(() => useTxFlight(), { wrapper })
  act(() => {
    result.current.addManual({ tx: makeTx({ id: 'older', submittedAt: 1 }) })
    result.current.addManual({ tx: makeTx({ id: 'newer', submittedAt: 2 }) })
  })
  const { container } = render(
    <TxFlightList sort={(a, b) => a.submittedAt - b.submittedAt} />,
    { wrapper },
  )
  const ids = Array.from(
    container.querySelectorAll('[data-tx-id]'),
  ).map((el) => el.getAttribute('data-tx-id'))
  expect(ids[0]).toBe('older')
})

test('honors filter predicate', async () => {
  vi.useFakeTimers()
  const { result } = renderHook(() => useTxFlight(), { wrapper })
  act(() => {
    result.current.addManual({ tx: makeTx({ id: 'pending-1', status: 'pending' }) })
    result.current.addManual({ tx: makeTx({ id: 'confirmed-1', status: 'confirmed' }) })
  })
  const { container } = render(
    <TxFlightList filter={(t) => t.status === 'pending'} />,
    { wrapper },
  )
  const ids = Array.from(
    container.querySelectorAll('[data-tx-id]'),
  ).map((el) => el.getAttribute('data-tx-id'))
  expect(ids).toEqual(['pending-1'])
})

test('honors custom render function', async () => {
  vi.useFakeTimers()
  const { result } = renderHook(() => useTxFlight(), { wrapper })
  act(() => {
    result.current.addManual({ tx: makeTx({ id: 'one' }) })
  })
  const { container } = render(
    <TxFlightList render={(tx) => <span key={tx.id} data-custom-id={tx.id} />} />,
    { wrapper },
  )
  expect(container.querySelector('[data-custom-id="one"]')).toBeTruthy()
})

test('reads from a specific id when supplied', async () => {
  vi.useFakeTimers()
  const Wrapper = ({ children }: { children: ReactNode }) => (
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
    rb.current.addManual({ tx: makeTx({ id: 'in-b' }) })
  })
  const { container } = render(<TxFlightList id="a" />, { wrapper: Wrapper })
  const ids = Array.from(container.querySelectorAll('[data-tx-id]'))
    .map((el) => el.getAttribute('data-tx-id'))
  expect(ids).toEqual(['in-a'])
})

test('forwards className/style on the wrapper div', async () => {
  vi.useFakeTimers()
  const { result } = renderHook(() => useTxFlight(), { wrapper })
  act(() => {
    result.current.addManual({ tx: makeTx() })
  })
  const { container } = render(
    <TxFlightList className="lst" style={{ gap: '4px' }} />,
    { wrapper },
  )
  const wrapEl = container.querySelector('[data-tx-flight-list]') as HTMLElement
  expect(wrapEl.className).toBe('lst')
  expect(wrapEl.style.gap).toBe('4px')
})
