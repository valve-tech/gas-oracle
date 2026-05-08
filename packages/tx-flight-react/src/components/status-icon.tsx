/**
 * @fileoverview `<TxFlightStatusIcon>` — single-glyph indicator for a
 * tracked tx's status. RSC-safe (no hooks, no `'use client'`).
 *
 * Visual: a colored dot, sized via the `size` prop. Consumer styles
 * any further treatment via `className` / `style`. Defaults provide
 * a sensible, opinionated look so the bare component looks intentional
 * out of the box without consumer CSS.
 */

import type { CSSProperties, ReactNode } from 'react'

import type { TrackedTxStatus } from '@valve-tech/wallet-adapter'

const STATUS_LABEL: Record<TrackedTxStatus, string> = {
  preparing: 'Preparing',
  'awaiting-signature': 'Awaiting signature',
  pending: 'Pending',
  confirmed: 'Confirmed',
  failed: 'Failed',
  replaced: 'Replaced',
  dropped: 'Dropped',
}

const STATUS_COLOR: Record<TrackedTxStatus, string> = {
  preparing: '#9ca3af',
  'awaiting-signature': '#3b82f6',
  pending: '#f59e0b',
  confirmed: '#10b981',
  failed: '#ef4444',
  replaced: '#a855f7',
  dropped: '#6b7280',
}

export interface TxFlightStatusIconProps {
  status: TrackedTxStatus
  /** Pixel size of the dot. Default: 16. */
  size?: number
  className?: string
  style?: CSSProperties
}

export const TxFlightStatusIcon = ({
  status,
  size = 16,
  className,
  style,
}: TxFlightStatusIconProps): ReactNode => (
  <span
    role="img"
    aria-label={STATUS_LABEL[status]}
    data-status={status}
    className={className}
    style={{
      display: 'inline-block',
      width: size,
      height: size,
      borderRadius: '50%',
      backgroundColor: STATUS_COLOR[status],
      ...style,
    }}
  />
)
