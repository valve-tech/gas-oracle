# Changelog

All notable changes to `@valve-tech/wallet-adapter` are documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Initial implementation. Vocabulary lifted from a real-world dapp
  (Provex) where SDK / UI / tx-tracker each redefined the same shapes
  separately; this is the first upstream packaging.
  - `WalletAdapter` interface plus `WalletSendTransactionRequest` and
    `WalletReadContractRequest` request shapes.
  - `WriteHookParams` — the single hook contract for the package.
    Four named callbacks covering the full one-shot lifecycle:
    `onAwaitingSignature` (pre-wallet), `onTransactionHash` (post-hash),
    `onMined` (terminal success), `onFailed` (terminal failure —
    rejection / revert / network error). UIs wire all four to drive
    a complete state machine.
  - `TX_STATUS` lifecycle const, `TrackedTxStatus` type, `TrackedTx`
    shape, `TrackedTxGas`, `TxConfirmedCallback`.
  - `TX_FLOW` extension point (ships empty), `TxFlow = string`.
  - `STALE_TX_AGE_MS` / `CONFIRMED_DISPLAY_MS` / `FAILED_DISPLAY_MS`
    display-window defaults.
- Unit tests covering the runtime constants and type-level shape
  guarantees (status-value uniqueness, phase literal union, hook
  parameter typing, `TrackedTx` pre-hash and post-hash construction).
- `sendTransactionWithHooks(options)` — wallet-side runtime helper.
  Fires `onAwaitingSignature` immediately before `sendTransaction`,
  fires both per-call and global `onTransactionHash` after the wallet
  returns the hash, fires `onFailed` on any thrown error before
  re-throwing.
- `awaitReceiptWithHooks(options)` — chain-side runtime helper.
  Awaits `waitForTransactionReceipt`, fires `onMined` on success,
  fires `onFailed` with a `ContractRevertedError` on
  `status: reverted`, fires `onFailed` with the original error on
  any other receipt-await failure (network / RPC / abort).
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
