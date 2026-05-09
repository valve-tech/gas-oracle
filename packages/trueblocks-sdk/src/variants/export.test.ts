import { describe, expect, it, vi } from 'vitest'

import type { RequestFn } from '../client.js'
import { makeExportVerb } from './export.js'

describe('makeExportVerb', () => {
  it('base call forwards /export request unchanged', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] })
    const exp = makeExportVerb(request as unknown as RequestFn)

    await exp({ addrs: ['0xabc'] })

    expect(request).toHaveBeenCalledWith('/export', { addrs: ['0xabc'] })
  })

  // Each variant just sets <flag>=true on top of the caller-supplied query.
  const variantCases: Array<keyof ReturnType<typeof makeExportVerb>> = [
    'appearances',
    'receipts',
    'logs',
    'approvals',
    'traces',
    'neighbors',
    'statements',
    'transfers',
    'assets',
    'balances',
    'withdrawals',
    'count',
  ]

  it.each(variantCases)('%s variant sets %s=true', async (variantName) => {
    const request = vi.fn().mockResolvedValue({ data: [] })
    const exp = makeExportVerb(request as unknown as RequestFn)
    const fn = exp[variantName] as (q: {
      addrs: string[]
    }) => Promise<unknown>

    await fn({ addrs: ['0xabc'] })

    expect(request).toHaveBeenCalledWith('/export', {
      addrs: ['0xabc'],
      [variantName]: true,
    })
  })

  it('approvalsLogs combo sets both approvals=true and logs=true', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] })
    const exp = makeExportVerb(request as unknown as RequestFn)

    await exp.approvalsLogs({ addrs: ['0xabc'] })

    expect(request).toHaveBeenCalledWith('/export', {
      addrs: ['0xabc'],
      approvals: true,
      logs: true,
    })
  })
})
