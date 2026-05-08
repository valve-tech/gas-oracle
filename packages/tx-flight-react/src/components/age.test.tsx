import {
  test,
  expect,
  vi,
  afterEach,
} from 'vitest'
import { act, render } from '@testing-library/react'

import { TxFlightAge } from './age.js'

afterEach(() => {
  vi.useRealTimers()
})

test('renders "just now" for fresh submissions', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  const { container } = render(<TxFlightAge submittedAt={1_000_000 - 1_000} />)
  expect(container.textContent).toBe('just now')
})

test('formats seconds when delta < 60s', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  const { container } = render(<TxFlightAge submittedAt={1_000_000 - 12_000} />)
  expect(container.textContent).toBe('12s ago')
})

test('formats minutes when delta < 1h', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  const { container } = render(<TxFlightAge submittedAt={1_000_000 - 3 * 60_000} />)
  expect(container.textContent).toBe('3m ago')
})

test('formats hours when delta >= 1h', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  const { container } = render(<TxFlightAge submittedAt={1_000_000 - 4 * 3_600_000} />)
  expect(container.textContent).toBe('4h ago')
})

test('refreshes on the periodic tick', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  const { container } = render(<TxFlightAge submittedAt={1_000_000 - 1_000} />)
  expect(container.textContent).toBe('just now')
  vi.setSystemTime(1_000_000 + 12_000)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_100)
  })
  // The interval ran at least once during the advance window; the
  // exact tick count depends on timer-mock semantics, so just assert
  // a refreshed seconds value.
  expect(container.textContent).toMatch(/^1[234]s ago$/)
})

test('refreshIntervalMs controls the tick rate', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  const { container } = render(
    <TxFlightAge submittedAt={1_000_000 - 1_000} refreshIntervalMs={5_000} />,
  )
  // After 1s the tick has not fired (interval is 5s) — still "just now".
  vi.setSystemTime(1_000_000 + 1_000)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1_000)
  })
  expect(container.textContent).toBe('just now')
})

test('clears the interval on unmount', () => {
  vi.useFakeTimers()
  const { unmount } = render(<TxFlightAge submittedAt={Date.now()} />)
  unmount()
  // Subsequent timer advance should not throw or trigger React warnings.
  expect(() => vi.advanceTimersByTime(60_000)).not.toThrow()
})

test('forwards className/style to the rendered span', () => {
  vi.useFakeTimers()
  const { container } = render(
    <TxFlightAge submittedAt={Date.now()} className="age" style={{ color: 'blue' }} />,
  )
  const span = container.querySelector('span') as HTMLElement
  expect(span.className).toBe('age')
  expect(span.style.color).toBe('blue')
})

test('honors custom format prop', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  const { container } = render(
    <TxFlightAge
      submittedAt={1_000_000 - 5_000}
      format={(delta) => `${Math.round(delta / 1000)}sec`}
    />,
  )
  expect(container.textContent).toBe('5sec')
})
