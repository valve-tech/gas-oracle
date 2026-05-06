# @valve-tech/tx-tracker

Per-tx state machine for EVM chains. Emits **neutral observations** —
`seen-in-mempool`, `seen-in-block`, `replaced-by`, `vanished-from-block`,
`unseen-for-N-blocks`, `signal-degraded`, `signal-recovered`, `stopped` —
so wallet UIs, indexers, and relays can write their own interpretations
on top. The package itself never says "confirmed" or "stuck"; it gives
you the data to decide.

See
[`docs/tx-tracker-spec.md`](https://github.com/valve-tech/evm-toolkit/blob/main/docs/tx-tracker-spec.md)
for the full design contract.

```ts
import { createChainSource } from '@valve-tech/chain-source'
import { createTxTracker } from '@valve-tech/tx-tracker'

const source = createChainSource({ client })
const tracker = createTxTracker({ source, chainId: 1 })
source.start(); tracker.start()

for await (const event of tracker.track('0xabc...')) {
  if (event.kind === 'seen-in-block' && event.confirmations >= 6) break
}
```

## Why this exists

Tx-tracking on EVM is unforgiving:
- **Three different consumer shapes** (wallet UI, indexer, relay) want
  the same underlying observations but very different consumption
  ergonomics.
- **Five state transitions** (pending, mined, replaced, dropped,
  reorged) plus their authoritative-vs-degraded sources.
- **Per-method capability variance** — some upstreams gate
  `txpool_content`, some allow `eth_subscribe('newHeads')` but not
  `newPendingTransactions`, some only offer HTTP.
- **No silent downgrade** — a tracker that says "your tx is mined"
  when the WS dropped and the receipt poll happens to still see the
  old block is lying. Every event in this package carries a `source`
  discriminator so consumers know how authoritative it is.

This package handles all of it as one push-based core with three thin
adapters (callback / async iterator / snapshot).

## Install

```bash
yarn add @valve-tech/tx-tracker @valve-tech/chain-source viem
```

## For AI agents

This package ships an [`AGENTS.md`](AGENTS.md) reference and a
[`skills/`](skills/) directory for Claude Code / Cursor skill files
shipped in the npm tarball. After install, both are reachable at:

- `node_modules/@valve-tech/tx-tracker/AGENTS.md`
- `node_modules/@valve-tech/tx-tracker/skills/tx-tracker-integration/SKILL.md`

## License

MIT
