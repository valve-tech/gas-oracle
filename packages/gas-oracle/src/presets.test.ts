import { describe, expect, it } from 'vitest'
import { chainPresets, presetForChainId } from './presets.js'
import { PriorityModel } from './types.js'

describe('chainPresets', () => {
  it('has a pulsechain entry with chainId 369 and PriorityModel.flat', () => {
    expect(chainPresets.pulsechain).toBeDefined()
    expect(chainPresets.pulsechain.chainId).toBe(369)
    expect(chainPresets.pulsechain.priorityModel).toBe(PriorityModel.flat)
  })

  it('every entry carries a chainId', () => {
    for (const preset of Object.values(chainPresets)) {
      expect(typeof preset.chainId).toBe('number')
      expect(preset.chainId).toBeGreaterThan(0)
    }
  })
})

describe('presetForChainId', () => {
  it('returns the preset for a known chainId', () => {
    const preset = presetForChainId(369)
    expect(preset).toBe(chainPresets.pulsechain)
  })

  it('returns undefined for unknown chains', () => {
    expect(presetForChainId(1)).toBeUndefined()
    expect(presetForChainId(8453)).toBeUndefined()
  })
})
