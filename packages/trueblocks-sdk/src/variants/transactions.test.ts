import { describe, expect, it, vi } from 'vitest'

import type { RequestFn } from '../client.js'
import { makeTransactionsVerb } from './transactions.js'

describe('makeTransactionsVerb', () => {
  it('base call forwards /transactions request unchanged', async () => {
    const request = vi.fn().mockResolvedValue({ data: [] })
    const tx = makeTransactionsVerb(request as unknown as RequestFn)

    await tx({ transactions: ['18000000.1'] })

    expect(request).toHaveBeenCalledWith('/transactions', {
      transactions: ['18000000.1'],
    })
  })

  const variantCases: Array<
    [keyof ReturnType<typeof makeTransactionsVerb>, string]
  > = [
    ['traces', 'traces'],
    ['uniq', 'uniq'],
    ['logs', 'logs'],
  ]

  it.each(variantCases)(
    '%s variant sets %s=true',
    async (variantName, flag) => {
      const request = vi.fn().mockResolvedValue({ data: [] })
      const tx = makeTransactionsVerb(request as unknown as RequestFn)
      const fn = tx[variantName] as (q: {
        transactions: string[]
      }) => Promise<unknown>

      await fn({ transactions: ['18000000.1'] })

      expect(request).toHaveBeenCalledWith('/transactions', {
        transactions: ['18000000.1'],
        [flag]: true,
      })
    },
  )
})
