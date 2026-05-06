/**
 * 07 — Minimal tx tracker.
 *
 * The simplest path to "what's happening to my transaction?" — one
 * `ChainSource`, one `TxTracker`, no oracle. The async-iterator
 * shape is the recommended consumption form for new code: it reads
 * top-to-bottom and lets the consumer write break-condition policy
 * inline (e.g. "exit when confirmations >= 6").
 *
 * Per `docs/tx-tracker-spec.md` §2.1 the tracker emits **neutral
 * observations only** — `seen-in-mempool`, `seen-in-block`,
 * `replaced-by`, `vanished-from-block`, `unseen-for-N-blocks`. The
 * consumer applies their own UX policy on top (this example just
 * logs and exits at 3 confirmations).
 *
 * Run with: yarn tsx examples/07-tx-tracker.ts
 */

import { createPublicClient, http } from 'viem'
import { mainnet } from 'viem/chains'

import { createChainSource } from '@valve-tech/chain-source'
import { createTxTracker } from '@valve-tech/tx-tracker'

const client = createPublicClient({
  chain: mainnet,
  transport: http(),
})

const source = createChainSource({ client })
const tracker = createTxTracker({ source, chainId: 1 })

source.start()
tracker.start()

// Replace with a real hash from a tx you submitted. Until a real
// observation lands the iterator just yields the synthetic `started`
// event — useful for rendering an "awaiting first observation" UI
// state without polling.
const hash =
  '0x1111111111111111111111111111111111111111111111111111111111111111'

console.log(`Tracking ${hash}...`)

for await (const event of tracker.track(hash)) {
  console.log(
    `[${event.kind}] source=${event.source} at block ${event.at.blockNumber}`,
  )
  if (event.kind === 'seen-in-block' && event.confirmations >= 3) {
    console.log(`Got 3 confirmations at block ${event.blockNumber}`)
    break
  }
  if (event.kind === 'replaced-by') {
    console.log(`Replaced by ${event.replacementHash}`)
    break
  }
  if (event.kind === 'unseen-for-N-blocks' && event.blocks > 30) {
    console.log(`Likely dropped (${event.blocks} blocks unseen)`)
    break
  }
}

tracker.stop()
source.stop()
