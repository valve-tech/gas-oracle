/**
 * Variant accessors for `/transactions`. Mirrors the Go SDK's
 * `TransactionsOptions.Transactions*()` family — base call returns
 * the polymorphic union; attached methods preselect a flag and
 * narrow the return.
 */
import type { RequestFn } from '../client.js'
import type { components } from '../generated.js'
import { makeVerb, type Query, type VerbFn } from '../verbs.js'

type TxQuery = Query<'/transactions'>
type Envelope<T> = { data?: T[] }

export interface TransactionsVerb extends VerbFn<'/transactions'> {
  /** `?traces=true` — return the transaction's execution traces. */
  traces: (
    query: Omit<TxQuery, 'traces'>,
  ) => Promise<Envelope<components['schemas']['trace']>>
  /** `?uniq=true` — return the unique address appearances within the transaction. */
  uniq: (
    query: Omit<TxQuery, 'uniq'>,
  ) => Promise<Envelope<components['schemas']['appearance']>>
  /** `?logs=true` — return only the event logs emitted by the transaction. */
  logs: (
    query: Omit<TxQuery, 'logs'>,
  ) => Promise<Envelope<components['schemas']['log']>>
}

export function makeTransactionsVerb(request: RequestFn): TransactionsVerb {
  const base = makeVerb(request, '/transactions')
  return Object.assign(base, {
    traces: (query: Omit<TxQuery, 'traces'>) =>
      base({ ...(query as TxQuery), traces: true }) as Promise<
        Envelope<components['schemas']['trace']>
      >,
    uniq: (query: Omit<TxQuery, 'uniq'>) =>
      base({ ...(query as TxQuery), uniq: true }) as Promise<
        Envelope<components['schemas']['appearance']>
      >,
    logs: (query: Omit<TxQuery, 'logs'>) =>
      base({ ...(query as TxQuery), logs: true }) as Promise<
        Envelope<components['schemas']['log']>
      >,
  }) as TransactionsVerb
}
