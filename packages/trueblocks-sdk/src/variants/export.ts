/**
 * Variant accessors for `/export`. The chifra export endpoint is
 * the most polymorphic in the daemon's surface — a 15-type union.
 * We mirror the Go SDK's `ExportOptions.Export*()` family with one
 * narrowed method per boolean flag, plus the `approvalsLogs` combo
 * (`approvals: true` + `logs: true`) that returns logs scoped to
 * approval transactions.
 */
import type { RequestFn } from '../client.js'
import type { components } from '../generated.js'
import { makeVerb, type Query, type VerbFn } from '../verbs.js'

type ExportQuery = Query<'/export'>
type Envelope<T> = { data?: T[] }

export interface ExportVerb extends VerbFn<'/export'> {
  /** `?appearances=true` — list of appearances only. */
  appearances: (
    query: Omit<ExportQuery, 'appearances'>,
  ) => Promise<Envelope<components['schemas']['appearance']>>
  /** `?receipts=true` — receipts instead of transactional data. */
  receipts: (
    query: Omit<ExportQuery, 'receipts'>,
  ) => Promise<Envelope<components['schemas']['receipt']>>
  /** `?logs=true` — logs instead of transactional data. */
  logs: (
    query: Omit<ExportQuery, 'logs'>,
  ) => Promise<Envelope<components['schemas']['log']>>
  /** `?approvals=true` — token approval transactions for the address. */
  approvals: (
    query: Omit<ExportQuery, 'approvals'>,
  ) => Promise<Envelope<components['schemas']['transaction']>>
  /** `?traces=true` — execution traces instead of transactional data. */
  traces: (
    query: Omit<ExportQuery, 'traces'>,
  ) => Promise<Envelope<components['schemas']['trace']>>
  /** `?neighbors=true` — neighbor addresses. */
  neighbors: (
    query: Omit<ExportQuery, 'neighbors'>,
  ) => Promise<Envelope<components['schemas']['message']>>
  /** `?statements=true` — only accounting statements. */
  statements: (
    query: Omit<ExportQuery, 'statements'>,
  ) => Promise<Envelope<components['schemas']['statement']>>
  /** `?transfers=true` — only ETH or token transfers. */
  transfers: (
    query: Omit<ExportQuery, 'transfers'>,
  ) => Promise<Envelope<components['schemas']['transfer']>>
  /** `?assets=true` — list of assets that appeared in transfers. */
  assets: (
    query: Omit<ExportQuery, 'assets'>,
  ) => Promise<Envelope<components['schemas']['name']>>
  /** `?balances=true` — ETH balance change history. */
  balances: (
    query: Omit<ExportQuery, 'balances'>,
  ) => Promise<Envelope<components['schemas']['token']>>
  /** `?withdrawals=true` — staking withdrawals for the address. */
  withdrawals: (
    query: Omit<ExportQuery, 'withdrawals'>,
  ) => Promise<Envelope<components['schemas']['withdrawal']>>
  /** `?count=true` (in appearances mode) — record count only. */
  count: (
    query: Omit<ExportQuery, 'count'>,
  ) => Promise<Envelope<components['schemas']['count']>>
  /**
   * `?approvals=true&logs=true` — logs emitted by approval
   * transactions for the address. Combo of the `approvals` and
   * `logs` flags; returns the same `Log[]` shape as `.logs()` but
   * filtered to approval-emitting txs.
   */
  approvalsLogs: (
    query: Omit<ExportQuery, 'approvals' | 'logs'>,
  ) => Promise<Envelope<components['schemas']['log']>>
}

export function makeExportVerb(request: RequestFn): ExportVerb {
  const base = makeVerb(request, '/export')

  const variant = <K extends keyof ExportQuery>(flag: K) =>
    (query: Omit<ExportQuery, K>) =>
      base({ ...(query as ExportQuery), [flag]: true }) as Promise<unknown>

  return Object.assign(base, {
    appearances: variant('appearances'),
    receipts: variant('receipts'),
    logs: variant('logs'),
    approvals: variant('approvals'),
    traces: variant('traces'),
    neighbors: variant('neighbors'),
    statements: variant('statements'),
    transfers: variant('transfers'),
    assets: variant('assets'),
    balances: variant('balances'),
    withdrawals: variant('withdrawals'),
    count: variant('count'),
    approvalsLogs: (query: Omit<ExportQuery, 'approvals' | 'logs'>) =>
      base({
        ...(query as ExportQuery),
        approvals: true,
        logs: true,
      }) as Promise<unknown>,
  }) as ExportVerb
}
