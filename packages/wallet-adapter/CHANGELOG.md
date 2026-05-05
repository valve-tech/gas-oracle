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
  - `WriteHookParams` with `onAwaitingSignature` and per-call
    `onTransactionHash` — the single hook contract for the package.
  - `TX_STATUS` lifecycle const, `TrackedTxStatus` type, `TrackedTx`
    shape, `TrackedTxGas`, `TxConfirmedCallback`.
  - `TX_FLOW` extension point (ships empty), `TxFlow = string`.
  - `STALE_TX_AGE_MS` / `CONFIRMED_DISPLAY_MS` / `FAILED_DISPLAY_MS`
    display-window defaults.
- Unit tests covering the runtime constants and type-level shape
  guarantees (status-value uniqueness, phase literal union, hook
  parameter typing, `TrackedTx` pre-hash and post-hash construction).
- `sendTransactionWithHooks(options)` runtime helper — collapses the
  whole "fire `onAwaitingSignature`, call `wallet.sendTransaction`,
  detect rejection, fire `onTransactionHash` (per-call + global)" block
  into one call so SDKs can adopt the lifecycle contract per write
  method in a one-liner.
- `WalletRejectedError` — typed `Error` subclass thrown by the helper
  on a user rejection; preserves the original error as `cause` so SDKs
  can rewrap to their own typed error vocabulary.
- Runtime dependency on `@valve-tech/viem-errors` for the
  three-signal rejection detection (EIP-1193 `code === 4001`, viem
  class name, message regex — anywhere in the cause chain).
