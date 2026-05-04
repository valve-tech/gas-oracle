/**
 * 01 — Basic tier read.
 *
 * Construct an oracle, start it, force one synchronous poll so state is
 * populated, and read the four tiers.
 *
 * Run with: yarn tsx examples/01-basic-tiers.ts
 */

import { createPublicClient, http, parseEther } from 'viem'
import { mainnet } from 'viem/chains'
import { createGasOracle } from '../src/index.js'

const client = createPublicClient({
  chain: mainnet,
  transport: http(),
})

const oracle = createGasOracle({
  client,
  chainId: 1,
  priorityFeeDecayCap: parseEther('0.125'), // EIP-1559 12.5%/block parity
  priorityModel: 'eip1559',
})

oracle.start()

// pollOnce forces one synchronous fetch so the next getState() returns a
// populated state rather than null.
await oracle.pollOnce()

const state = oracle.getState()
if (!state) {
  console.error('Oracle could not produce state — upstream block fetch failed.')
  process.exit(1)
}

console.log(`Block ${state.blockNumber}, baseFee ${state.baseFee} wei`)
for (const tier of ['slow', 'standard', 'fast', 'instant'] as const) {
  const t = state.tiers[tier]
  console.log(
    `  ${tier.padEnd(8)}  maxPriorityFee=${t.maxPriorityFeePerGas} wei  maxFee=${t.maxFeePerGas} wei`,
  )
}

oracle.stop()
