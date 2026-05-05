# `@valve-tech/wallet-adapter`

Framework-agnostic vocabulary for EVM dapp wallet integration. Pure
types + a few `as const` lifecycle constants — no runtime
implementation, no opinion about which wallet library you use.

Five concerns under one package so SDK authors, UI authors, and apps
all agree on the same surface:

1. **`WalletAdapter`** — the contract an SDK accepts in lieu of
   coupling to wagmi / ethers / viem direct / a smart account.
2. **`WriteHookParams`** — every phase a tracked tx can be in. Six
   named hooks (`onAwaitingSignature`, `onTransactionHash`,
   `onConfirmed`, `onFailed`, `onDropped`, `onReplaced`) plus a
   complementary single-callback shape (`onPhase(event)`) with a
   discriminated-union payload. Every payload is a `TxContext` info
   bag — `{ chainId, request, ...phase-specific }` — so consumers
   never have to side-channel the originating chain or the original
   send request. Fire-ers fire BOTH shapes for every transition —
   exactly once each — so wiring named hooks doesn't preclude
   `onPhase` and vice versa.
3. **`sendTransactionWithHooks(options)`** — wallet-side helper. Fires
   the pre-wallet (`onAwaitingSignature`, `onPhase('awaiting-signature')`)
   and post-hash (`onTransactionHash`, `onPhase('pending', { ..., hash })`)
   transitions. Converts wallet rejections to a typed
   `WalletRejectedError`, fires `onFailed` + `onPhase('failed', { ..., error })`,
   then throws.
4. **`awaitReceiptWithHooks(options)`** — chain-side helper. Awaits
   `waitForTransactionReceipt`, fetches the containing block (so
   downstream consumers don't re-fetch it for `timestamp` /
   `baseFeePerGas`), then fires `onConfirmed` +
   `onPhase('confirmed', { ..., hash, receipt, block })` on success,
   or `onFailed` + `onPhase('failed', ...)` with a typed
   `ContractRevertedError` on `status: 'reverted'`. Other receipt-await
   errors re-thrown unchanged after firing the failure hooks. Pass
   `includeBlock: false` to skip the block fetch.
5. **`TX_STATUS` / `TrackedTx`** — vocabulary for "this transaction is
   in flight" UIs (toast strips, inline indicators, history panes) so
   they can sit on top of any tracker without redefining state names.

The two helpers split by concern: the wallet side and the chain side.
SDKs chain them with whatever protocol-specific work goes in the
middle (gating-service signatures, log decoding, indexer sync). The
only runtime dependency is `@valve-tech/viem-errors` for the
rejection-detection check; viem is a peer dependency for the `Hex`
and `TransactionReceipt` types.

**`onDropped` and `onReplaced` are part of the contract; the helpers
in this package don't fire them.** Honestly distinguishing "still
propagating" from "permanently dropped" requires observing the tx
across many blocks with a configurable timeout policy, and detecting
replacement requires nonce-watching across the same nonce — that's
`@valve-tech/tx-tracker`'s job (per-tx state machine). The contract
defines the hooks here so consumers wire one set of callbacks; the
tracker fires them when it ships. Wiring `onDropped` / `onReplaced`
against `awaitReceiptWithHooks` is harmless but they will not fire
from this package.

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
    /**
     * Optional global / analytics channel — fires alongside the per-call hook.
     * Receives the rich `{ chainId, request, hash }` info bag, so analytics
     * observers see the originating chain and request without a side channel.
     */
    private onTransactionHash?: WriteHookParams['onTransactionHash'],
  ) {}

  async deposit(params: MyWriteParams & WriteHookParams) {
    const request = {
      to: this.escrow,
      data: this.encodeDeposit(params),
      chainId: this.chainId,
    }
    try {
      const hash = await sendTransactionWithHooks({
        wallet: this.wallet,
        request,
        hooks: params,
        onTransactionHash: this.onTransactionHash,
      })
      const receipt = await awaitReceiptWithHooks({
        publicClient: this.publicClient,
        hash,
        request,                 // carried into every phase event as part of TxContext
        hooks: params,
      })
      // protocol-specific work here (decode logs, etc.) — onConfirmed already fired
      // with { chainId, request, hash, receipt, block } in scope
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

- `onAwaitingSignature` fires **once** with `{ chainId, request }`,
  **immediately before** `wallet.sendTransaction`.
- `onTransactionHash` (per-call **and** global) fires **once each**
  with `{ chainId, request, hash }`, **after** `sendTransaction`
  resolves and **before** any receipt-await.
- Wallet rejections — detected via the three-signal check in
  `@valve-tech/viem-errors` (EIP-1193 `code === 4001`, viem class name,
  message regex, anywhere in the cause chain) — are thrown as
  `WalletRejectedError`. `onFailed` fires with
  `{ chainId, request, error: <WalletRejectedError> }` before the throw.
- Any other thrown error fires `onFailed` (with `error: <thrown>`) and
  re-throws unchanged so the SDK keeps control of its error mapping.

`awaitReceiptWithHooks` guarantees:

- On `receipt.status === 'success'`: fetches the containing block
  (unless `includeBlock: false`), then fires
  `onConfirmed({ chainId, request, hash, receipt, block? })` and
  resolves with the receipt.
- On `receipt.status === 'reverted'`: fetches the block, then fires
  `onFailed({ chainId, request, hash, receipt, block?, error: <ContractRevertedError> })`
  and throws the error. `ContractRevertedError` carries `hash` + the
  full `receipt` for log inspection.
- On any thrown error during the receipt-await (network / RPC /
  abort): fires `onFailed({ chainId, request, error })` (no
  `hash`/`receipt`/`block`) and re-throws unchanged. The block fetch
  is skipped when the receipt itself fails to arrive.

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
| `WriteHookParams` | type | six named hooks (`onAwaitingSignature`, `onTransactionHash`, `onConfirmed`, `onFailed`, `onDropped`, `onReplaced`) + `onPhase(event)`. Every callback receives a `TxContext<Steps[K]>` info bag. |
| `WritePhase` | type | `'preparing' \| 'awaiting-signature' \| 'pending' \| 'confirmed' \| 'failed' \| 'dropped' \| 'replaced'` |
| `WritePhaseSteps` | interface | per-phase data delta map. `pending: { hash }`, `confirmed: { hash, receipt, block? }`, etc. Open to declaration merging. |
| `TxContext<Extra>` | type | `{ chainId, request } & Extra`. The always-present context intersected with the per-phase delta. Defaults `Extra` to `object`. |
| `WritePhaseEvent` | type | derived `{ [K in keyof WritePhaseSteps]: { phase: K } & TxContext<WritePhaseSteps[K]> }[keyof WritePhaseSteps]`. |
| `sendTransactionWithHooks(opts)` | function | `{ wallet, request, hooks?, onTransactionHash? } → Promise<Hex>`. Wallet-side helper. |
| `awaitReceiptWithHooks(opts)` | function | `{ publicClient, hash, request, includeBlock?, hooks? } → Promise<TransactionReceipt>`. Chain-side helper; fetches the containing block by default. |
| `WalletRejectedError` | class | `Error` subclass with `cause: Error`. Thrown by `sendTransactionWithHooks` on user rejection. |
| `ContractRevertedError` | class | `Error` subclass with `hash` + `receipt`. Thrown by `awaitReceiptWithHooks` on `status: reverted`. |
| `SendTransactionWithHooksOptions` / `AwaitReceiptWithHooksOptions` / `ReceiptAwaiter` | type | options + minimal client shape |
| `TX_STATUS` | const | lifecycle states |
| `TX_FLOW` | const | empty by design — protocols extend |
| `TrackedTx` | type | `{ id, hash?, chainId, flow, submittedAt, ... status, notes? }` |
| `STALE_TX_AGE_MS` / `CONFIRMED_DISPLAY_MS` / `FAILED_DISPLAY_MS` | const | window defaults |

## Design notes

- **One hook contract, two complementary shapes.** `WriteHookParams`
  describes every phase a tracked tx can be in. Six named callbacks
  cover the common transitions; `onPhase(event)` provides the same
  information as a discriminated-union single-callback shape for
  state-machine consumers. Fire-ers fire BOTH shapes for every
  transition — exactly once each. Wiring named hooks doesn't preclude
  `onPhase` and vice versa.
- **Rich payloads, not bare arguments.** Every event carries
  `TxContext` (`chainId` + the original `request`) on top of its
  phase-specific fields. The lib already has all of that in scope
  when it fires events; the alternative — `(receipt) => void` and
  `(hash) => void` — forces every consumer to maintain a side-channel
  `hash → request` map and call `client.chain.id` from inside their
  callbacks. `awaitReceiptWithHooks` also fetches the containing
  block once and includes it on `confirmed` / receipt-bearing
  `failed` events, so downstream consumers (notably
  `@valve-tech/tx-tracker`) skip the round trip.
- **`WritePhaseSteps` is the single source of truth for phase
  shapes.** `WritePhaseEvent` is derived mechanically as
  `{ [K in keyof WritePhaseSteps]: { phase: K } & TxContext<WritePhaseSteps[K]> }`,
  so adding a phase is one entry in the map plus a fire-er. Adding a
  shared field is one entry in `TxContext`. Both stay in lockstep
  with the named hook signatures.
- **`onFailed` is the unified failure callback for revert / rejection /
  network errors.** Wallet rejection, on-chain revert, and network
  errors all flow through it. `instanceof` against
  `WalletRejectedError` / `ContractRevertedError` discriminates the
  source. Distinct from `onDropped` (no inclusion observed) and
  `onReplaced` (different tx mined for the same nonce) — those are
  their own terminal states with their own typed payloads.
- **`onDropped` and `onReplaced` are part of the contract; this
  package's helpers don't fire them.** Detecting drop vs replacement
  requires multi-block observation with nonce-watching — that's
  `@valve-tech/tx-tracker`'s job. The hooks live in `WriteHookParams`
  so consumers wire one set of callbacks; the tracker fires them when
  it ships.
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
