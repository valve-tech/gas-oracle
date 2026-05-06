/**
 * 08 — Shared `ChainSource` between the gas oracle and the tx tracker.
 *
 * Per `docs/tx-tracker-spec.md` §3.1, `ChainSource` is the canonical
 * chain-observation primitive; both `GasOracle` and `TxTracker` are
 * sibling consumers. **One upstream RPC poll cycle** feeds both —
 * regardless of how many derived views attach.
 *
 * This example wires both so a wallet UI can render a tier picker
 * AND a tx status strip from the same upstream stream. Each surface
 * owns its own lifecycle; stopping one does NOT stop the other or
 * the source (per spec §14.1).
 *
 * Run with: yarn tsx examples/08-tx-tracker-with-oracle.ts
 */

import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'

import { createChainSource } from '@valve-tech/chain-source'
import { createTxTracker } from '@valve-tech/tx-tracker'

import { createGasOracle } from '../src/index.js'

const client = createPublicClient({
  chain: mainnet,
  transport: http(),
})

// One source — owns the upstream poll cycle and capability probe.
const source = createChainSource({ client })

// Two siblings — both consume the same source, neither depends on
// the other. The oracle reads the source's block + fee history for
// tier reduction; the tracker reads the source's block + mempool for
// per-tx observations.
const oracle = createGasOracle({
  source,
  chainId: 1,
  priorityModel: 'eip1559',
})
const tracker = createTxTracker({ source, chainId: 1 })

source.start()
oracle.start()
tracker.start()

// Wallet UI demonstration — neutral observations from the tracker get
// translated into the consumer's policy / vocabulary at the call site.
// The tracker itself never says "Confirmed" or "Likely dropped"; the
// switch below is the consumer's interpretation of the underlying
// observations.
const hash =
  '0x1111111111111111111111111111111111111111111111111111111111111111'

const unsub = tracker.subscribe(hash, (event) => {
  switch (event.kind) {
    case 'seen-in-mempool':
      console.log('UI: Awaiting inclusion...')
      break
    case 'seen-in-block':
      if (event.confirmations >= 1) console.log('UI: Confirmed')
      break
    case 'replaced-by':
      console.log(`UI: Replaced by ${event.replacementHash}`)
      break
    case 'unseen-for-N-blocks':
      if (event.blocks > 30) console.log('UI: Likely dropped')
      break
    case 'signal-degraded':
      console.log('UI: Connection unstable — observation degraded')
      break
  }
})

// Read a tier from the oracle on the same tick.
await oracle.pollOnce()
const state = oracle.getState()
if (state) {
  console.log(`Standard tier maxFee: ${state.tiers.standard?.maxFeePerGas}`)
}

// Run for a short window then tear everything down. The teardown
// order matches the construction order's reverse, but the lifecycle
// is symmetric — start/stop on each surface are independent.
setTimeout(() => {
  unsub()
  tracker.stop()
  oracle.stop()
  source.stop()
}, 30_000)
