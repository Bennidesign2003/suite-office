import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  fetchOllamaCatalog,
  formatModelSize,
  ollamaHost,
  ollamaOpenAiBaseUrl,
  pickDefaultModel,
} from '../src/ollama'
import type { OllamaModelInfo } from '../src/types'
import { jsonResponse } from './test-utils'

afterEach(() => vi.unstubAllGlobals())

/** one entry shaped like GET /api/tags actually answers */
function tag(name: string, capabilities: string[], size = 1e9) {
  return {
    name,
    model: name,
    size,
    capabilities,
    details: { parameter_size: '9.7B', quantization_level: 'Q4_K_M', context_length: 262144 },
  }
}

describe('ollamaHost', () => {
  it('defaults to the loopback daemon', () => {
    expect(ollamaHost(undefined)).toBe('http://127.0.0.1:11434')
    expect(ollamaHost('')).toBe('http://127.0.0.1:11434')
    expect(ollamaHost('   ')).toBe('http://127.0.0.1:11434')
  })

  it('accepts the daemon root however the user typed it', () => {
    expect(ollamaHost('http://box:11434/v1')).toBe('http://box:11434')
    expect(ollamaHost('http://box:11434///')).toBe('http://box:11434')
    expect(ollamaOpenAiBaseUrl('http://box:11434')).toBe('http://box:11434/v1')
  })
})

describe('fetchOllamaCatalog', () => {
  it('reads the installed models and the daemon version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, _init?: RequestInit) =>
        url.endsWith('/api/version')
          ? jsonResponse({ version: '0.32.4' })
          : jsonResponse({
              models: [tag('qwen3.5:latest', ['vision', 'completion', 'tools', 'thinking'])],
            }),
      ),
    )
    const catalog = await fetchOllamaCatalog()
    expect(catalog.reachable).toBe(true)
    expect(catalog.version).toBe('0.32.4')
    expect(catalog.models).toEqual([
      {
        name: 'qwen3.5:latest',
        parameterSize: '9.7B',
        quantization: 'Q4_K_M',
        contextLength: 262144,
        sizeBytes: 1e9,
        capabilities: ['vision', 'completion', 'tools', 'thinking'],
        vision: true,
        tools: true,
        thinking: true,
      },
    ])
  })

  it('still lists models when the daemon is too old for /api/version', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, _init?: RequestInit) =>
        url.endsWith('/api/version')
          ? new Response('not found', { status: 404 })
          : jsonResponse({ models: [tag('llama3.2:3b', ['completion'])] }),
      ),
    )
    const catalog = await fetchOllamaCatalog()
    expect(catalog.reachable).toBe(true)
    expect(catalog.version).toBeUndefined()
    expect(catalog.models.map((m) => m.name)).toEqual(['llama3.2:3b'])
  })

  it('reports a stopped daemon as unreachable with a fixable message, not a rejection', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, _init?: RequestInit) => {
        throw new TypeError('fetch failed')
      }),
    )
    const catalog = await fetchOllamaCatalog()
    expect(catalog.reachable).toBe(false)
    expect(catalog.models).toEqual([])
    expect(catalog.error).toContain('ollama serve')
  })

  it('sorts the list so the picker order does not depend on daemon order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, _init?: RequestInit) =>
        url.endsWith('/api/version')
          ? jsonResponse({ version: '0.32.4' })
          : jsonResponse({
              models: [tag('zephyr:7b', []), tag('alpha:1b', []), tag('mistral:7b', [])],
            }),
      ),
    )
    const catalog = await fetchOllamaCatalog()
    expect(catalog.models.map((m) => m.name)).toEqual(['alpha:1b', 'mistral:7b', 'zephyr:7b'])
  })
})

describe('pickDefaultModel', () => {
  const model = (name: string, caps: string[], sizeBytes: number): OllamaModelInfo => ({
    name,
    capabilities: caps,
    vision: caps.includes('vision'),
    tools: caps.includes('tools'),
    thinking: caps.includes('thinking'),
    sizeBytes,
  })

  it('prefers a tool-capable model, since the agent loop is built on tool calls', () => {
    expect(
      pickDefaultModel([
        model('big-no-tools', ['vision'], 9e9),
        model('small-tools', ['tools'], 1e9),
      ]),
    ).toBe('small-tools')
  })

  it('breaks a tools tie on vision, then on size', () => {
    expect(
      pickDefaultModel([model('text', ['tools'], 9e9), model('sees', ['tools', 'vision'], 1e9)]),
    ).toBe('sees')
    expect(pickDefaultModel([model('small', ['tools'], 1e9), model('large', ['tools'], 9e9)])).toBe(
      'large',
    )
  })

  it('has nothing to pick on an empty daemon', () => {
    expect(pickDefaultModel([])).toBe('')
  })
})

describe('formatModelSize', () => {
  it('reads as the download size the user recognizes', () => {
    expect(formatModelSize(6_594_474_711)).toBe('6.6 GB')
    expect(formatModelSize(400_000_000)).toBe('400 MB')
    expect(formatModelSize(0)).toBe('')
    expect(formatModelSize(undefined)).toBe('')
  })
})
