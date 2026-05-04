# evm-toolkit

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Monorepo for `@valve-tech`'s EVM-side primitives. Each package is
narrowly scoped, viem-native, and consumable independently.

## Packages

| Package | Status | Description |
|---|---|---|
| [`@valve-tech/chain-source`](packages/chain-source) | stub (v0.0.1) | Canonical EVM chain-observation primitive — push-or-poll source for new blocks, mempool snapshots, on-demand receipt + tx lookups, and per-method capability disclosure. The shared foundation the others consume. |
| [`@valve-tech/gas-oracle`](packages/gas-oracle) | published (v0.2.5) | Multi-tier gas-fee oracle (`slow` / `standard` / `fast` / `instant`) with downside-decay cap, EIP-1559 priority cutoff, and EIP-4844 blob-fee handling. |
| [`@valve-tech/tx-tracker`](packages/tx-tracker) | stub (v0.0.1) | Per-tx state machine emitting neutral observations (`seen-in-mempool`, `seen-in-block`, `replaced-by`, `vanished-from-block`, etc.) so consumers write their own interpretations. |

## Architecture

Three layers. `chain-source` is the shared foundation; `gas-oracle`
and `tx-tracker` are sibling consumers on top — neither depends on
the other, both consume the same upstream stream.

```
              ┌─────────────────────────────┐
              │   PublicClient (viem)       │
              └──────────────┬──────────────┘
                             │
              ┌──────────────▼──────────────┐
              │   @valve-tech/chain-source  │
              │   • capability probe         │
              │   • subscribeBlocks(cb)      │
              │   • subscribeMempool(cb)     │
              │   • on-demand getReceipt /   │
              │     getTransaction / etc.    │
              └──────┬───────────────┬───────┘
                     │               │
            ┌────────▼───────┐ ┌─────▼─────────┐
            │   gas-oracle   │ │   tx-tracker   │
            │   (tier        │ │   (per-tx      │
            │    reducer)    │ │    state mach) │
            └────────────────┘ └────────────────┘
```

A consumer who wants both gets one `chain-source` instance shared
between them — one upstream RPC stream, two derived views, no
double-polling.

The full design contract for v0.3.0 (chain-source + tx-tracker) is in
[`docs/tx-tracker-spec.md`](docs/tx-tracker-spec.md).

## Working in the repo

```bash
yarn install              # install all workspace deps
yarn typecheck            # typecheck every package
yarn typecheck:examples   # typecheck the gas-oracle examples
yarn lint                 # eslint across packages
yarn test                 # vitest across packages
yarn build                # build every package, in topological order

# Per-package:
yarn workspace @valve-tech/gas-oracle test
yarn workspace @valve-tech/chain-source build
```

For contributor guidance, see
[`.claude/skills/contributing-to-evm-toolkit/SKILL.md`](.claude/skills/contributing-to-evm-toolkit/SKILL.md).
For release flow, see
[`.claude/skills/releasing-evm-toolkit/SKILL.md`](.claude/skills/releasing-evm-toolkit/SKILL.md).

## License

MIT — see [`LICENSE`](LICENSE).
