import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  AI_MEDIA_PROVIDERS,
  activeMediaConfig,
  activeMediaProvider,
  defaultAiMediaSettings,
  imageGenerationAvailable,
  mediaAnalysisAvailable,
  mediaAnalysisModel,
  resolveAiMediaSettings,
  videoAnalysisAvailable,
} from '../src/media'
import { analyzeMediaWithProvider } from '../src/media-protocols'
import { defaultAiSettings } from '../src/providers'
import { OLLAMA_DEFAULT_HOST } from '../src/types'
import { jsonResponse } from './test-utils'

afterEach(() => vi.unstubAllGlobals())

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

describe('media providers', () => {
  it('is Ollama and nothing else', () => {
    expect(AI_MEDIA_PROVIDERS.map((p) => p.id)).toEqual(['ollama'])
    expect(activeMediaProvider({ media: undefined })).toBe('ollama')
  })

  it('defaults to the local daemon with no dedicated vision model', () => {
    expect(defaultAiMediaSettings()).toEqual({
      analysisProvider: 'ollama',
      providers: { ollama: { apiKey: '', analysisModel: '', baseUrl: OLLAMA_DEFAULT_HOST } },
    })
  })

  it('trims a stored config and normalizes the host', () => {
    const s = resolveAiMediaSettings({
      analysisProvider: 'ollama',
      providers: {
        ollama: { apiKey: ' k ', analysisModel: ' llava ', baseUrl: 'http://box:11434/v1' },
      },
    })
    expect(s.providers.ollama).toEqual({
      apiKey: 'k',
      analysisModel: 'llava',
      baseUrl: 'http://box:11434',
    })
  })

  it('reports no config until media settings exist', () => {
    expect(activeMediaConfig({ media: undefined })).toBeNull()
    expect(activeMediaConfig({ media: defaultAiMediaSettings() })?.provider).toBe('ollama')
  })
})

describe('mediaAnalysisModel', () => {
  it('falls back to the chat model, so a one-model install needs no second choice', () => {
    const s = defaultAiSettings()
    s.providers.ollama.model = 'qwen3.5:latest'
    expect(mediaAnalysisModel(s)).toBe('qwen3.5:latest')
    expect(mediaAnalysisAvailable(s)).toBe(true)
  })

  it('prefers a dedicated vision model when one is set', () => {
    const s = defaultAiSettings()
    s.providers.ollama.model = 'llama3.2:3b'
    s.media!.providers.ollama.analysisModel = 'llava:13b'
    expect(mediaAnalysisModel(s)).toBe('llava:13b')
  })

  it('is unavailable with no model at all', () => {
    expect(mediaAnalysisAvailable(defaultAiSettings())).toBe(false)
    expect(mediaAnalysisAvailable(null)).toBe(false)
  })
})

describe('capabilities Ollama does not have', () => {
  it('never offers image generation — the daemon has no such endpoint', () => {
    expect(imageGenerationAvailable()).toBe(false)
  })

  it('never offers video analysis — local vision models read stills', () => {
    expect(videoAnalysisAvailable()).toBe(false)
  })
})

describe('analyzeMediaWithProvider', () => {
  it('posts the image as a data URL to the daemon and returns the answer', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ choices: [{ message: { content: 'a red square' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const text = await analyzeMediaWithProvider(
      { apiKey: '', analysisModel: '', baseUrl: 'http://127.0.0.1:11434' },
      'llava:13b',
      { media: [{ bytes: pngBytes, mime: 'image/png' }], requirements: 'what is this?' },
    )
    expect(text).toBe('a red square')
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions')
    const body = JSON.parse(String(init.body)) as {
      model: string
      messages: { content: { type: string; image_url?: { url: string } }[] }[]
    }
    expect(body.model).toBe('llava:13b')
    expect(body.messages[0].content[1].image_url!.url).toMatch(/^data:image\/png;base64,/)
  })

  it('sends no Authorization header to a bare local daemon', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ choices: [{ message: { content: 'x' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await analyzeMediaWithProvider({ apiKey: '', analysisModel: '' }, 'llava', {
      media: [{ bytes: pngBytes, mime: 'image/png' }],
      requirements: 'q',
    })
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(new Headers(init.headers).has('authorization')).toBe(false)
  })

  it('refuses video instead of silently dropping it', async () => {
    vi.stubGlobal('fetch', vi.fn())
    await expect(
      analyzeMediaWithProvider({ apiKey: '', analysisModel: '' }, 'llava', {
        media: [{ bytes: pngBytes, mime: 'video/mp4', name: 'clip.mp4' }],
        requirements: 'q',
      }),
    ).rejects.toThrow(/still images only/)
  })

  it('refuses to guess when no model is configured', async () => {
    await expect(
      analyzeMediaWithProvider({ apiKey: '', analysisModel: '' }, '', {
        media: [{ bytes: pngBytes, mime: 'image/png' }],
        requirements: 'q',
      }),
    ).rejects.toThrow(/No vision model configured/)
  })
})
