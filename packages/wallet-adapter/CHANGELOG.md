# Changelog

All notable changes to `@valve-tech/wallet-adapter` are documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.5.0] — 2026-05-05

### Changed — BREAKING

- **All lifecycle event payloads are now rich info bags carrying full
  `TxContext` (`chainId` + original `request`) plus phase-specific
  fields.** The previous shapes forced consumers (especially the
  upcoming `@valve-tech/tx-tracker`) to maintain a side-channel
  `hash → request` map and re-fetch chainId / block timestamp / block
  baseFeePerGas from the public client. The lib already has all of
  that in scope when it fires events, so the consumer should never
  have to re-gather it.

  Old / new signatures:

  | Hook | Old | New |
  | ---- | --- | --- |
  | `onAwaitingSignature` | `() => void` | `(info: TxContext) => void` |
  | `onTransactionHash` (per-call & global) | `(hash: Hex) => void` | `(info: TxContext<{ hash }>) => void` |
  | `onConfirmed` | `(receipt: TransactionReceipt) => void` | `(info: TxContext<{ hash, receipt, block? }>) => void` |
  | `onFailed` | `(error: Error) => void` | `(info: TxContext<{ error, hash?, receipt?, block? }>) => void` |
  | `onDropped` | `(info: { hash }) => void` | `(info: TxContext<{ hash }>) => void` |
  | `onReplaced` | `(info: { original, replacement, receipt? }) => void` | `(info: TxContext<{ original, replacement, receipt?, block? }>) => void` |

  The `onPhase` discriminated-union event gains the same enrichment;
  `WritePhaseEvent` is now derived mechanically from a `WritePhaseSteps`
  map intersected with `TxContext<Steps[K]>`, so adding a phase or a
  shared field is a one-line edit instead of seven.

- **`awaitReceiptWithHooks` now requires `request` in its options and
  fetches the containing `Block` by default.** Signature gained
  `request: WalletSendTransactionRequest` (used to populate `TxContext`
  in event payloads) and `includeBlock?: boolean = true`. When
  `includeBlock` is left at its default, the helper calls
  `publicClient.getBlock({ blockHash })` once after a successful
  receipt-await; the resulting `Block` is attached to `confirmed` /
  receipt-bearing `failed` event payloads. Pass `includeBlock: false`
  to skip the extra RPC round trip in environments that don't need
  block-level data.

- **`ReceiptAwaiter` interface gained `getBlock`.** Mocks need to add
  a `getBlock(args: { blockHash: Hex }): Promise<Block>` field. Real
  viem `PublicClient` instances satisfy the new shape unchanged.

### Added

- `WritePhaseSteps` interface — phase-name → per-phase delta map.
  Declared as `interface` (not `type`) so consumers can extend the
  lifecycle via declaration merging without forking the union.
- `TxContext<Extra extends object = object>` — generic always-present
  context (`chainId`, `request`) intersected with `Extra` to derive
  per-phase event shapes. Defaulting `Extra` keeps `TxContext` usable
  bare.
- `WritePhaseEvent` is now derived mechanically as
  `{ [K in keyof WritePhaseSteps]: { phase: K } & TxContext<WritePhaseSteps[K]> }[keyof WritePhaseSteps]`.
- `confirmed` and `replaced` events carry an optional `block: Block`.
  `failed` events carry the receipt-bearing context (hash, receipt,
  block) when the failure has one (revert), and just the error +
  context otherwise (wallet rejection, network timeout).

### Migration

```ts
// before — v0.4.x
hooks: {
  onConfirmed: (receipt) => recordTx({ hash: receipt.transactionHash, receipt }),
  onFailed: (error) => logFailure(error),
}
await awaitReceiptWithHooks({ publicClient, hash, hooks })

// after — v0.5.x
hooks: {
  onConfirmed: (info) => recordTx(info), // info.chainId, info.request, info.hash, info.receipt, info.block
  onFailed: (info) => logFailure(info.error, info.chainId, info.request),
}
await awaitReceiptWithHooks({ publicClient, hash, request, hooks })
//                                                  ^^^^^^^ new required field
```

## [0.4.1] — 2026-05-04

### Fixed

- **`workspace:^` leak in the published `0.4.0` manifest.** The
  `0.4.0` tarball shipped with `dependencies: { "@valve-tech/viem-errors":
  "workspace:^" }` literally inside its `package.json` —
  `workspace:` is a yarn-only protocol that npm cannot resolve, so
  `npm install @valve-tech/wallet-adapter@0.4.0` fails for any consumer
  without a manual resolution override. Root cause: the release
  workflow used `npm publish` directly, which leaves the manifest
  unmodified. Fixed by switching the publish step to `yarn pack`
  (which rewrites `workspace:^` to the real semver range, e.g.
  `^0.4.1`) followed by `npm publish <tarball>` (which preserves
  `--provenance`).
- Consumers on `0.4.0` should bump to `0.4.1` and remove any
  `resolutions` / `overrides` entry forcing
  `@valve-tech/wallet-adapter`'s `@valve-tech/viem-errors` dep to a
  real range.

## [0.4.0] — 2026-05-04

> **`0.4.0` is broken — use `0.4.1` or later.** See the `0.4.1`
> entry above for the workspace-protocol leak. `0.4.0` will be
> deprecated on npm.

### Added

- Initial implementation. Vocabulary lifted from a real-world dapp
  (Provex) where SDK / UI / tx-tracker each redefined the same shapes
  separately; this is the first upstream packaging.
  - `WalletAdapter` interface plus `WalletSendTransactionRequest` and
    `WalletReadContractRequest` request shapes.
  - `WriteHookParams` — full lifecycle contract. Six named callbacks
    (`onAwaitingSignature`, `onTransactionHash`, `onConfirmed`,
    `onFailed`, `onDropped`, `onReplaced`) plus a complementary
    single-callback `onPhase(event)` shape with a discriminated-union
    payload. Fire-ers fire BOTH shapes for every transition.
  - `WritePhase` (`'preparing' | 'awaiting-signature' | 'pending' |
    'confirmed' | 'failed' | 'dropped' | 'replaced'`) and
    `WritePhaseEvent` discriminated union for `onPhase` consumers.
  - `TX_STATUS` lifecycle const, `TrackedTxStatus` type, `TrackedTx`
    shape, `TrackedTxGas`, `TxConfirmedCallback`.
  - `TX_FLOW` extension point (ships empty), `TxFlow = string`.
  - `STALE_TX_AGE_MS` / `CONFIRMED_DISPLAY_MS` / `FAILED_DISPLAY_MS`
    display-window defaults.
- Unit tests covering the runtime constants and type-level shape
  guarantees (status-value uniqueness, phase literal union, hook
  parameter typing, `TrackedTx` pre-hash and post-hash construction).
- `sendTransactionWithHooks(options)` — wallet-side runtime helper.
  Fires `onAwaitingSignature` + `onPhase('awaiting-signature')`
  immediately before `sendTransaction`; fires per-call + global
  `onTransactionHash` and `onPhase('pending', { hash })` after the
  wallet returns; fires `onFailed` + `onPhase('failed', ...)` on any
  thrown error before re-throwing.
- `awaitReceiptWithHooks(options)` — chain-side runtime helper.
  Awaits `waitForTransactionReceipt`; fires `onConfirmed` +
  `onPhase('confirmed', { hash, receipt })` on success; fires
  `onFailed` with a `ContractRevertedError` + `onPhase('failed', ...)`
  on `status: reverted`; fires `onFailed` with the original error +
  `onPhase('failed', ...)` on any other receipt-await failure.
- `WalletRejectedError` — `Error` subclass thrown by
  `sendTransactionWithHooks` on user rejection; preserves the original
  error as `cause`.
- `ContractRevertedError` — `Error` subclass thrown by
  `awaitReceiptWithHooks` on `status: reverted`; carries the `hash`
  and full `receipt` so consumers can extract revert reasons / log
  data without re-fetching.
- Runtime dependency on `@valve-tech/viem-errors` for the
  three-signal rejection detection (EIP-1193 `code === 4001`, viem
  class name, message regex — anywhere in the cause chain).
