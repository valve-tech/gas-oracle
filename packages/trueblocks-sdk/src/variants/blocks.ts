/**
 * Variant accessors for `/blocks`. The chifra blocks endpoint is
 * polymorphic — depending on which boolean flag is set on the
 * request, it returns a different shape from a 10-type union. This
 * module wraps the base endpoint with one method per flag, each
 * with a concrete (non-union) return type, mirroring the Go SDK's
 * `BlocksOptions.Blocks*()` family.
 *
 * Base call (no variant) preserves the polymorphic union — useful
 * when the caller is constructing flag combos at runtime.
 */
import type { RequestFn } from '../client.js'
import type { components } from '../generated.js'
import { makeVerb, type Query, type VerbFn } from '../verbs.js'

type BlocksQuery = Query<'/blocks'>

/** Envelope shape mirroring the OpenAPI `200 application/json` body. */
type Envelope<T> = { data?: T[] }

export interface BlocksVerb extends VerbFn<'/blocks'> {
  /**
   * `GET /blocks?hashes=true` — returns lightweight blocks with
   * transaction hashes only (no full transaction bodies).
   */
  hashes: (
    query: Omit<BlocksQuery, 'hashes'>,
  ) => Promise<Envelope<components['schemas']['lightBlock']>>

  /**
   * `GET /blocks?uncles=true` — returns uncle blocks (if any) for
   * the requested block instead of the canonical block.
   */
  uncles: (
    query: Omit<BlocksQuery, 'uncles'>,
  ) => Promise<Envelope<components['schemas']['lightBlock']>>

  /**
   * `GET /blocks?traces=true` — returns the execution traces
   * generated within the requested block(s).
   */
  traces: (
    query: Omit<BlocksQuery, 'traces'>,
  ) => Promise<Envelope<components['schemas']['trace']>>

  /**
   * `GET /blocks?uniq=true` — returns the unique address
   * appearances within the requested block(s).
   */
  uniq: (
    query: Omit<BlocksQuery, 'uniq'>,
  ) => Promise<Envelope<components['schemas']['appearance']>>

  /**
   * `GET /blocks?logs=true` — returns the event logs emitted within
   * the requested block(s).
   */
  logs: (
    query: Omit<BlocksQuery, 'logs'>,
  ) => Promise<Envelope<components['schemas']['log']>>

  /**
   * `GET /blocks?withdrawals=true` — returns the post-Shanghai
   * staking withdrawals contained in the requested block(s).
   */
  withdrawals: (
    query: Omit<BlocksQuery, 'withdrawals'>,
  ) => Promise<Envelope<components['schemas']['withdrawal']>>

  /**
   * `GET /blocks?count=true` — returns counts of appearances per
   * block without the full appearance data.
   */
  count: (
    query: Omit<BlocksQuery, 'count'>,
  ) => Promise<Envelope<components['schemas']['blockCount']>>
}

/**
 * Builds the `/blocks` verb with its variant accessors. The base
 * verb (callable directly) returns the OpenAPI polymorphic union;
 * the attached methods narrow to a single response type by
 * preselecting the corresponding boolean flag.
 */
export function makeBlocksVerb(request: RequestFn): BlocksVerb {
  const base = makeVerb(request, '/blocks')

  // The casts to BlocksVerb's variant signatures are safe because
  // chifra guarantees the response shape matches the flag we set.
  // Defensive callers can still pass `withReceipts` or other flags
  // alongside the variant flag in the query.
  return Object.assign(base, {
    hashes: (query: Omit<BlocksQuery, 'hashes'>) =>
      base({ ...(query as BlocksQuery), hashes: true }) as Promise<
        Envelope<components['schemas']['lightBlock']>
      >,
    uncles: (query: Omit<BlocksQuery, 'uncles'>) =>
      base({ ...(query as BlocksQuery), uncles: true }) as Promise<
        Envelope<components['schemas']['lightBlock']>
      >,
    traces: (query: Omit<BlocksQuery, 'traces'>) =>
      base({ ...(query as BlocksQuery), traces: true }) as Promise<
        Envelope<components['schemas']['trace']>
      >,
    uniq: (query: Omit<BlocksQuery, 'uniq'>) =>
      base({ ...(query as BlocksQuery), uniq: true }) as Promise<
        Envelope<components['schemas']['appearance']>
      >,
    logs: (query: Omit<BlocksQuery, 'logs'>) =>
      base({ ...(query as BlocksQuery), logs: true }) as Promise<
        Envelope<components['schemas']['log']>
      >,
    withdrawals: (query: Omit<BlocksQuery, 'withdrawals'>) =>
      base({ ...(query as BlocksQuery), withdrawals: true }) as Promise<
        Envelope<components['schemas']['withdrawal']>
      >,
    count: (query: Omit<BlocksQuery, 'count'>) =>
      base({ ...(query as BlocksQuery), count: true }) as Promise<
        Envelope<components['schemas']['blockCount']>
      >,
  }) as BlocksVerb
}
