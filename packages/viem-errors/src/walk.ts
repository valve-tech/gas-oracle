/**
 * @fileoverview Walk an error's `cause` chain.
 *
 * viem nests errors several levels deep — `ContractFunctionExecutionError`
 * wraps `RpcRequestError` wraps `UserRejectedRequestError`, etc. — so checks
 * that only inspect the top-level error miss the actual underlying cause.
 * This generator yields each link in order so callers can decide what to look
 * for at each depth.
 */

/**
 * Walk an error and its `cause` chain, yielding each link in order, starting
 * with the error itself. Stops at `null`/`undefined`, when the chain hits a
 * primitive that has no `cause`, or when `maxDepth` is reached. Default depth
 * is 8 — enough for every viem stack we've seen in the wild without risking
 * a runaway loop on a circular chain.
 *
 * @example
 * ```ts
 * for (const link of walkErrorCause(error)) {
 *   if (typeof link === 'object' && link && 'code' in link && link.code === 4001) {
 *     return true
 *   }
 * }
 * ```
 */
export function* walkErrorCause(
  error: unknown,
  options: { maxDepth?: number } = {},
): Generator<unknown, void, unknown> {
  const maxDepth = options.maxDepth ?? 8
  let current: unknown = error
  for (let depth = 0; depth < maxDepth; depth++) {
    if (current === null || current === undefined) return
    yield current
    if (typeof current !== 'object') return
    current = (current as { cause?: unknown }).cause
  }
}
