/**
 * Error class for failures originating from the chifra daemon, or
 * from the network transport between this client and the daemon.
 *
 * - `path` always holds the chifra endpoint that failed
 *   (e.g. `'/status'`, `'/blocks'`).
 * - `status` is set when the daemon responded with a non-2xx HTTP
 *   status; absent when the failure was at the transport layer
 *   (DNS, connection refused, fetch threw).
 * - `cause` is set when wrapping a transport-layer error so callers
 *   can drill into the original failure if needed.
 */
export class TrueblocksError extends Error {
  readonly path: string
  readonly status?: number

  constructor(
    message: string,
    init: { path: string; status?: number; cause?: unknown },
  ) {
    super(message)
    this.name = 'TrueblocksError'
    this.path = init.path
    this.status = init.status
    if (init.cause !== undefined) {
      // ES2022 Error.cause; assigned post-super for ES2020 target compat.
      ;(this as { cause?: unknown }).cause = init.cause
    }
  }
}
