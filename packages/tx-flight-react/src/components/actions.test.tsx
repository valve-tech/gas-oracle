import { test, expect, vi } from 'vitest'
import { fireEvent, render } from '@testing-library/react'
import type { TrackedTx } from '@valve-tech/wallet-adapter'

import { TxFlightActions } from './actions.js'

const makeTx = (overrides: Partial<TrackedTx> = {}): TrackedTx => ({
  id: 't1',
  chainId: 1,
  flow: 'send',
  submittedAt: 1,
  submittedTier: 'standard',
  status: 'pending',
  ...overrides,
})

test('renders nothing when no callbacks are wired', () => {
  const { container } = render(<TxFlightActions tx={makeTx()} />)
  expect(container.firstChild).toBeNull()
})

test('renders only the buttons whose callbacks are wired', () => {
  const onSpeedUp = vi.fn()
  const { container } = render(
    <TxFlightActions tx={makeTx()} onSpeedUp={onSpeedUp} />,
  )
  expect(container.querySelectorAll('button').length).toBe(1)
  expect(
    container.querySelector('[data-action="speed-up"]'),
  ).toBeTruthy()
})

test('show.speedUp=false hides the button even when onSpeedUp is wired', () => {
  const { container } = render(
    <TxFlightActions
      tx={makeTx()}
      onSpeedUp={() => undefined}
      onCancel={() => undefined}
      show={{ speedUp: false }}
    />,
  )
  expect(container.querySelector('[data-action="speed-up"]')).toBeNull()
  expect(container.querySelector('[data-action="cancel"]')).toBeTruthy()
})

test('show.cancel=false hides cancel', () => {
  const { container } = render(
    <TxFlightActions
      tx={makeTx()}
      onCancel={() => undefined}
      show={{ cancel: false }}
    />,
  )
  expect(container.firstChild).toBeNull()
})

test('show.dismiss=false hides dismiss', () => {
  const { container } = render(
    <TxFlightActions
      tx={makeTx()}
      onDismiss={() => undefined}
      show={{ dismiss: false }}
    />,
  )
  expect(container.firstChild).toBeNull()
})

test('forwards tx to each callback on click', () => {
  const tx = makeTx({ id: 'click-target' })
  const onSpeedUp = vi.fn()
  const onCancel = vi.fn()
  const onDismiss = vi.fn()
  const { container } = render(
    <TxFlightActions
      tx={tx}
      onSpeedUp={onSpeedUp}
      onCancel={onCancel}
      onDismiss={onDismiss}
    />,
  )
  fireEvent.click(container.querySelector('[data-action="speed-up"]')!)
  fireEvent.click(container.querySelector('[data-action="cancel"]')!)
  fireEvent.click(container.querySelector('[data-action="dismiss"]')!)
  expect(onSpeedUp).toHaveBeenCalledWith(tx)
  expect(onCancel).toHaveBeenCalledWith(tx)
  expect(onDismiss).toHaveBeenCalledWith(tx)
})

test('forwards className/style/data-tx-id', () => {
  const { container } = render(
    <TxFlightActions
      tx={makeTx({ id: 'data-id' })}
      onSpeedUp={() => undefined}
      className="acts"
      style={{ display: 'flex' }}
    />,
  )
  const div = container.querySelector('div') as HTMLElement
  expect(div.className).toBe('acts')
  expect(div.style.display).toBe('flex')
  expect(div.getAttribute('data-tx-id')).toBe('data-id')
})
