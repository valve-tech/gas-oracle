/**
 * Variant accessors for `/slurp`. Two narrowed modes (`appearances`,
 * `count`) plus the base call. `count` is only valid in
 * `appearances` mode per the chifra docs — the variant sets both.
 */
import type { RequestFn } from '../client.js'
import type { components } from '../generated.js'
import { makeVerb, type Query, type VerbFn } from '../verbs.js'

type SlurpQuery = Query<'/slurp'>
type Envelope<T> = { data?: T[] }

export interface SlurpVerb extends VerbFn<'/slurp'> {
  /** `?appearances=true` — return only blocknumber.tx_id appearances. */
  appearances: (
    query: Omit<SlurpQuery, 'appearances'>,
  ) => Promise<Envelope<components['schemas']['appearance']>>
  /** `?appearances=true&count=true` — count of slurped appearances only. */
  count: (
    query: Omit<SlurpQuery, 'appearances' | 'count'>,
  ) => Promise<Envelope<components['schemas']['count']>>
}

export function makeSlurpVerb(request: RequestFn): SlurpVerb {
  const base = makeVerb(request, '/slurp')
  return Object.assign(base, {
    appearances: (query: Omit<SlurpQuery, 'appearances'>) =>
      base({ ...(query as SlurpQuery), appearances: true }) as Promise<
        Envelope<components['schemas']['appearance']>
      >,
    count: (query: Omit<SlurpQuery, 'appearances' | 'count'>) =>
      base({
        ...(query as SlurpQuery),
        appearances: true,
        count: true,
      }) as Promise<Envelope<components['schemas']['count']>>,
  }) as SlurpVerb
}
