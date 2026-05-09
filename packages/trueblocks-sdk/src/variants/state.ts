/**
 * Variant accessor for `/state`. Mirrors the Go SDK's
 * `StateOptions.StateCall()` (eth_call write-only query). The Go
 * SDK additionally exposes `StateSend()`, but the OpenAPI spec
 * doesn't expose a separate send flag — both end up at
 * `?call=true&calldata=...`, so we expose only `.call()` here. If
 * the caller needs send semantics, they pass appropriate
 * `calldata`.
 */
import type { RequestFn } from '../client.js'
import type { components } from '../generated.js'
import { makeVerb, type Query, type VerbFn } from '../verbs.js'

type StateQuery = Query<'/state'>
type Envelope<T> = { data?: T[] }

export interface StateVerb extends VerbFn<'/state'> {
  /**
   * `?call=true` — perform an `eth_call`-style read against the
   * given address. Returns the decoded `Result` shape rather than
   * the polymorphic state union.
   */
  call: (
    query: Omit<StateQuery, 'call'>,
  ) => Promise<Envelope<components['schemas']['result']>>
}

export function makeStateVerb(request: RequestFn): StateVerb {
  const base = makeVerb(request, '/state')
  return Object.assign(base, {
    call: (query: Omit<StateQuery, 'call'>) =>
      base({ ...(query as StateQuery), call: true }) as Promise<
        Envelope<components['schemas']['result']>
      >,
  }) as StateVerb
}
