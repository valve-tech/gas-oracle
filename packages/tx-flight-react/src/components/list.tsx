'use client'

/**
 * @fileoverview `<TxFlightList>` — reactive list of tracked txs.
 * Reads the strip's state via `useTxFlight(id)` (so client-only).
 *
 * Defaults to newest-first by `submittedAt`, no filter, default
 * per-tx layout via `<TxFlightItem>`. Every prop is opt-in
 * customization; bare `<TxFlightList />` is enough for a working
 * strip in the ambient Provider.
 */

import type { CSSProperties, ReactNode } from 'react'

import type { TrackedTx } from '@valve-tech/wallet-adapter'

import { useTxFlight } from '../use-tx-flight.js'
import { TxFlightItem } from './item.js'

export interface TxFlightListProps {
  /** Provider id to read from. Defaults to the ambient context's id. */
  id?: string
  /** Filter predicate. Default: include all. */
  filter?: (tx: TrackedTx) => boolean
  /** Sort comparator. Default: newest-first by `submittedAt`. */
  sort?: (a: TrackedTx, b: TrackedTx) => number
  /** Per-tx renderer. Default: `<TxFlightItem tx={tx} />`. */
  render?: (tx: TrackedTx) => ReactNode
  /** Shown when the visible set is empty. */
  empty?: ReactNode
  className?: string
  style?: CSSProperties
}

const defaultSort = (a: TrackedTx, b: TrackedTx): number =>
  b.submittedAt - a.submittedAt

const defaultRender = (tx: TrackedTx): ReactNode => (
  <TxFlightItem key={tx.id} tx={tx} />
)

export const TxFlightList = ({
  id,
  filter,
  sort = defaultSort,
  render = defaultRender,
  empty,
  className,
  style,
}: TxFlightListProps): ReactNode => {
  const { txs } = useTxFlight(id)
  const visible = (filter ? txs.filter(filter) : [...txs]).sort(sort)
  if (visible.length === 0) return empty !== undefined ? <>{empty}</> : null
  return (
    <div className={className} style={style} data-tx-flight-list="">
      {visible.map(render)}
    </div>
  )
}
