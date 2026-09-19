import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentToolCall } from '@genoffice/agent-core'
import { sseLines, streamForProvider } from '../src/stream'
import { jsonBodyInsteadOfSse } from '../src/protocols/shared'
import { jsonResponse, okResponse, sseStream } from './test-utils'

afterEach(() => {
  vi.unstubAllGlobals()
})

function collector() {
  const deltas: string[] = []
  const toolCalls: AgentToolCall[] = []
  const stopReasons: string[] = []
  return {
    deltas,
    toolCalls,
    stopReasons,
    cb: {
      signal: new AbortController().signal,
      onDelta: (text: string) => deltas.push(text),
      onToolCall: (call: AgentToolCall) => toolCalls.push(call),
      onStopReason: (reason: string) => stopReasons.push(reason),
    },
  }
}

describe('sseLines', () => {
  it('splits a stream into lines, including a trailing line with no newline', async () => {
    const encoder = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: a\ndata: b\n'))
        controller.enqueue(encoder.encode('data: c')) // no trailing newline
        controller.close()
      },
    })
    const lines: string[] = []
    for await (const line of sseLines(body)) lines.push(line)
    expect(lines).toEqual(['data: a', 'data: b', 'data: c'])
  })
})

describe('streamForProvider: request shaping', () => {
  const okTurn = () =>
    okResponse(sseStream(['data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}']))

  it('always sends a temperature — the daemon owns sampling, not a vendor', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okTurn()))
    vi.stubGlobal('fetch', fetchMock)
    // both of these were fixed-sampling families upstream; through Ollama they are not
    for (const model of ['gpt-oss:20b', 'qwen3.5:latest']) {
      await streamForProvider('ollama', { apiKey: '', model }, 'sys', [], [], 100, collector().cb)
    }
    const bodies = fetchMock.mock.calls.map((call) =>
      JSON.parse((call[1] as RequestInit).body as string),
    )
    expect(bodies.map((b) => b.temperature)).toEqual([0.3, 0.3])
  })

  it('caps the turn with max_tokens', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okTurn()))
    vi.stubGlobal('fetch', fetchMock)
    await streamForProvider(
      'ollama',
      { apiKey: '', model: 'llama3.2' },
      'sys',
      [],
      [],
      100,
      collector().cb,
    )
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    expect(body.max_tokens).toBe(100)
    expect('max_completion_tokens' in body).toBe(false)
  })

  it('posts to the daemon default host', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okTurn()))
    vi.stubGlobal('fetch', fetchMock)
    await streamForProvider(
      'ollama',
      { apiKey: '', model: 'llama3.2' },
      'sys',
      [],
      [],
      100,
      collector().cb,
    )
    expect(fetchMock.mock.calls[0]![0]).toBe('http://127.0.0.1:11434/v1/chat/completions')
  })

  it('posts to a configured remote daemon, however the host was typed', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okTurn()))
    vi.stubGlobal('fetch', fetchMock)
    for (const baseUrl of ['http://box:11434', 'http://box:11434/v1', 'http://box:11434/']) {
      await streamForProvider(
        'ollama',
        { apiKey: '', model: 'm', baseUrl },
        'sys',
        [],
        [],
        100,
        collector().cb,
      )
    }
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe('http://box:11434/v1/chat/completions')
    }
  })

  it('omits Authorization for a bare local daemon but sends it for a guarded proxy', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okTurn()))
    vi.stubGlobal('fetch', fetchMock)
    await streamForProvider(
      'ollama',
      { apiKey: '', model: 'm' },
      'sys',
      [],
      [],
      100,
      collector().cb,
    )
    await streamForProvider(
      'ollama',
      { apiKey: 'proxy-key', model: 'm', baseUrl: 'https://ollama.internal' },
      'sys',
      [],
      [],
      100,
      collector().cb,
    )
    const headersOf = (i: number) =>
      new Headers((fetchMock.mock.calls[i]![1] as RequestInit).headers)
    expect(headersOf(0).has('authorization')).toBe(false)
    expect(headersOf(1).get('authorization')).toBe('Bearer proxy-key')
  })

  it('refuses to guess a model, and never calls the daemon without one', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      streamForProvider('ollama', { apiKey: '', model: '  ' }, 'sys', [], [], 100, collector().cb),
    ).rejects.toThrow(/No Ollama model selected/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('never echoes reasoning back: the compatible surface has no field to carry it', async () => {
    const fetchMock = vi.fn().mockImplementation(() => Promise.resolve(okTurn()))
    vi.stubGlobal('fetch', fetchMock)
    await streamForProvider(
      'ollama',
      { apiKey: '', model: 'deepseek-r1:8b' },
      'sys',
      [
        { role: 'user', text: 'q' },
        {
          role: 'assistant',
          text: '',
          toolCalls: [{ id: 't1', name: 'f', input: {} }],
          reasoning: 'earlier thoughts',
        },
        { role: 'tool', results: [{ id: 't1', name: 'f', output: '42' }] },
      ],
      [],
      100,
      collector().cb,
    )
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
    const assistant = body.messages.find((m: { role: string }) => m.role === 'assistant')
    expect('reasoning_content' in assistant).toBe(false)
  })

  it('still surfaces reasoning deltas a thinking model streams', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          okResponse(
            sseStream([
              'data: {"choices":[{"delta":{"reasoning_content":"hmm "}}]}',
              'data: {"choices":[{"delta":{"reasoning":"ok"}}]}',
              'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}',
            ]),
          ),
        ),
    )
    const reasoning: string[] = []
    const { deltas, cb } = collector()
    await streamForProvider('ollama', { apiKey: '', model: 'deepseek-r1:8b' }, 'sys', [], [], 100, {
      ...cb,
      onReasoningDelta: (t: string) => reasoning.push(t),
    })
    expect(reasoning.join('')).toBe('hmm ok')
    expect(deltas.join('')).toBe('hi')
  })
})

describe('streamForProvider: empty SSE streams surface as errors', () => {
  it('rejects on a stream with no framing at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(sseStream([]))))
    await expect(
      streamForProvider('ollama', { apiKey: '', model: 'm' }, 'sys', [], [], 100, collector().cb),
    ).rejects.toThrow(/The model returned no content/)
  })

  it('a genuine empty closing turn (normal stop framing) still succeeds', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
      'data: [DONE]',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    await expect(
      streamForProvider('ollama', { apiKey: '', model: 'm' }, 'sys', [], [], 100, collector().cb),
    ).resolves.toBeUndefined()
  })

  it('throws on a non-ok HTTP response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('model not found', { status: 404 })),
    )
    await expect(
      streamForProvider(
        'ollama',
        { apiKey: '', model: 'nope' },
        'sys',
        [],
        [],
        100,
        collector().cb,
      ),
    ).rejects.toThrow(/HTTP 404.*model not found/)
  })
})

describe('streamForProvider: openai-compatible', () => {
  it('reassembles fragmented tool call arguments and flushes on finish_reason', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"content":"partial "}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"replace"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"x\\":1}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { deltas, toolCalls, cb } = collector()
    await streamForProvider('ollama', { apiKey: 'k', model: 'llama3.2' }, 'sys', [], [], 100, cb)
    expect(deltas.join('')).toBe('partial ')
    expect(toolCalls).toEqual([{ id: 'c1', name: 'replace', input: { x: 1 } }])
  })

  it('tolerates servers that resend the full tool name on every delta', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"replace","arguments":"{\\"x\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"replace","arguments":"1}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { toolCalls, cb } = collector()
    await streamForProvider('ollama', { apiKey: 'k', model: 'llama3.2' }, 'sys', [], [], 100, cb)
    expect(toolCalls).toEqual([{ id: 'c1', name: 'replace', input: { x: 1 } }])
  })

  it('still assembles a tool name streamed in fragments', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"rep"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"lace","arguments":"{\\"x\\":1}"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      'data: [DONE]',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { toolCalls, cb } = collector()
    await streamForProvider('ollama', { apiKey: 'k', model: 'llama3.2' }, 'sys', [], [], 100, cb)
    expect(toolCalls).toEqual([{ id: 'c1', name: 'replace', input: { x: 1 } }])
  })

  it("finish_reason 'length' normalizes to max_tokens and flags the cut-off tool call", async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"replace","arguments":"{\\"x\\": \\"trunc"}}]}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}',
      'data: [DONE]',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { toolCalls, stopReasons, cb } = collector()
    await streamForProvider('ollama', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb)
    expect(stopReasons).toEqual(['max_tokens'])
    expect(toolCalls).toHaveLength(1)
    expect(toolCalls[0]!.truncated).toBe(true)
    expect(toolCalls[0]!.inputError).toBeDefined()
  })

  it('throws on a gateway error event instead of finishing an empty turn', async () => {
    const body = sseStream([
      'data: {"error":{"message":"You exceeded your current quota"}}',
      'data: [DONE]',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { cb } = collector()
    await expect(
      streamForProvider('ollama', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb),
    ).rejects.toThrow('You exceeded your current quota')
  })

  it('throws when a content_filter finish produced no content', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}',
      'data: [DONE]',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { cb } = collector()
    await expect(
      streamForProvider('ollama', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb),
    ).rejects.toThrow(/no content \(finish_reason=content_filter\)/)
  })

  it('keeps partial content when content_filter cuts off after some text', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"content":"partial "}}]}',
      'data: {"choices":[{"delta":{},"finish_reason":"content_filter"}]}',
      'data: [DONE]',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { deltas, cb } = collector()
    await streamForProvider('ollama', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb)
    expect(deltas.join('')).toBe('partial ')
  })

  it('emits content and tool calls from a complete JSON body sent instead of SSE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            {
              message: {
                content: 'Here is the change.',
                tool_calls: [{ id: 'c1', function: { name: 'replace', arguments: '{"x":1}' } }],
              },
              finish_reason: 'stop',
            },
          ],
        }),
      ),
    )
    const { deltas, toolCalls, cb } = collector()
    await streamForProvider('ollama', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb)
    expect(deltas.join('')).toBe('Here is the change.')
    expect(toolCalls).toEqual([
      { id: 'c1', name: 'replace', input: { x: 1 }, inputError: undefined },
    ])
  })

  it("flags the last tool call of a JSON body with finish_reason 'length' as truncated", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        jsonResponse({
          choices: [
            {
              message: {
                tool_calls: [{ id: 'c1', function: { name: 'replace', arguments: '{"x": "tru' } }],
              },
              finish_reason: 'length',
            },
          ],
        }),
      ),
    )
    const { toolCalls, stopReasons, cb } = collector()
    await streamForProvider('ollama', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb)
    expect(toolCalls[0]!.truncated).toBe(true)
    expect(toolCalls[0]!.inputError).toBeDefined()
    expect(stopReasons).toEqual(['max_tokens'])
  })

  it('throws on an empty JSON body sent instead of SSE', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ choices: [{ message: {} }] })))
    const { cb } = collector()
    await expect(
      streamForProvider('ollama', { apiKey: 'k', model: 'm' }, 'sys', [], [], 100, cb),
    ).rejects.toThrow(/The model returned no content/)
  })

  it('never sends content:null for an assistant turn with neither text nor tools', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okResponse(
          sseStream([
            'data: {"choices":[{"delta":{"content":"ok"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
            'data: [DONE]',
          ]),
        ),
      )
    vi.stubGlobal('fetch', fetchMock)
    const { cb } = collector()
    await streamForProvider(
      'ollama',
      { apiKey: 'k', model: 'm' },
      'sys',
      [
        { role: 'user', text: 'first' },
        { role: 'assistant', text: '' },
        { role: 'user', text: 'second' },
      ],
      [],
      100,
      cb,
    )
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as {
      messages: Array<{ role: string; content: unknown; tool_calls?: unknown }>
    }
    for (const msg of body.messages) {
      if (msg.role !== 'assistant') continue
      expect(msg.content === null && !msg.tool_calls).toBe(false)
      if (msg.content !== null) expect(String(msg.content).length).toBeGreaterThan(0)
    }
  })
})

describe('streamForProvider: a connection dropped mid tool arguments is not an empty stream', () => {
  // Tool arguments are buffered before they are streamed, so a daemon that
  // dies mid-generation (OOM on a large model, `ollama stop`) leaves the SSE
  // open with half a tool call in it. That must not match the "(empty stream)"
  // contract agent-core replays — the turn was in progress, not empty.
  it('half-received tool arguments with no finish reject as a dropped connection', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"write_html","arguments":"{\\"html\\":"}}]}}]}',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"<!doctype"}}]}}]}',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { cb, toolCalls } = collector()
    const run = streamForProvider(
      'ollama',
      { apiKey: 'k', model: 'llama3.2' },
      'sys',
      [],
      [],
      100,
      cb,
    )
    await expect(run).rejects.toThrow(/connection was dropped/)
    await expect(run).rejects.not.toThrow(/empty stream/)
    expect(toolCalls).toEqual([])
  })

  it('complete arguments without a finish reason still flush as a tool call', async () => {
    const body = sseStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"ping","arguments":"{\\"a\\":1}"}}]}}]}',
    ])
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okResponse(body)))
    const { cb, toolCalls } = collector()
    await streamForProvider('ollama', { apiKey: 'k', model: 'llama3.2' }, 'sys', [], [], 100, cb)
    expect(toolCalls.map((c) => [c.name, c.input])).toEqual([['ping', { a: 1 }]])
  })
})

describe('jsonBodyInsteadOfSse', () => {
  it('detects JSON bodies regardless of Content-Type casing', async () => {
    const payload = JSON.stringify({ choices: [] })
    for (const contentType of [
      'application/json',
      'Application/JSON',
      'APPLICATION/JSON; charset=utf-8',
      'Application/Json; charset=utf-8',
    ]) {
      const res = new Response(payload, { status: 200, headers: { 'content-type': contentType } })
      await expect(jsonBodyInsteadOfSse(res)).resolves.toBe(payload)
    }
    const sse = new Response('data: hi\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
    await expect(jsonBodyInsteadOfSse(sse)).resolves.toBeNull()
  })
})
