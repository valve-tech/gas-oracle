/**
 * 04 — viem-actions integration.
 *
 * Two ways to use the actions:
 *
 *   (a) Direct invocation: `gasOracleActions(opts)(client)` returns the
 *       action set as a typed object. Cleanest types; recommended.
 *
 *   (b) viem's `.extend(...)` flow: `client.extend(gasOracleActions(opts))`
 *       merges the actions onto the client itself. More ergonomic but
 *       hits a viem 2.x typing limitation around the actions object's
 *       shape — see the cast below.
 *
 * Both produce the same runtime behavior.
 *
 * Run with: yarn tsx examples/04-viem-actions.ts
 */

import { createPublicClient, http, type PublicClient } from 'viem'
import { mainnet } from 'viem/chains'
import {
  gasOracleActions,
  type GasOracleActions,
} from '../src/viem-actions.js'

const baseClient = createPublicClient({
  chain: mainnet,
  transport: http(),
})

// (a) Direct invocation — recommended.
const oracle = gasOracleActions({
  chainId: 1,
  priorityModel: 'eip1559',
  keepMempoolSnapshot: true,
})(baseClient)

const fast = await oracle.getGasTier('fast')
console.log(`fast tier (direct): maxPriorityFee=${fast.maxPriorityFeePerGas} wei`)

const top10 = await oracle.tipForBlockPosition({ kind: 'rank', rank: 10 })
console.log(`top-10 tip (direct): ${top10.requiredTip} wei`)

oracle.stopGasOracle()

// (b) viem .extend(...) form — same runtime, slightly different ergonomics.
// The cast works around viem 2.x's strict actions-object index-signature
// requirement; it'll be cleaned up in a future version.
const extendedClient = baseClient.extend(
  gasOracleActions({ chainId: 1, priorityModel: 'eip1559' }) as unknown as (
    client: PublicClient,
  ) => GasOracleActions & Record<string, unknown>,
)

const standard = await extendedClient.getGasTier('standard')
console.log(`standard tier (extend): maxPriorityFee=${standard.maxPriorityFeePerGas} wei`)

extendedClient.stopGasOracle()
