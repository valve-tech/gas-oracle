/**
 * @fileoverview `<TxFlightActions>` — button slots for speed-up,
 * cancel, and dismiss. Renders nothing when no callbacks are wired
 * (forces consumers to opt in; no orphan buttons).
 *
 * The actual `replaceTransaction` plumbing is the consumer's
 * responsibility (different wallets, different gas-recommendation
 * strategies). This component just exposes click handlers carrying
 * the relevant `tx`.
 */

import type { CSSProperties, ReactNode } from 'react'

import type { TrackedTx } from '@valve-tech/wallet-adapter'

export interface TxFlightActionsShow {
  speedUp?: boolean
  cancel?: boolean
  dismiss?: boolean
}

export interface TxFlightActionsProps {
  tx: TrackedTx
  onSpeedUp?: (tx: TrackedTx) => void
  onCancel?: (tx: TrackedTx) => void
  onDismiss?: (tx: TrackedTx) => void
  /**
   * Per-button visibility override. Default: each button is shown iff
   * the matching callback is supplied.
   */
  show?: TxFlightActionsShow
  className?: string
  style?: CSSProperties
}

export const TxFlightActions = ({
  tx,
  onSpeedUp,
  onCancel,
  onDismiss,
  show,
  className,
  style,
}: TxFlightActionsProps): ReactNode => {
  const showSpeedUp = (show?.speedUp ?? true) && onSpeedUp !== undefined
  const showCancel = (show?.cancel ?? true) && onCancel !== undefined
  const showDismiss = (show?.dismiss ?? true) && onDismiss !== undefined

  if (!showSpeedUp && !showCancel && !showDismiss) return null

  return (
    <div className={className} style={style} data-tx-id={tx.id}>
      {showSpeedUp && (
        <button
          type="button"
          data-action="speed-up"
          onClick={() => onSpeedUp?.(tx)}
        >
          Speed up
        </button>
      )}
      {showCancel && (
        <button
          type="button"
          data-action="cancel"
          onClick={() => onCancel?.(tx)}
        >
          Cancel
        </button>
      )}
      {showDismiss && (
        <button
          type="button"
          data-action="dismiss"
          onClick={() => onDismiss?.(tx)}
        >
          Dismiss
        </button>
      )}
    </div>
  )
}
