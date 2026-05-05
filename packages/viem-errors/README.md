# `@valve-tech/viem-errors`

Cause-chain-aware error utilities for viem-based dapps. Detect EIP-1193
user rejections, extract decoded custom Solidity error names from
anywhere in viem's nested error chain, map raw RPC/wallet/contract
errors to short user-friendly messages with overridable patterns, and
route wagmi-style `onError` sinks through one helper.

Pure functions, no runtime dependencies. viem is a peer dependency
(used only for the `Hex` type — the runtime is plain JS).

## Why

Every dapp re-implements wallet error handling, and most get it
slightly wrong:

- **Top-level message matching misses real rejections.** viem nests
  errors several layers deep (`ContractFunctionExecutionError` →
  `RpcRequestError` → `UserRejectedRequestError`). The wrapper's
  `.message` reads `"Failed to send transaction"` — looks like a
  generic failure, but the cause is actually a user rejection that
  should reset the UI to idle, not show a red error toast.
- **Decoded custom Solidity errors get hidden.** The wrapping message
  contains `"execution reverted"` so dapps short-circuit to a generic
  "transaction failed" message, ignoring the actual `data.errorName`
  (`HashMismatch`, `InsufficientLiquidity`, etc.) that viem decoded
  for them.
- **Generic copy is the same everywhere.** "Insufficient funds for
  gas", "previous transaction is still pending", "rate limited" — all
  re-derived per project from raw RPC strings.

This package solves all three at the primitive layer. Extend the
default error map with your protocol's custom errors; everything else
just works.

## Install

```sh
npm install @valve-tech/viem-errors viem
# or
yarn add @valve-tech/viem-errors viem
```

## Quick start

### Detect a wallet rejection

```ts
import { isUserRejectionError } from '@valve-tech/viem-errors'

try {
  await wallet.sendTransaction(tx)
} catch (err) {
  if (isUserRejectionError(err)) {
    // Reset to idle. Do NOT show a "transaction failed" error.
    return
  }
  throw err
}
```

### Centralised error handling for wagmi `onError`

```ts
import { handleWalletError } from '@valve-tech/viem-errors'

const { writeAsync } = useContractWrite({
  // ...
  onError: (err) => handleWalletError(err, {
    setStatus,
    setErrorMessage: setError,
    toast,
    onError: (e) => analytics.track('write.error', { message: e.message }),
    customErrors: {
      HashMismatch: 'The proof did not match the deposit.',
      InsufficientLiquidity: 'Not enough liquidity for this trade.',
    },
  }),
})
```

### Extract a decoded custom error

```ts
import { extractContractErrorName } from '@valve-tech/viem-errors'

catch (err) {
  const name = extractContractErrorName(err)
  if (name === 'IntentExpired') {
    promptUserToRefresh()
    return
  }
  // ...
}
```

## API

| Export | Shape |
| --- | --- |
| `walkErrorCause(error, opts?)` | Generator yielding `error` then each link in its `.cause` chain (default `maxDepth: 8`). |
| `isUserRejectionError(error)` | `true` if any link has EIP-1193 `code === 4001`, name `UserRejectedRequestError`, or matches the rejection-message regex. |
| `USER_REJECTION_MESSAGE` | Toast-friendly rejection copy. |
| `extractContractErrorName(error)` | First valid Solidity error name from `data.errorName` in the cause chain, else `null`. |
| `extractContractErrorNameFromMessage(raw)` | Scrape viem's `"reverted with the following reason:\n<Name>"` format from a flattened message string. |
| `getUserFriendlyErrorMessage(error, opts?)` | Short user-facing message. Pipeline: rejection → decoded custom error → consumer patterns → default patterns → fallback. |
| `DEFAULT_ERROR_PATTERNS` | Protocol-agnostic patterns covering wallet/gas/network/RPC/rate-limit/revert. |
| `handleWalletError(error, opts)` | Apply `getUserFriendlyErrorMessage` + sinks (`setStatus`, `setErrorMessage`, `toast`, `onError`). |

## Design notes

- **`walkErrorCause` is a generator.** Consumers can break early without
  scanning the whole chain. Default depth of 8 caps a circular cause
  reference instead of looping forever.
- **`isUserRejectionError` checks three signals at every link.** Any one of
  `code === 4001` / class name / message regex is sufficient. Three
  signals exist because no single one is reliable across every wallet
  + version on the wire.
- **`getUserFriendlyErrorMessage` puts rejection detection FIRST.** A 4001
  buried in a wrapper whose top-level message contains "execution
  reverted" must still produce the cancelled-by-user copy.
- **Default patterns are deliberately protocol-agnostic.** Custom-error
  copy (`HashMismatch` → "Proof did not match the deposit") belongs
  in your dapp's `customErrors` map, not in this package.

## License

MIT
