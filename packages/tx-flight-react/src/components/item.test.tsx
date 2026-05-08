import { test, expect, vi, afterEach } from 'vitest'
import { render } from '@testing-library/react'
import type { TrackedTx } from '@valve-tech/wallet-adapter'

import { TxFlightItem } from './item.js'

const makeTx = (overrides: Partial<TrackedTx> = {}): TrackedTx => ({
  id: 'item-1',
  chainId: 1,
  flow: 'send',
  submittedAt: 1_000_000,
  submittedTier: 'standard',
  status: 'pending',
  hash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
  ...overrides,
})

afterEach(() => {
  vi.useRealTimers()
})

test('default layout renders icon + hash + age + actions container', () => {
  vi.useFakeTimers()
  vi.setSystemTime(1_000_000)
  const { container } = render(<TxFlightItem tx={makeTx({ submittedAt: 1_000_000 })} />)
  // Icon: span with role=img
  expect(container.querySelector('[role="img"]')).toBeTruthy()
  // Hash text
  expect(container.textContent).toContain('0x1234')
  // Age line: "just now" for the freshly submitted tx.
  expect(container.textContent?.toLowerCase()).toContain('now')
})

test('forwards className, style, data-tx-id, data-status to outer wrapper', () => {
  vi.useFakeTimers()
  const { container } = render(
    <TxFlightItem
      tx={makeTx({ id: 'wrap-id', status: 'confirmed' })}
      className="ti"
      style={{ padding: '4px' }}
    />,
  )
  const div = container.firstChild as HTMLElement
  expect(div.className).toBe('ti')
  expect(div.style.padding).toBe('4px')
  expect(div.getAttribute('data-tx-id')).toBe('wrap-id')
  expect(div.getAttribute('data-status')).toBe('confirmed')
})

test('render prop receives the four atomic primitives', () => {
  vi.useFakeTimers()
  const seen: string[] = []
  render(
    <TxFlightItem
      tx={makeTx()}
      render={(parts) => {
        for (const key of Object.keys(parts) as (keyof typeof parts)[]) {
          if (parts[key] !== undefined) seen.push(key)
        }
        return <div data-testid="custom">custom layout</div>
      }}
    />,
  )
  expect(seen).toEqual(['icon', 'hash', 'age', 'actions'])
})

test('render prop output replaces the default layout', () => {
  vi.useFakeTimers()
  const { container } = render(
    <TxFlightItem
      tx={makeTx()}
      render={() => <span data-testid="just-this">only this</span>}
    />,
  )
  expect(container.querySelector('[data-testid="just-this"]')).toBeTruthy()
  // Default children should NOT be in the rendered output.
  expect(container.querySelector('[role="img"]')).toBeNull()
})
