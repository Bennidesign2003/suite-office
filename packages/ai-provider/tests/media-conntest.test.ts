import { afterEach, describe, expect, it, vi } from 'vitest'
import { testMediaProvider } from '../src/media-protocols'

afterEach(() => vi.unstubAllGlobals())

describe('testMediaProvider', () => {
  it('passes when the daemon lists its models', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('{"data":[]}', { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)
    expect(await testMediaProvider({ apiKey: '', analysisModel: '' })).toEqual({ ok: true })
    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:11434/v1/models')
  })

  it('surfaces the status and body when a proxy rejects the key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, _init?: RequestInit) => new Response('bad key', { status: 401 })),
    )
    const r = await testMediaProvider({ apiKey: 'nope', analysisModel: '' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('HTTP 401')
    expect(r.error).toContain('bad key')
  })

  it('reports a stopped daemon instead of throwing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, _init?: RequestInit) => {
        throw new TypeError('fetch failed')
      }),
    )
    const r = await testMediaProvider({ apiKey: '', analysisModel: '' })
    expect(r).toEqual({ ok: false, error: 'fetch failed' })
  })
})
