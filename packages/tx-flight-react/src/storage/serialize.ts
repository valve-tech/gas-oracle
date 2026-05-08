/**
 * @fileoverview Bigint-safe JSON for TrackedTx persistence.
 *
 * `JSON.stringify` rejects bigints. The only bigint fields on a
 * TrackedTx live under `submittedGas: { maxFeePerGas, maxPriorityFeePerGas }`,
 * so the serializer narrows there. Hex-string encoding with a `0x`
 * prefix matches the rest of the toolkit's wire-format convention
 * (chain-source, gas-oracle).
 */

import type { TrackedTx, TrackedTxGas } from '@valve-tech/wallet-adapter'

interface SerializedGas {
  maxFeePerGas: string
  maxPriorityFeePerGas: string
}

interface SerializedTrackedTx extends Omit<TrackedTx, 'submittedGas'> {
  submittedGas?: SerializedGas
}

const gasToWire = (gas: TrackedTxGas): SerializedGas => ({
  maxFeePerGas: '0x' + gas.maxFeePerGas.toString(16),
  maxPriorityFeePerGas: '0x' + gas.maxPriorityFeePerGas.toString(16),
})

const gasFromWire = (gas: SerializedGas): TrackedTxGas => ({
  maxFeePerGas: BigInt(gas.maxFeePerGas),
  maxPriorityFeePerGas: BigInt(gas.maxPriorityFeePerGas),
})

export const serialize = (txs: readonly TrackedTx[]): string =>
  JSON.stringify(
    txs.map(({ submittedGas, ...rest }): SerializedTrackedTx => ({
      ...rest,
      ...(submittedGas ? { submittedGas: gasToWire(submittedGas) } : {}),
    })),
  )

export const deserialize = (raw: string): TrackedTx[] => {
  const parsed = JSON.parse(raw) as SerializedTrackedTx[]
  return parsed.map(({ submittedGas, ...rest }): TrackedTx => ({
    ...rest,
    ...(submittedGas ? { submittedGas: gasFromWire(submittedGas) } : {}),
  }))
}
