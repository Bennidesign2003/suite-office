import { describe, expect, it } from 'vitest'
import {
  AI_PROVIDERS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  activeProvider,
  aiConfigured,
  clampMaxOutputTokens,
  defaultAiSettings,
  maxOutputTokensOf,
  resolveAiSettings,
} from '../src/providers'
import { OLLAMA_DEFAULT_HOST } from '../src/types'

describe('AI_PROVIDERS', () => {
  it('is Ollama and nothing else', () => {
    expect(AI_PROVIDERS.map((p) => p.id)).toEqual(['ollama'])
  })

  it('ships no model list — the catalog is read from the daemon', () => {
    expect(AI_PROVIDERS[0].models).toEqual([])
    expect(AI_PROVIDERS[0].defaultModel).toBe('')
  })
})

describe('defaultAiSettings', () => {
  it('points at the local daemon with no model chosen yet', () => {
    const s = defaultAiSettings()
    expect(s.provider).toBe('ollama')
    expect(s.providers.ollama).toEqual({
      apiKey: '',
      model: '',
      baseUrl: OLLAMA_DEFAULT_HOST,
    })
  })
})

describe('aiConfigured', () => {
  it('needs a non-blank model', () => {
    const s = defaultAiSettings()
    expect(aiConfigured(s)).toBe(false)
    s.providers.ollama.model = '   '
    expect(aiConfigured(s)).toBe(false)
    s.providers.ollama.model = 'qwen3.5:latest'
    expect(aiConfigured(s)).toBe(true)
  })

  it('does not change which provider is active — there is only one', () => {
    expect(activeProvider(defaultAiSettings())).toBe('ollama')
  })
})

describe('resolveAiSettings', () => {
  it('fills defaults for an empty file', () => {
    expect(resolveAiSettings({})).toEqual(defaultAiSettings())
  })

  it('trims the stored key, model and host', () => {
    const s = resolveAiSettings({
      providers: {
        ollama: { apiKey: ' k ', model: ' llama3.2 ', baseUrl: ' http://box:11434/v1/ ' },
      },
    } as never)
    expect(s.providers.ollama).toEqual({
      apiKey: 'k',
      model: 'llama3.2',
      // the /v1 suffix and trailing slash are normalized off the daemon root
      baseUrl: 'http://box:11434',
    })
  })

  it('adopts an upstream custom endpoint that pointed at a local Ollama', () => {
    const s = resolveAiSettings({
      provider: 'custom',
      providers: {
        anthropic: { apiKey: 'sk-ant-secret', model: 'claude-sonnet-5' },
        custom: { apiKey: '', model: 'llama3.2', baseUrl: 'http://localhost:11434/v1' },
      },
    } as never)
    expect(s.providers.ollama.model).toBe('llama3.2')
    expect(s.providers.ollama.baseUrl).toBe('http://localhost:11434')
    // cloud credentials are deliberately not carried into a local-only product
    expect(JSON.stringify(s)).not.toContain('sk-ant-secret')
  })

  it('ignores an upstream custom endpoint that pointed at a hosted vendor', () => {
    const s = resolveAiSettings({
      provider: 'custom',
      providers: {
        custom: { apiKey: 'sk-1', model: 'gpt-5.6-sol', baseUrl: 'https://api.openai.com/v1' },
      },
    } as never)
    expect(s.providers.ollama.model).toBe('')
    expect(s.providers.ollama.baseUrl).toBe(OLLAMA_DEFAULT_HOST)
  })

  it('migrates the pre-provider single-endpoint shape', () => {
    const s = resolveAiSettings({ baseUrl: 'http://127.0.0.1:11434', model: 'mistral' })
    expect(s.providers.ollama.model).toBe('mistral')
    expect(s.providers.ollama.baseUrl).toBe('http://127.0.0.1:11434')
  })

  it('always reports ollama as the provider, whatever the file says', () => {
    expect(resolveAiSettings({ provider: 'anthropic' } as never).provider).toBe('ollama')
  })

  it('clamps a hand-edited output cap on read', () => {
    expect(resolveAiSettings({ maxOutputTokens: 10 ** 9 }).maxOutputTokens).toBe(
      MAX_MAX_OUTPUT_TOKENS,
    )
    expect(resolveAiSettings({ maxOutputTokens: 1 }).maxOutputTokens).toBe(MIN_MAX_OUTPUT_TOKENS)
  })
})

describe('output cap helpers', () => {
  it('clamps into range and falls back on garbage', () => {
    expect(clampMaxOutputTokens(4096)).toBe(4096)
    expect(clampMaxOutputTokens(0)).toBe(MIN_MAX_OUTPUT_TOKENS)
    expect(clampMaxOutputTokens(10 ** 9)).toBe(MAX_MAX_OUTPUT_TOKENS)
    expect(clampMaxOutputTokens('nope')).toBe(DEFAULT_MAX_OUTPUT_TOKENS)
    expect(clampMaxOutputTokens(Number.NaN)).toBe(DEFAULT_MAX_OUTPUT_TOKENS)
  })

  it('reads the effective cap off a settings object', () => {
    expect(maxOutputTokensOf(null)).toBe(DEFAULT_MAX_OUTPUT_TOKENS)
    expect(maxOutputTokensOf({ maxOutputTokens: undefined })).toBe(DEFAULT_MAX_OUTPUT_TOKENS)
    expect(maxOutputTokensOf({ maxOutputTokens: 2048 })).toBe(2048)
  })
})
