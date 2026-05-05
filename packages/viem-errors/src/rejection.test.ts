import { describe, it, expect } from 'vitest'
import { isUserRejectionError, USER_REJECTION_MESSAGE } from './rejection.js'

describe('isUserRejectionError', () => {
  it('detects EIP-1193 code 4001 at the top level', () => {
    expect(isUserRejectionError({ code: 4001, message: 'rejected' })).toBe(true)
  })

  it('detects EIP-1193 code 4001 nested in the cause chain', () => {
    const inner: { code: number } = { code: 4001 }
    const outer = Object.assign(new Error('Failed to send transaction'), { cause: inner })
    expect(isUserRejectionError(outer)).toBe(true)
  })

  it('detects viem UserRejectedRequestError by class name', () => {
    class UserRejectedRequestError extends Error {
      constructor() { super('User rejected') }
    }
    const e = new UserRejectedRequestError()
    e.name = 'UserRejectedRequestError'
    expect(isUserRejectionError(e)).toBe(true)
  })

  it('detects rejection via wallet message regex (4001 unset, no class name)', () => {
    expect(isUserRejectionError(new Error('User rejected the request.'))).toBe(true)
    expect(isUserRejectionError(new Error('User denied transaction signature.'))).toBe(true)
    expect(isUserRejectionError(new Error('user cancelled'))).toBe(true)
    expect(isUserRejectionError(new Error('User disapproved the request'))).toBe(true)
  })

  it('matches a string thrown directly that contains the rejection phrase', () => {
    expect(isUserRejectionError('User rejected the request')).toBe(true)
  })

  it('returns false for unrelated errors', () => {
    expect(isUserRejectionError(new Error('insufficient funds for gas'))).toBe(false)
    expect(isUserRejectionError(new Error('execution reverted'))).toBe(false)
    expect(isUserRejectionError({ code: -32000, message: 'invalid args' })).toBe(false)
  })

  it('returns false for null / undefined / primitives that do not match', () => {
    expect(isUserRejectionError(null)).toBe(false)
    expect(isUserRejectionError(undefined)).toBe(false)
    expect(isUserRejectionError(42)).toBe(false)
    expect(isUserRejectionError('something else broke')).toBe(false)
  })

  it('walks past a wrapper whose top-level message is generic to find the underlying rejection', () => {
    // Mirrors viem's real shape: ContractFunctionExecutionError → RpcRequestError → UserRejectedRequestError
    const eip1193: { code: number; message: string } = { code: 4001, message: 'User rejected the request.' }
    const rpcWrapper = Object.assign(new Error('RPC Request failed.'), { cause: eip1193 })
    const contractWrapper = Object.assign(new Error('The contract function "signalIntent" reverted.'), { cause: rpcWrapper })

    expect(isUserRejectionError(contractWrapper)).toBe(true)
  })
})

describe('USER_REJECTION_MESSAGE', () => {
  it('is a non-empty string suitable for a toast / inline label', () => {
    expect(typeof USER_REJECTION_MESSAGE).toBe('string')
    expect(USER_REJECTION_MESSAGE.length).toBeGreaterThan(0)
  })
})
