/**
 * Per-chain configuration presets for `createGasOracle`. Most chains
 * need NO entry — the package default (PriorityModel.eip1559, no
 * decay-cap override, default polling cadence) is correct. Add an entry
 * only after verifying the chain's actual validator behavior against
 * block-level data; the cost of being wrong is silent under-pricing
 * and stuck transactions.
 *
 * PulseChain (chain 369) is the canonical exception: extractive
 * validators ignore the EIP-2718 type byte and maximize fee/gas
 * regardless of tx envelope, so percentile math has to draw from the
 * full distribution (PriorityModel.flat).
 */

import type { CreateGasOracleOptions } from './oracle.js'
import { PriorityModel } from './types.js'

/**
 * Chain-specific configuration overrides. Includes the fields whose
 * correct value varies by chain — transport (`client`/`source`),
 * error handling (`onError`), and other non-chain-specific options
 * are NOT here (those are caller-supplied, never preset).
 */
export type ChainPreset = {
  chainId: number
} & Pick<
  CreateGasOracleOptions,
  'priorityModel' | 'priorityFeeDecayCap' | 'pollIntervalMs'
>

export const chainPresets = {
  pulsechain: {
    chainId: 369,
    priorityModel: PriorityModel.flat,
  },
} as const satisfies Record<string, ChainPreset>

/**
 * Look up a preset by chainId. Returns `undefined` when no preset is
 * registered — caller should treat that as "default behavior is correct"
 * and call `createGasOracle` without spreading any preset.
 */
export const presetForChainId = (
  chainId: number,
): ChainPreset | undefined =>
  Object.values(chainPresets).find((preset) => preset.chainId === chainId)
