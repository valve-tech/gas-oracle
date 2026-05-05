# Changelog

All notable changes to `@valve-tech/viem-errors` are documented in
this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Initial implementation. Functions extracted from a real-world dapp
  (Provex) where they had been re-derived inline; this is the first
  upstream packaging for general use.
  - `walkErrorCause(error, options?)` — generator over the viem
    cause chain. Default `maxDepth: 8`.
  - `isUserRejectionError(error)` — three-signal check across the
    cause chain (EIP-1193 `code === 4001`, class name
    `UserRejectedRequestError`, message regex fallback).
  - `USER_REJECTION_MESSAGE` — default rejection copy.
  - `extractContractErrorName(error)` — finds decoded custom
    Solidity error names on `data.errorName` anywhere in the cause
    chain.
  - `extractContractErrorNameFromMessage(raw)` — scrape fallback for
    flattened messages.
  - `getUserFriendlyErrorMessage(error, options?)` — pipeline:
    rejection → decoded custom error → consumer patterns → default
    patterns → fallback.
  - `DEFAULT_ERROR_PATTERNS` — protocol-agnostic patterns
    (wallet / gas / replacement / network / rate-limit / revert).
  - `handleWalletError(error, options)` — wagmi `onError`-shape
    sink with separate rejection vs real-error paths.
- 49 unit tests covering cause-chain traversal, rejection detection,
  custom-error extraction, message mapping, override precedence, and
  sink routing.
