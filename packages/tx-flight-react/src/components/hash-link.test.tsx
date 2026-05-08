import { test, expect } from 'vitest'
import { render } from '@testing-library/react'
import type { TrackedTx } from '@valve-tech/wallet-adapter'

import { TxFlightHashLink } from './hash-link.js'

const HASH = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'

const makeTx = (overrides: Partial<TrackedTx> = {}): TrackedTx => ({
  id: 't1',
  chainId: 1,
  flow: 'send',
  submittedAt: 1,
  submittedTier: 'standard',
  status: 'pending',
  hash: HASH,
  ...overrides,
})

test('renders an em-dash placeholder when tx.hash is undefined', () => {
  const { container } = render(<TxFlightHashLink tx={makeTx({ hash: undefined })} />)
  expect(container.textContent).toBe('—')
  expect(container.querySelector('a')).toBeNull()
})

test('renders a plain span (no anchor) when no explorer is supplied', () => {
  const { container } = render(<TxFlightHashLink tx={makeTx()} />)
  expect(container.querySelector('a')).toBeNull()
  const span = container.querySelector('span') as HTMLElement
  expect(span).toBeTruthy()
  expect(span.getAttribute('data-tx-hash')).toBe(HASH)
})

test('renders an anchor with target=_blank when explorer returns a URL', () => {
  const { container } = render(
    <TxFlightHashLink
      tx={makeTx()}
      explorer={(t) => `https://example.com/tx/${t.hash}`}
    />,
  )
  const a = container.querySelector('a') as HTMLAnchorElement
  expect(a).toBeTruthy()
  expect(a.getAttribute('href')).toBe(`https://example.com/tx/${HASH}`)
  expect(a.getAttribute('target')).toBe('_blank')
  expect(a.getAttribute('rel')).toBe('noopener noreferrer')
})

test('truncate=middle is the default; renders 0x1234…cdef-style', () => {
  const { container } = render(<TxFlightHashLink tx={makeTx()} />)
  expect(container.textContent).toBe('0x1234…cdef')
})

test('truncate=end renders the leading 10 chars + ellipsis', () => {
  const { container } = render(<TxFlightHashLink tx={makeTx()} truncate="end" />)
  expect(container.textContent).toBe('0x12345678…')
})

test('truncate=none renders the full hash', () => {
  const { container } = render(<TxFlightHashLink tx={makeTx()} truncate="none" />)
  expect(container.textContent).toBe(HASH)
})

test('forwards className and style on both span and anchor branches', () => {
  const { container: c1 } = render(
    <TxFlightHashLink tx={makeTx()} className="hl" style={{ color: 'red' }} />,
  )
  const span = c1.querySelector('span') as HTMLElement
  expect(span.className).toBe('hl')
  expect(span.style.color).toBe('red')

  const { container: c2 } = render(
    <TxFlightHashLink
      tx={makeTx()}
      explorer={() => 'https://x'}
      className="hl"
      style={{ color: 'red' }}
    />,
  )
  const a = c2.querySelector('a') as HTMLElement
  expect(a.className).toBe('hl')
  expect(a.style.color).toBe('red')
})
