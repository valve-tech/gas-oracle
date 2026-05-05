import { describe, it, expect } from 'vitest'
import { extractContractErrorName, extractContractErrorNameFromMessage } from './contract-error.js'

describe('extractContractErrorName', () => {
  it('finds errorName at the top level on data.errorName', () => {
    const e = { data: { errorName: 'InsufficientLiquidity' } }
    expect(extractContractErrorName(e)).toBe('InsufficientLiquidity')
  })

  it('finds errorName nested in the cause chain', () => {
    const inner = { data: { errorName: 'HashMismatch' } }
    const outer = Object.assign(new Error('execution reverted'), { cause: inner })
    expect(extractContractErrorName(outer)).toBe('HashMismatch')
  })

  it('returns null when no errorName is present anywhere', () => {
    expect(extractContractErrorName(new Error('something else'))).toBeNull()
    expect(extractContractErrorName({ data: {} })).toBeNull()
    expect(extractContractErrorName({ data: { errorName: 123 } })).toBeNull()
  })

  it('returns null for null / undefined / primitives', () => {
    expect(extractContractErrorName(null)).toBeNull()
    expect(extractContractErrorName(undefined)).toBeNull()
    expect(extractContractErrorName('a string')).toBeNull()
    expect(extractContractErrorName(42)).toBeNull()
  })

  it('rejects non-PascalCase or otherwise malformed names', () => {
    // Solidity custom error names always begin with an uppercase letter
    // and contain only [A-Za-z0-9_]. Reject anything else to avoid false
    // positives from arbitrary string fields named "errorName".
    expect(extractContractErrorName({ data: { errorName: 'lowercaseStart' } })).toBeNull()
    expect(extractContractErrorName({ data: { errorName: 'Has Space' } })).toBeNull()
    expect(extractContractErrorName({ data: { errorName: '' } })).toBeNull()
  })
})

describe('extractContractErrorNameFromMessage', () => {
  it('extracts the error name from viem’s reverted-with-reason format', () => {
    const raw = 'The contract function "signalIntent" reverted with the following reason:\nPaymentVerificationFailed()\n\nContract Call: ...'
    expect(extractContractErrorNameFromMessage(raw)).toBe('PaymentVerificationFailed')
  })

  it('extracts even when the error has no parens', () => {
    const raw = 'reverted with the following reason:\nHashMismatch'
    expect(extractContractErrorNameFromMessage(raw)).toBe('HashMismatch')
  })

  it('returns null when the format does not match', () => {
    expect(extractContractErrorNameFromMessage('something else')).toBeNull()
    expect(extractContractErrorNameFromMessage('')).toBeNull()
  })
})
