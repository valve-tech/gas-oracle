/**
 * @valve-tech/gas-oracle/viem-transport — viem Transport wrapper.
 *
 * Use when callers want viem's existing API to *just work better*
 * without changing call-site code:
 *
 *   const transport = withGasOracle(http(rpcUrl), {
 *     chainId: 1,
 *     priorityFeeDecayCap: parseEther('0.125'),
 *     priorityModel: 'eip1559',
 *     intercept: { eth_maxPriorityFeePerGas: 'fast' },
 *   })
 *   const client = createPublicClient({ chain: mainnet, transport })
 *
 *   // Standard viem APIs now reach the oracle cache instead of upstream:
 *   await client.estimateMaxPriorityFeePerGas()
 *   await walletClient.sendTransaction({ ... })  // gas auto-fill is corrected
 *
 * Default `intercept` is `{ eth_gasFeeEstimate: true }` only — the
 * additive method that returns the full tier shape. Standard methods
 * (`eth_gasPrice`, `eth_maxPriorityFeePerGas`) pass through to upstream
 * unless the caller opts in AND specifies which tier to map them to.
 * Forcing the tier choice keeps the package out of the silently-pick-a-
 * percentile foot-gun the relay's gas-intercept caught earlier (one
 * customer's eth_gasPrice and another's eth_maxPriorityFeePerGas
 * returning numbers 5x apart because each defaulted to a different
 * percentile).
 *
 * `eth_feeHistory` is intentionally NOT in the intercept options.
 * Synthesizing the historical-percentile array from oracle state is
 * its own design problem; passthrough is the only honest answer in v0.2.
 */

import { custom, type Transport } from 'viem'

import { createGasOracle, type CreateGasOracleOptions, type GasOracle } from './oracle.js'
import type { GasOracleState, TierName, TierRecommendation } from './types.js'

export interface InterceptOptions {
  /**
   * Additive multi-tier read. Returns `{ baseFee, tiers: { slow, standard,
   * fast, instant }, mempoolPendingCount, ... }`. Default `true`.
   */
  eth_gasFeeEstimate?: boolean
  /**
   * Map `eth_gasPrice` to a tier's `gasPrice` (legacy field = baseFee + tip).
   * Required tier choice — boolean is intentionally not accepted because
   * a default tier would silently make this method's number depend on the
   * package version.
   */
  eth_gasPrice?: TierName | false
  /**
   * Map `eth_maxPriorityFeePerGas` to a tier's `maxPriorityFeePerGas`.
   * Required tier choice. Same reasoning as `eth_gasPrice`.
   */
  eth_maxPriorityFeePerGas?: TierName | false
}

export interface WithGasOracleOptions extends Omit<CreateGasOracleOptions, 'client'> {
  /**
   * Per-method intercept config. Methods not listed pass through to the
   * inner transport. See `InterceptOptions` field docs for defaults and
   * the rationale for tier-required opt-in on standard methods.
   */
  intercept?: InterceptOptions
  /**
   * When the oracle starts polling. `'eager'` (default) starts on
   * construction; `'lazy'` waits for the first intercepted RPC. Lazy
   * mode trades a small first-read latency for not running background
   * RPCs when the wrapped client is constructed but never used.
   */
  lifecycle?: 'eager' | 'lazy'
}

export type GasOracleTransport = Transport & { stopGasOracle: () => void }

/**
 * Sentinel returned by `dispatchIntercept` when no intercept matched
 * and the request should be passed through to the inner transport.
 * Using a unique symbol avoids any chance of ambiguity with a real
 * RPC result that happens to be `null` or `undefined`.
 */
const PASSTHROUGH = Symbol('gas-oracle:passthrough')

const toHex = (n: bigint): string => '0x' + n.toString(16)

const TIER_NAMES: TierName[] = ['instant', 'fast', 'standard', 'slow']

/**
 * Format a single tier for the `eth_gasFeeEstimate` response, scoped
 * to the requested tx type. Mirrors the relay's `gas-intercept.ts`
 * formatter so consumers of either surface get identical wire shapes.
 */
const formatTier = (
  tier: TierRecommendation,
  txType: number | undefined,
): Record<string, string> => {
  if (txType === 0 || txType === 1) {
    return { gasPrice: toHex(tier.gasPrice) }
  }
  if (txType === 2 || txType === 4) {
    return {
      maxFeePerGas: toHex(tier.maxFeePerGas),
      maxPriorityFeePerGas: toHex(tier.maxPriorityFeePerGas),
    }
  }
  if (txType === 3) {
    return {
      maxFeePerGas: toHex(tier.maxFeePerGas),
      maxPriorityFeePerGas: toHex(tier.maxPriorityFeePerGas),
      maxFeePerBlobGas: toHex(tier.maxFeePerBlobGas ?? 0n),
    }
  }
  // No type → include everything available
  const out: Record<string, string> = {
    gasPrice: toHex(tier.gasPrice),
    maxFeePerGas: toHex(tier.maxFeePerGas),
    maxPriorityFeePerGas: toHex(tier.maxPriorityFeePerGas),
  }
  if (tier.maxFeePerBlobGas !== null) {
    out.maxFeePerBlobGas = toHex(tier.maxFeePerBlobGas)
  }
  return out
}

const buildGasFeeEstimate = (
  state: GasOracleState,
  params: unknown[],
): Record<string, unknown> => {
  const txType = typeof params[0] === 'number' ? params[0] : undefined
  const tiers: Record<string, Record<string, string>> = {}
  for (const name of TIER_NAMES) {
    tiers[name] = formatTier(state.tiers[name], txType)
  }
  const out: Record<string, unknown> = {
    baseFee: toHex(state.baseFee),
    baseFeeTrend: state.baseFeeTrend,
    blockNumber: toHex(state.blockNumber),
    lastUpdated: toHex(state.timestamp),
    mempoolPendingCount: state.mempool.pendingCount,
    tiers,
  }
  if (state.blob) out.blobBaseFee = toHex(state.blob.blobBaseFee)
  return out
}

/**
 * Decide whether the requested method should be answered from oracle
 * state or passed through. Returns the response value, or PASSTHROUGH
 * when the method either isn't in the intercept config or the oracle
 * has no state yet (cold-start fallback to upstream).
 */
const dispatchIntercept = async (
  args: { method: string; params?: unknown[] },
  oracle: GasOracle,
  intercept: InterceptOptions,
): Promise<unknown | typeof PASSTHROUGH> => {
  const params = args.params ?? []

  if (args.method === 'eth_gasFeeEstimate' && intercept.eth_gasFeeEstimate !== false) {
    const state = oracle.getState() ?? (await oracle.pollOnce())
    if (!state) return PASSTHROUGH
    return buildGasFeeEstimate(state, params as unknown[])
  }

  if (args.method === 'eth_gasPrice') {
    const tier = intercept.eth_gasPrice
    if (tier === undefined || tier === false) return PASSTHROUGH
    const state = oracle.getState() ?? (await oracle.pollOnce())
    if (!state) return PASSTHROUGH
    return toHex(state.tiers[tier].gasPrice)
  }

  if (args.method === 'eth_maxPriorityFeePerGas') {
    const tier = intercept.eth_maxPriorityFeePerGas
    if (tier === undefined || tier === false) return PASSTHROUGH
    const state = oracle.getState() ?? (await oracle.pollOnce())
    if (!state) return PASSTHROUGH
    return toHex(state.tiers[tier].maxPriorityFeePerGas)
  }

  return PASSTHROUGH
}

/**
 * Wrap an existing viem Transport with gas-oracle interception.
 *
 * The returned value is a Transport (drops into `createPublicClient({
 * transport })` directly) plus a `stopGasOracle()` handle for shutdown
 * hooks (HMR, test teardown). The oracle is constructed once per
 * `withGasOracle` call — a single Transport instance is shared with
 * the oracle's poll loop, so wrapping `http(url)` once produces one
 * oracle and one stream of upstream RPC, regardless of how many
 * clients consume the transport downstream.
 */
export const withGasOracle = (
  innerTransport: Transport,
  options: WithGasOracleOptions,
): GasOracleTransport => {
  const intercept: InterceptOptions = {
    eth_gasFeeEstimate: true,
    ...options.intercept,
  }

  // Pull a TransportInstance for the oracle's own RPC fan-out. http() and
  // most built-in transports don't require a chain config for request
  // dispatch — chainId validation happens elsewhere.
  const oracleInner = innerTransport({})
  const oracleClient = { request: oracleInner.request } as Parameters<typeof createGasOracle>[0]['client']
  const oracle = createGasOracle({ ...options, client: oracleClient })
  if ((options.lifecycle ?? 'eager') === 'eager') oracle.start()

  const wrapped = custom({
    request: async (args: { method: string; params?: unknown[] }) => {
      const result = await dispatchIntercept(args, oracle, intercept)
      if (result !== PASSTHROUGH) return result
      // Reuse the inner transport-instance the oracle already opened
      // so we don't double-instantiate the http transport per client.
      return oracleInner.request({ method: args.method, params: args.params } as never)
    },
  })

  return Object.assign(wrapped, { stopGasOracle: () => oracle.stop() })
}
