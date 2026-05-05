# `@valve-tech/wallet-adapter`

Framework-agnostic vocabulary for EVM dapp wallet integration. Pure
types + a few `as const` lifecycle constants — no runtime
implementation, no opinion about which wallet library you use.

Three concerns under one package so an SDK author and a UI author
agree on the same surface:

1. **`WalletAdapter`** — the contract an SDK accepts in lieu of
   coupling to wagmi / ethers / viem direct / a smart account.
2. **`WriteHookParams`** — per-call `onAwaitingSignature` and
   `onTransactionHash` lifecycle callbacks any SDK write method should
   accept and fire.
3. **`TX_STATUS` / `TrackedTx`** — vocabulary for "this transaction is
   in flight" UIs (toast strips, inline indicators, history panes) so
   they can sit on top of any tracker without redefining state names.

Pure types and a handful of `as const` objects. No runtime
dependencies. viem is a peer dependency for the `Hex` type only.

## Why

Every SDK invents its own wallet shape; every dapp invents its own
"awaiting signature" state machine; every UI invents its own list of
status names. The result is a small ecosystem where the same word
means slightly different things at every boundary, and dapps end up
writing translation glue between them.

This package is the shared vocabulary. Use `WalletAdapter` so a single
wagmi/ethers/smart-account adapter works across every SDK. Use
`WriteHookParams` so the UI sees consistent transitions across every
SDK write. Use `TX_STATUS` so the in-flight strip and the receipt-poll
agree on what `'pending'` means.

## Install

```sh
npm install @valve-tech/wallet-adapter viem
# or
yarn add @valve-tech/wallet-adapter viem
```

## Quick start

### Defining an SDK that accepts any wallet

```ts
import type { WalletAdapter, WriteHookParams } from '@valve-tech/wallet-adapter'

export interface MyWriteParams { depositId: bigint; amount: bigint }

export class MyClient {
  constructor(private wallet: WalletAdapter) {}

  async deposit(params: MyWriteParams & WriteHookParams) {
    params.onAwaitingSignature?.()
    const hash = await this.wallet.sendTransaction({
      to: this.escrow,
      data: this.encodeDeposit(params),
      chainId: this.chainId,
    })
    params.onTransactionHash?.(hash)
    return hash
  }
}
```

### A tx-flight UI built on `TX_STATUS`

```ts
import { TX_STATUS, type TrackedTx } from '@valve-tech/wallet-adapter'

function subtitle(tx: TrackedTx): string {
  switch (tx.status) {
    case TX_STATUS.preparing:         return 'preparing transaction'
    case TX_STATUS.awaitingSignature: return 'awaiting wallet signature'
    case TX_STATUS.pending:           return 'waiting for inclusion'
    case TX_STATUS.mined:             return 'confirmed on-chain'
    case TX_STATUS.failed:            return tx.notes ?? 'transaction failed'
    case TX_STATUS.dropped:           return 'dropped from mempool'
    case TX_STATUS.replaced:          return 'replaced by speed-up'
  }
}
```

## Exports

| Export | Kind | Shape |
| --- | --- | --- |
| `WalletAdapter` | type | `{ address?, sendTransaction(req), readContract?(req) }` |
| `WalletSendTransactionRequest` | type | EIP-1559 send shape — `{ to, data, value?, chainId, maxFeePerGas?, maxPriorityFeePerGas? }` |
| `WalletReadContractRequest` | type | `{ address, abi, functionName, args?, chainId? }` |
| `WriteHookParams` | type | `{ onAwaitingSignature?, onTransactionHash? }` |
| `WritePhase` | type | `'preparing' \| 'awaiting-signature' \| 'broadcasted' \| 'mined'` |
| `WritePhaseHookParams` | type | `{ onPhase?(phase, ctx?) }` — forward-looking single-callback shape |
| `TX_STATUS` | const | lifecycle states |
| `TX_FLOW` | const | empty by design — protocols extend |
| `TrackedTx` | type | `{ id, hash?, chainId, flow, submittedAt, ... status, notes? }` |
| `STALE_TX_AGE_MS` / `CONFIRMED_DISPLAY_MS` / `FAILED_DISPLAY_MS` | const | window defaults |

## Design notes

- **No runtime dependencies.** Adding this package to a dapp is free.
- **`TX_FLOW` is intentionally empty.** Every protocol's flow names
  (`fulfillIntent`, `addFunds`, `mintNFT`, etc.) are its own concern.
  Extend the `TxFlow` type via your own union.
- **Pre-hash states are first-class.** `preparing` and
  `awaiting-signature` carry no `hash` — they exist so the UI has
  something to show during the wallet-sign window.
- **`id` is stable, `hash` is not.** Registries assign `id` at
  `beginTx` time and attach `hash` later. This lets pre-hash UI render
  before the wallet returns.
- **`WritePhase` exists as a future migration target.** When an SDK
  needs more than two lifecycle phases, switch to `onPhase` rather
  than growing the boolean-named callback surface.

## License

MIT
