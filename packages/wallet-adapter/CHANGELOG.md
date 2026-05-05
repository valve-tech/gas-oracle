# Changelog

All notable changes to `@valve-tech/wallet-adapter` are documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

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
