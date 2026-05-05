# `@valve-tech/wallet-adapter`

Framework-agnostic vocabulary for EVM dapp wallet integration. Pure
types + a few `as const` lifecycle constants — no runtime
implementation, no opinion about which wallet library you use.

Five concerns under one package so SDK authors, UI authors, and apps
all agree on the same surface:

1. **`WalletAdapter`** — the contract an SDK accepts in lieu of
   coupling to wagmi / ethers / viem direct / a smart account.
2. **`WriteHookParams`** — full per-call lifecycle: `onAwaitingSignature`
   (pre-wallet) → `onTransactionHash` (hash returned) → `onMined`
   (success) | `onFailed` (rejection / revert / network error).
3. **`sendTransactionWithHooks(options)`** — wallet-side helper. Fires
   the pre-wallet and post-hash hooks, converts wallet rejections to a
   typed `WalletRejectedError`, returns the on-chain hash. Fires
   `onFailed` on any thrown error before re-throwing.
4. **`awaitReceiptWithHooks(options)`** — chain-side helper. Awaits
   `waitForTransactionReceipt`, fires `onMined` on success or
   `onFailed` with a typed `ContractRevertedError` on `status:
   reverted`. Other receipt-await errors (network / RPC) re-thrown
   unchanged after firing `onFailed`.
5. **`TX_STATUS` / `TrackedTx`** — vocabulary for "this transaction is
   in flight" UIs (toast strips, inline indicators, history panes) so
   they can sit on top of any tracker without redefining state names.

The two helpers split by concern: the wallet side and the chain side.
SDKs chain them with whatever protocol-specific work goes in the
middle (gating-service signatures, log decoding, indexer sync). The
only runtime dependency is `@valve-tech/viem-errors` for the
rejection-detection check; viem is a peer dependency for the `Hex`
and `TransactionReceipt` types.

**Drop detection (tx vanished from mempool without inclusion) is NOT
in this contract.** Honestly distinguishing "still propagating" from
"permanently dropped" requires observing the tx across many blocks
with a configurable timeout policy — that's `@valve-tech/tx-tracker`'s
job. This package covers the one-shot lifecycle of a single send +
receipt-await.

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
  awaitReceiptWithHooks,
  WalletRejectedError,
  ContractRevertedError,
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
      const receipt = await awaitReceiptWithHooks({
        publicClient: this.publicClient,
        hash,
        hooks: params,
      })
      // protocol-specific work here (decode logs, etc.) — onMined already fired
      return { hash, receipt }
    } catch (err) {
      if (err instanceof WalletRejectedError) {
        throw new MySdkError('WALLET_REJECTED', err.message, err.cause)
      }
      if (err instanceof ContractRevertedError) {
        throw new MySdkError('TX_REVERTED', err.message, err)
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
  `WalletRejectedError`. `onFailed` fires with the rejection error
  before the throw.
- Any other thrown error fires `onFailed` and re-throws unchanged so
  the SDK keeps control of its error mapping.

`awaitReceiptWithHooks` guarantees:

- On `receipt.status === 'success'`: fires `onMined(receipt)` and
  resolves with the receipt.
- On `receipt.status === 'reverted'`: fires `onFailed` with a
  `ContractRevertedError` (carrying `hash` + the full `receipt` for
  log inspection) and throws it.
- On any thrown error during the receipt-await (network / RPC /
  abort): fires `onFailed` with the original error and re-throws
  unchanged.

A `WriteHookParams` consumer (toast strip, inline indicator, etc.)
that wires all four hooks can drive its full state machine — pre-wallet
"preparing", post-wallet "pending", terminal "confirmed" or "failed" —
purely from the contract, without any SDK-specific glue.

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
| `WriteHookParams` | type | `{ onAwaitingSignature?, onTransactionHash?, onMined?, onFailed? }` |
| `sendTransactionWithHooks(opts)` | function | `{ wallet, request, hooks?, onTransactionHash? } → Promise<Hex>`. Wallet-side helper. |
| `awaitReceiptWithHooks(opts)` | function | `{ publicClient, hash, hooks? } → Promise<TransactionReceipt>`. Chain-side helper. |
| `WalletRejectedError` | class | `Error` subclass with `cause: Error`. Thrown by `sendTransactionWithHooks` on user rejection. |
| `ContractRevertedError` | class | `Error` subclass with `hash` + `receipt`. Thrown by `awaitReceiptWithHooks` on `status: reverted`. |
| `SendTransactionWithHooksOptions` / `AwaitReceiptWithHooksOptions` / `ReceiptAwaiter` | type | options + minimal client shape |
| `TX_STATUS` | const | lifecycle states |
| `TX_FLOW` | const | empty by design — protocols extend |
| `TrackedTx` | type | `{ id, hash?, chainId, flow, submittedAt, ... status, notes? }` |
| `STALE_TX_AGE_MS` / `CONFIRMED_DISPLAY_MS` / `FAILED_DISPLAY_MS` | const | window defaults |

## Design notes

- **One hook contract, four named callbacks.** `WriteHookParams`
  describes the full one-shot lifecycle: pre-wallet
  (`onAwaitingSignature`), post-hash (`onTransactionHash`), terminal
  success (`onMined`), terminal failure (`onFailed`). Two helpers
  split who fires what: `sendTransactionWithHooks` owns the
  wallet-side hooks; `awaitReceiptWithHooks` owns the chain-side
  hooks. No `onPhase` / `WritePhase` shape — if a third phase ever
  becomes genuinely necessary, that's a design conversation at that
  point, not a fork shipped pre-emptively.
- **`onFailed` is the unified failure callback.** Wallet rejection,
  on-chain revert, and network errors all flow through it. Use
  `instanceof` against `WalletRejectedError` / `ContractRevertedError`
  to discriminate; everything else is a plain `Error`.
- **Drop detection lives in `tx-tracker`, not here.** A one-shot
  helper that calls `waitForTransactionReceipt` once cannot honestly
  distinguish "still propagating" from "permanently dropped" —
  ongoing observation across many blocks with a configurable timeout
  policy is the per-tx state machine's responsibility.
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
