import { afterEach, describe, expect, it, vi } from 'vitest'
import { chatForProvider } from '../src/chat'
import { errorResponse, jsonResponse } from './test-utils'

afterEach(() => {
  vi.unstubAllGlobals()
})

const config = { apiKey: '', model: 'llama3.2' }

describe('chatForProvider', () => {
  it('returns the assistant message of a chat completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, _init?: RequestInit) =>
        jsonResponse({ choices: [{ message: { content: 'hello' } }] }),
      ),
    )
    expect(await chatForProvider('ollama', config, 'sys', 'hi')).toEqual({
      ok: true,
      content: 'hello',
    })
  })

  it('posts to the daemon chat-completions endpoint with the configured model', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ choices: [{ message: { content: 'x' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await chatForProvider('ollama', { apiKey: '', model: 'mistral:7b' }, 'sys', 'hi')
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit]
    expect(url).toBe('http://127.0.0.1:11434/v1/chat/completions')
    const body = JSON.parse(String(init.body)) as { model: string; messages: unknown[] }
    expect(body.model).toBe('mistral:7b')
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ])
  })

  it('honours a configured remote daemon', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ choices: [{ message: { content: 'x' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await chatForProvider('ollama', { ...config, baseUrl: 'http://box:11434' }, 'sys', 'hi')
    expect(fetchMock.mock.calls[0]![0]).toBe('http://box:11434/v1/chat/completions')
  })

  it('reports a missing model as a failed reply instead of calling the daemon', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await chatForProvider('ollama', { apiKey: '', model: '' }, 'sys', 'hi')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/No Ollama model selected/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a non-ok status with the daemon body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, _init?: RequestInit) =>
        errorResponse(404, 'model "nope" not found, try pulling it first'),
      ),
    )
    const result = await chatForProvider('ollama', { apiKey: '', model: 'nope' }, 'sys', 'hi')
    expect(result.ok).toBe(false)
    expect(result.error).toContain('HTTP 404')
    expect(result.error).toContain('try pulling it first')
  })

  it('does not leak a SyntaxError when a proxy answers 200 with an HTML shell', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<!doctype html><html><body>nope</body></html>', { status: 200 }),
      ),
    )
    const result = await chatForProvider('ollama', config, 'sys', 'hi')
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/non-JSON response/)
  })

  it('treats an empty completion as a failure, not an empty answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, _init?: RequestInit) =>
        jsonResponse({ choices: [{ message: { content: '' } }] }),
      ),
    )
    const result = await chatForProvider('ollama', config, 'sys', 'hi')
    expect(result).toEqual({ ok: false, error: 'AI returned an empty response' })
  })

  it('sends no Authorization for a bare local daemon', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ choices: [{ message: { content: 'x' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await chatForProvider('ollama', config, 'sys', 'hi')
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect(new Headers(init.headers).has('authorization')).toBe(false)
  })
})
