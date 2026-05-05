# `@valve-tech/wallet-adapter`

Framework-agnostic vocabulary for EVM dapp wallet integration. Pure
types + a few `as const` lifecycle constants — no runtime
implementation, no opinion about which wallet library you use.

Four concerns under one package so SDK authors, UI authors, and apps
all agree on the same surface:

1. **`WalletAdapter`** — the contract an SDK accepts in lieu of
   coupling to wagmi / ethers / viem direct / a smart account.
2. **`WriteHookParams`** — per-call `onAwaitingSignature` and
   `onTransactionHash` lifecycle callbacks any SDK write method should
   accept and fire.
3. **`sendTransactionWithHooks(options)`** — runtime helper. SDKs call
   this from inside any write method that opens a wallet popup; it
   fires the hooks at the real boundaries, converts wallet rejections
   to a typed `WalletRejectedError`, and returns the on-chain hash. So
   adopting the contract is a one-liner per write method.
4. **`TX_STATUS` / `TrackedTx`** — vocabulary for "this transaction is
   in flight" UIs (toast strips, inline indicators, history panes) so
   they can sit on top of any tracker without redefining state names.

Pure types, a handful of `as const` objects, and one small async
helper. The only runtime dependency is `@valve-tech/viem-errors` for
the rejection-detection check; viem is a peer dependency for the
`Hex` type and viem-error compatibility.

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
import {
  sendTransactionWithHooks,
  WalletRejectedError,
  type WalletAdapter,
  type WriteHookParams,
} from '@valve-tech/wallet-adapter'

export interface MyWriteParams { depositId: bigint; amount: bigint }

export class MyClient {
  constructor(
    private wallet: WalletAdapter,
    private chainId: number,
    private escrow: `0x${string}`,
    /** Optional global / analytics channel — fires alongside the per-call hook. */
    private onTransactionHash?: (hash: `0x${string}`) => void,
  ) {}

  async deposit(params: MyWriteParams & WriteHookParams) {
    try {
      const hash = await sendTransactionWithHooks({
        wallet: this.wallet,
        request: {
          to: this.escrow,
          data: this.encodeDeposit(params),
          chainId: this.chainId,
        },
        hooks: params,
        onTransactionHash: this.onTransactionHash,
      })
      // ...await receipt, return result, etc.
      return { hash }
    } catch (err) {
      if (err instanceof WalletRejectedError) {
        throw new MySdkError('WALLET_REJECTED', err.message, err.cause)
      }
      throw new MySdkError('CONTRACT_ERROR', (err as Error).message, err as Error)
    }
  }
}
```

`sendTransactionWithHooks` guarantees:

- `onAwaitingSignature` fires **once**, **immediately before**
  `wallet.sendTransaction`.
- `onTransactionHash` (per-call **and** global) fires **once each**,
  **after** `sendTransaction` resolves and **before** any receipt-await.
- Wallet rejections — detected via the three-signal check in
  `@valve-tech/viem-errors` (EIP-1193 `code === 4001`, viem class name,
  message regex, anywhere in the cause chain) — are thrown as
  `WalletRejectedError` so consumers can `instanceof`-check and
  rewrap to their own error vocabulary.
- Non-rejection errors are re-thrown unchanged so the SDK keeps
  control of its error mapping.

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
| `sendTransactionWithHooks(opts)` | function | `{ wallet, request, hooks?, onTransactionHash? } → Promise<Hex>`. The runtime helper. |
| `WalletRejectedError` | class | `Error` subclass with `cause: Error`. Thrown by `sendTransactionWithHooks` on user rejection. |
| `SendTransactionWithHooksOptions` | type | options shape for the helper |
| `TX_STATUS` | const | lifecycle states |
| `TX_FLOW` | const | empty by design — protocols extend |
| `TrackedTx` | type | `{ id, hash?, chainId, flow, submittedAt, ... status, notes? }` |
| `STALE_TX_AGE_MS` / `CONFIRMED_DISPLAY_MS` / `FAILED_DISPLAY_MS` | const | window defaults |

## Design notes

- **One hook contract.** `WriteHookParams` — two named callbacks,
  fired by `sendTransactionWithHooks` at the only two boundaries the
  helper owns (pre-wallet, post-hash). No parallel "phase" enum, no
  `onPhase` shape, no future-proof speculation. If a third phase
  becomes genuinely necessary, that's a design conversation we'll
  have at that point — not a fork shipped pre-emptively.
- **`TX_FLOW` is intentionally empty.** Every protocol's flow names
  (`fulfillIntent`, `addFunds`, `mintNFT`, etc.) are its own concern.
  Extend the `TxFlow` type via your own union.
- **Pre-hash states are first-class.** `preparing` and
  `awaiting-signature` carry no `hash` — they exist so the UI has
  something to show during the wallet-sign window.
- **`id` is stable, `hash` is not.** Registries assign `id` at
  `beginTx` time and attach `hash` later. This lets pre-hash UI render
  before the wallet returns.

## License

MIT
