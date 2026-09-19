import { describe, expect, it } from 'vitest'
import {
  AI_PROVIDER_ADAPTERS,
  getProviderAdapter,
  modelEchoesReasoning,
  modelHasFixedSampling,
  modelLacksVision,
} from '../src/registry'
import type { AiProviderConfig } from '../src/types'

function config(model: string, baseUrl?: string): AiProviderConfig {
  return { apiKey: '', model, ...(baseUrl !== undefined ? { baseUrl } : {}) }
}

describe('provider registry', () => {
  it('holds exactly one adapter', () => {
    expect(Object.keys(AI_PROVIDER_ADAPTERS)).toEqual(['ollama'])
  })

  it('routes to the daemon OpenAI-compatible surface by default', () => {
    expect(getProviderAdapter('ollama').resolveEndpoint(config('llama3.2'))).toEqual({
      protocol: 'openai-compatible',
      baseUrl: 'http://127.0.0.1:11434/v1',
    })
  })

  it('honours a custom host and normalizes how it was typed', () => {
    for (const typed of ['http://box:11434', 'http://box:11434/', 'http://box:11434/v1']) {
      expect(getProviderAdapter('ollama').resolveEndpoint(config('m', typed)).baseUrl).toBe(
        'http://box:11434/v1',
      )
    }
  })

  it('throws on an id a hand-edited settings file invented', () => {
    expect(() => getProviderAdapter('anthropic' as never)).toThrow('Unknown provider')
  })
})

describe('model traits', () => {
  it('never omits temperature — the daemon owns sampling', () => {
    expect(modelHasFixedSampling('gpt-oss:20b')).toBe(false)
    expect(modelHasFixedSampling('qwen3.5:latest')).toBe(false)
  })

  it('never echoes reasoning back: the compatible surface has no field for it', () => {
    expect(modelEchoesReasoning('deepseek-r1:8b')).toBe(false)
  })

  it('recognizes the vision-capable local model families', () => {
    for (const m of [
      'llava:13b',
      'llama3.2-vision:11b',
      'qwen2.5vl:7b',
      'qwen3.5:latest',
      'gemma3:12b',
      'minicpm-v:8b',
      'moondream:latest',
    ]) {
      expect(modelLacksVision(m), m).toBe(false)
    }
  })

  it('treats a text-only model as unable to take screenshots', () => {
    for (const m of ['llama3.2:3b', 'mistral:7b', 'phi4:latest', 'deepseek-r1:8b']) {
      expect(modelLacksVision(m), m).toBe(true)
    }
  })
})
