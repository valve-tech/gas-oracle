import { test, expect } from 'vitest'
import { render } from '@testing-library/react'

import { TxFlightStatusIcon } from './status-icon.js'

test('renders a span with the status as data attribute', () => {
  const { container } = render(<TxFlightStatusIcon status="pending" />)
  const el = container.querySelector('[data-status="pending"]')
  expect(el).toBeTruthy()
  expect(el?.tagName).toBe('SPAN')
})

test('uses the human-readable label as aria-label', () => {
  const { getByRole } = render(<TxFlightStatusIcon status="awaiting-signature" />)
  expect(getByRole('img').getAttribute('aria-label')).toBe('Awaiting signature')
})

test('honors size prop in inline width/height', () => {
  const { container } = render(<TxFlightStatusIcon status="confirmed" size={24} />)
  const el = container.querySelector('span') as HTMLElement
  expect(el.style.width).toBe('24px')
  expect(el.style.height).toBe('24px')
})

test('default size is 16px', () => {
  const { container } = render(<TxFlightStatusIcon status="pending" />)
  const el = container.querySelector('span') as HTMLElement
  expect(el.style.width).toBe('16px')
})

test('forwards className', () => {
  const { container } = render(
    <TxFlightStatusIcon status="failed" className="my-icon" />,
  )
  expect(container.querySelector('span')?.className).toBe('my-icon')
})

test('consumer style overrides default backgroundColor', () => {
  const { container } = render(
    <TxFlightStatusIcon status="failed" style={{ backgroundColor: 'magenta' }} />,
  )
  const el = container.querySelector('span') as HTMLElement
  expect(el.style.backgroundColor).toBe('magenta')
})

test('renders distinct colors for every status', () => {
  const statuses: ReadonlyArray<Parameters<typeof TxFlightStatusIcon>[0]['status']> = [
    'preparing',
    'awaiting-signature',
    'pending',
    'confirmed',
    'failed',
    'replaced',
    'dropped',
  ]
  const colors = new Set<string>()
  for (const status of statuses) {
    const { container, unmount } = render(<TxFlightStatusIcon status={status} />)
    const el = container.querySelector('span') as HTMLElement
    colors.add(el.style.backgroundColor)
    unmount()
  }
  expect(colors.size).toBe(statuses.length)
})
