/**
 * Variant accessor for `/traces`. The chifra traces endpoint has
 * one obvious narrowed-output mode (`count`); base call retains the
 * polymorphic union for callers using `filter` or other flags.
 */
import type { RequestFn } from '../client.js'
import type { components } from '../generated.js'
import { makeVerb, type Query, type VerbFn } from '../verbs.js'

type TracesQuery = Query<'/traces'>
type Envelope<T> = { data?: T[] }

export interface TracesVerb extends VerbFn<'/traces'> {
  /** `?count=true` — return only the trace count for the transaction(s). */
  count: (
    query: Omit<TracesQuery, 'count'>,
  ) => Promise<Envelope<components['schemas']['traceCount']>>
}

export function makeTracesVerb(request: RequestFn): TracesVerb {
  const base = makeVerb(request, '/traces')
  return Object.assign(base, {
    count: (query: Omit<TracesQuery, 'count'>) =>
      base({ ...(query as TracesQuery), count: true }) as Promise<
        Envelope<components['schemas']['traceCount']>
      >,
  }) as TracesVerb
}
