/**
 * @fileoverview In-process storage adapter. Test seam; consumer-facing
 * use case is "explicitly opt out of persistence."
 */

import type { TrackedTx } from '@valve-tech/wallet-adapter'

import type { TxFlightStorage } from '../types.js'

export const memoryAdapter = (): TxFlightStorage => {
  const data = new Map<string, TrackedTx[]>()
  return {
    load: async (id) => {
      const stored = data.get(id)
      return stored ? [...stored] : null
    },
    save: async (id, txs) => {
      data.set(id, [...txs])
    },
  }
}
