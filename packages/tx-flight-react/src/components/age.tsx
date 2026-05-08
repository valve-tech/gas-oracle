'use client'

/**
 * @fileoverview `<TxFlightAge>` — relative-time display that
 * auto-refreshes on a periodic tick.
 *
 * Client-only because of the `useEffect` interval. The default format
 * yields English copy: 'just now', '12s ago', '3m ago', '4h ago'.
 * Consumer-supplied `format` swaps in any locale / wording.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'

const defaultFormat = (deltaMs: number): string => {
  if (deltaMs < 5_000) return 'just now'
  if (deltaMs < 60_000) return `${Math.floor(deltaMs / 1000)}s ago`
  if (deltaMs < 3_600_000) return `${Math.floor(deltaMs / 60_000)}m ago`
  return `${Math.floor(deltaMs / 3_600_000)}h ago`
}

export interface TxFlightAgeProps {
  /** Submission time (ms since epoch). */
  submittedAt: number
  /** How often to re-render. Default: 1000ms. */
  refreshIntervalMs?: number
  /** Custom relative-time formatter. Default: English. */
  format?: (deltaMs: number) => string
  className?: string
  style?: CSSProperties
}

export const TxFlightAge = ({
  submittedAt,
  refreshIntervalMs = 1000,
  format = defaultFormat,
  className,
  style,
}: TxFlightAgeProps): ReactNode => {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), refreshIntervalMs)
    return () => clearInterval(t)
  }, [refreshIntervalMs])
  return (
    <span className={className} style={style}>
      {format(now - submittedAt)}
    </span>
  )
}
