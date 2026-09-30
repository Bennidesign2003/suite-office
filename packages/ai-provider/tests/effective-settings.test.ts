import { describe, expect, it } from 'vitest'
import { defaultAiSettings, effectiveAiSettings } from '../src/providers'
import type { AiSettings } from '../src/types'

const withModel = (model: string, baseUrl = 'http://127.0.0.1:11434'): AiSettings => ({
  ...defaultAiSettings(),
  providers: { ollama: { apiKey: '', model, baseUrl } },
})

describe('effectiveAiSettings', () => {
  it('keeps the settings a request carries when they name a model', () => {
    const requested = withModel('llama3.2', 'http://gpu-box:11434')
    expect(effectiveAiSettings(requested, () => withModel('qwen3.5'))).toBe(requested)
  })

  it('uses the saved settings when a tab still holds its model-less startup copy', () => {
    const stored = withModel('qwen3.5:latest')
    expect(effectiveAiSettings(withModel(''), () => stored)).toBe(stored)
    expect(effectiveAiSettings(withModel('   '), () => stored)).toBe(stored)
    expect(effectiveAiSettings(undefined, () => stored)).toBe(stored)
  })

  it('reads the saved settings only when needed', () => {
    let reads = 0
    effectiveAiSettings(withModel('x'), () => {
      reads++
      return withModel('y')
    })
    expect(reads).toBe(0)
  })
})
