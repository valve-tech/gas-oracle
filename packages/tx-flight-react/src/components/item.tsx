/**
 * @fileoverview `<TxFlightItem>` — default per-tx layout. Composes the
 * atomic primitives (StatusIcon, HashLink, Age, Actions). The `render`
 * prop replaces the default layout entirely while still receiving the
 * pre-built atomic ReactNodes; consumers can rearrange or wrap them.
 */

import type { CSSProperties, ReactNode } from 'react'

import type { TrackedTx } from '@valve-tech/wallet-adapter'

import { TxFlightActions } from './actions.js'
import { TxFlightAge } from './age.js'
import { TxFlightHashLink } from './hash-link.js'
import { TxFlightStatusIcon } from './status-icon.js'

export interface TxFlightItemRenderParts {
  icon: ReactNode
  hash: ReactNode
  age: ReactNode
  actions: ReactNode
}

export interface TxFlightItemProps {
  tx: TrackedTx
  /**
   * Replace the default layout. Receives the four atomic primitives
   * pre-built — the consumer rearranges them or wraps them in their
   * own markup.
   */
  render?: (parts: TxFlightItemRenderParts) => ReactNode
  className?: string
  style?: CSSProperties
}

export const TxFlightItem = ({
  tx,
  render,
  className,
  style,
}: TxFlightItemProps): ReactNode => {
  const parts: TxFlightItemRenderParts = {
    icon: <TxFlightStatusIcon status={tx.status} />,
    hash: <TxFlightHashLink tx={tx} />,
    age: <TxFlightAge submittedAt={tx.submittedAt} />,
    actions: <TxFlightActions tx={tx} />,
  }
  if (render) {
    return (
      <div className={className} style={style} data-tx-id={tx.id} data-status={tx.status}>
        {render(parts)}
      </div>
    )
  }
  return (
    <div className={className} style={style} data-tx-id={tx.id} data-status={tx.status}>
      {parts.icon}
      {parts.hash}
      {parts.age}
      {parts.actions}
    </div>
  )
}
