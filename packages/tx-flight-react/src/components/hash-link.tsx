/**
 * @fileoverview `<TxFlightHashLink>` — renders a tx hash with optional
 * explorer URL. RSC-safe (no hooks, no `'use client'`).
 *
 * If `explorer` is supplied, returns an `<a>` to the URL it builds; if
 * not, returns a plain `<span>`. When `tx.hash` is undefined (preparing
 * / awaiting-signature), renders an em-dash placeholder.
 */

import type { CSSProperties, ReactNode } from 'react'

import type { TrackedTx } from '@valve-tech/wallet-adapter'

export type HashTruncate = 'middle' | 'end' | 'none'

export interface TxFlightHashLinkProps {
  tx: TrackedTx
  /**
   * URL builder. When omitted, the hash renders as plain text (no
   * anchor) — silent graceful degradation. Provider-level default
   * lives at a separate `defaultExplorer` prop (see spec §4.2).
   */
  explorer?: (tx: TrackedTx) => string
  /** Truncation style for the displayed hash. Default: 'middle'. */
  truncate?: HashTruncate
  className?: string
  style?: CSSProperties
}

const truncateHash = (hash: string, mode: HashTruncate): string => {
  if (mode === 'none') return hash
  if (mode === 'end') return `${hash.slice(0, 10)}…`
  return `${hash.slice(0, 6)}…${hash.slice(-4)}`
}

export const TxFlightHashLink = ({
  tx,
  explorer,
  truncate = 'middle',
  className,
  style,
}: TxFlightHashLinkProps): ReactNode => {
  if (tx.hash === undefined) {
    return (
      <span className={className} style={style} data-tx-hash="">
        —
      </span>
    )
  }
  const display = truncateHash(tx.hash, truncate)
  const url = explorer?.(tx)
  if (url === undefined) {
    return (
      <span className={className} style={style} data-tx-hash={tx.hash}>
        {display}
      </span>
    )
  }
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={className}
      style={style}
      data-tx-hash={tx.hash}
    >
      {display}
    </a>
  )
}
