# Changelog

All notable changes to `@valve-tech/wallet-adapter` are documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.15.0] — 2026-05-14

### Notes

- Synchronized release — no changes to this package. Republished at
  0.15.0 alongside the rest of the toolkit; the substantive changes
  are in `@valve-tech/tx-tracker` (mined-confirmed terminal transition,
  persisted-subscription dedup, first-party localStorage store,
  receipt-poll-fallback silent gate during capability probe) and
  `@valve-tech/chain-source` (new `Capabilities.ready: boolean` field).
  See the respective CHANGELOGs for details.

## [0.14.0] — 2026-05-14

### Notes

- Synchronized release — no changes to this package. Republished at
  0.14.0 alongside the rest of the toolkit; the substantive change
  is in `@valve-tech/tx-tracker` (new default-on `statusPollEveryBlocks`
  per-hash status poll via `eth_getTransactionByHash` + per-subscription
  `probeTransaction` fallback). See `@valve-tech/tx-tracker`'s
  CHANGELOG for details.

## [0.13.0] — 2026-05-12

### Notes

- Synchronized release — no changes to this package. Republished at
  0.13.0 alongside the rest of the toolkit; the substantive change
  is in `@valve-tech/tx-tracker` (new `TrackOptions.probeMined`
  consumer-supplied mined-detection probe). See
  `@valve-tech/tx-tracker`'s CHANGELOG for details.

## [0.12.0] — 2026-05-11

### Added

- Three more `examples/` covering wallet-plumbing classes the
  original five didn't reach (now 8 total):

  | Example | Covers | Helper |
  |---|---|---|
  | `06-ethers-adapter.ts` | ethers v6 `Signer` (`BrowserProvider.getSigner()` or `Wallet`). For dapps still on ethers or mid-migration to viem. | `walletAdapterFromEthersSigner(...)` |
  | `07-privy-embedded.ts` | Privy embedded wallets via `@privy-io/react-auth`'s `useWallets()`. Handles CAIP-2 chain encoding (`eip155:<id>`) and lazy provider fetching across wallet swaps. | `walletAdapterFromPrivyWallet(...)` |
  | `08-safe-multisig.ts` | Safe (Gnosis Safe) multisig via `@safe-global/protocol-kit` + `@safe-global/api-kit`. **Returns a safeTxHash, not an on-chain tx hash** — UIs have to fork to await the executed hash separately. File header documents the consumer-visible implications. | `walletAdapterFromSafe(...)` |

  Each follows the existing example shape (inline SDK type-stubs +
  no-network sanity check) so the files typecheck and run without
  any wallet libraries installed.

- README "Bridging a real wallet to `WalletAdapter`" table extended
  from 5 to 8 rows.

## [0.11.2] — 2026-05-11

### Notes

- Synchronized release — no changes to this package. Republished at
  0.11.2 alongside the rest of the toolkit; the substantive fix is
  in `@valve-tech/tx-tracker` (posture-consistency follow-up to
  v0.11.1 — two additional strict-null read sites on persisted
  `TxStatus` fields tightened defensively). See
  `@valve-tech/tx-tracker`'s CHANGELOG for details.

## [0.11.1] — 2026-05-11

### Notes

- Synchronized release — no changes to this package. Republished at
  0.11.1 alongside the rest of the toolkit; the substantive fix is
  in `@valve-tech/tx-tracker` (upgrade-path crash on the first
  block tick after upgrading a persistent store from ≤0.10 to
  0.11.0). See `@valve-tech/tx-tracker`'s CHANGELOG for details.

## [0.11.0] — 2026-05-11

### Added

- Five worked `examples/` covering the common wallet-plumbing classes
  — each is runnable end-to-end via a no-network fake transport, and
  documents the real `npm install` consumers would add to wire it up
  for production. `typecheck:examples` is wired into the package and
  the root workspace so all five are gated by CI.

  | Example | Covers | Helper |
  |---|---|---|
  | `01-reown-adapter.ts` | Reown / WalletConnect, MetaMask SDK, RainbowKit, raw `window.ethereum`, hardware wallets in-browser (Ledger Live / Trezor Suite). Universal EIP-1193 path. | `walletAdapterFromEip1193(...)` |
  | `02-wagmi-adapter.ts` | wagmi React stack — wraps `useWalletClient()`'s viem `WalletClient` directly. | `walletAdapterFromWalletClient(...)` |
  | `03-server-relayer.ts` | Backend signing via private key (env / KMS); hard-fail on cross-chain. | `walletAdapterFromRelayer(...)` |
  | `04-erc4337-smart-account.ts` | ERC-4337 account abstraction via permissionless.js or similar; `adapter.address` is the smart-account address. | `walletAdapterFromSmartAccount(...)` |
  | `05-hardware-wallet-direct.ts` | Direct USB/HID-attached Ledger via `@ledgerhq/hw-app-eth` (Trezor via `@trezor/connect` is the same shape). For backend / kiosk / dev tooling. | `walletAdapterFromLedger(...)` |

  Closes the long-standing "how do I make this work with Reown / wagmi
  / a smart account / a backend signer / a Ledger?" docs gap.

### Changed

- README "Quick start" gains a "Bridging a real wallet to
  `WalletAdapter`" subsection pointing at the five examples with a
  one-line "what each covers" table.

## [0.10.1] — 2026-05-08

Synchronized release — no changes to this package. Republished at
0.10.1 alongside the rest of the toolkit; v0.10.0 only got
trueblocks-sdk publishing wrong (missing `repository` field tripped
provenance validation), so the rest of the line had to bump to
re-sync.

## [0.10.0] — 2026-05-08

Synchronized release — no changes to this package. Republished at
0.10.0 alongside the rest of the toolkit. The minor bump (rather
than patch) reflects the addition of a new sibling package,
`@valve-tech/trueblocks-sdk`, to the synced release line.

## [0.9.3] — 2026-05-08

Synchronized release — no changes to this package. Republished at
0.9.3 alongside the rest of the toolkit so all six packages share
one synced version line on npm. v0.9.2 had published this package
successfully but skipped `tx-flight-react` (workflow file was
missing a publish step); v0.9.3 fixes that and re-publishes
everything from one tag.

## [0.9.2] — 2026-05-08

Synchronized release — no changes to this package. Companion fix
to v0.9.1: the root `build` script now uses `--topological-dev`
so workspace `devDependencies` (added to `tx-flight-react` in
v0.9.1) actually drive build ordering. First version of the v0.9.x
line on npm for this package, but the toolkit-wide v0.9.x line
didn't reach all six packages until v0.9.3.

## [0.9.1] — 2026-05-08

*Not published — the Release workflow's Build step failed for the
same reason as v0.9.0. Superseded by v0.9.2.* Synchronized release;
no changes to this package itself.

## [0.9.0] — 2026-05-08

Synchronized release — no changes to this package. Bumped in lockstep
with the rest of the toolkit, alongside the new
`@valve-tech/tx-flight-react` package. *Not published — the Release
workflow's build step failed before publish; superseded by v0.9.1.*

## [0.8.1] — 2026-05-07

Synchronized release — no changes to this package. Bumped in lockstep with the rest of the toolkit.

## [0.8.0] — 2026-05-06

Synced version bump; no functional changes.

## [0.7.0] — 2026-05-06

### Notes

- Synchronized release — no changes to this package. Bumped in
  lockstep with `@valve-tech/tx-tracker@0.7.0` (the first real
  implementation release of the per-tx state machine that
  wallet-adapter's `WriteHookParams` contract — `onTransactionHash`,
  `onDropped`, `onReplaced` — is designed to fire against).
  Consumers wiring tx-tracker into wallet-adapter writes will now
  see real `seen-in-block` / `replaced-by` / `unseen-for-N-blocks`
  events instead of stub no-ops.

## [0.6.0] — 2026-05-05

### Notes

- Synchronized release — no changes to this package. Bumped in
  lockstep with `@valve-tech/chain-source@0.6.0` (block-stream
  dedup + head-probe gating in the source tick) and
  `@valve-tech/gas-oracle@0.6.0` (now consumes ChainSource via
  `source?: ChainSource`).

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
