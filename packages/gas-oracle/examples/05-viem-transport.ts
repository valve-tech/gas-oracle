/**
 * 05 — viem-transport interception (drop-in).
 *
 * Wrap a viem transport so gas-related RPC methods are served from the
 * oracle's cache instead of going to the upstream RPC. Useful when you
 * have existing code that calls `client.getGasPrice()` or eth_gasPrice
 * via wagmi and you want to upgrade those numbers without rewriting
 * call sites.
 *
 * Default intercepts only `eth_gasFeeEstimate` (a Valve-specific
 * multi-tier RPC extension). Standard methods like `eth_gasPrice`
 * require an explicit tier choice.
 *
 * Run with: yarn tsx examples/05-viem-transport.ts
 */

import { createPublicClient } from 'viem'
import { http as viemHttp } from 'viem'
import { mainnet } from 'viem/chains'
import { withGasOracle, type GasOracleTransport } from '../src/viem-transport.js'

const transport = withGasOracle(viemHttp(), {
  chainId: 1,
  priorityModel: 'eip1559',
  intercept: {
    eth_gasFeeEstimate: true, // default — multi-tier read
    eth_gasPrice: 'standard', // tier-required opt-in
    eth_maxPriorityFeePerGas: 'fast',
  },
  lifecycle: 'lazy', // defer poll until first intercepted RPC
})

const client = createPublicClient({ chain: mainnet, transport })

// `getGasPrice` now returns the standard-tier `gasPrice` from the oracle.
// Any wagmi/viem code that called this method picks up the tier
// automatically.
const gasPrice = await client.getGasPrice()
console.log(`eth_gasPrice (standard tier): ${gasPrice} wei`)

// Teardown — cast back to GasOracleTransport for the stop method.
;(transport as GasOracleTransport).stopGasOracle()
