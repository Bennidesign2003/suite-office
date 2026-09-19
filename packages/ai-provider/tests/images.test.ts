import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentMessage } from '@genoffice/agent-core'
import { streamForProvider } from '../src/stream'
import { okResponse, sseStream } from './test-utils'

afterEach(() => {
  vi.unstubAllGlobals()
})

const config = { apiKey: '', model: 'qwen3.5:latest' }

function callbacks() {
  return {
    signal: new AbortController().signal,
    onDelta: () => {},
    onToolCall: () => {},
  }
}

const IMAGE = { mime: 'image/png', base64: 'AAA' }

/** run one turn against a stubbed daemon and hand back the request body it sent */
async function requestBody(messages: AgentMessage[]): Promise<{
  messages: { role: string; content: unknown }[]
}> {
  const fetchMock = vi
    .fn()
    .mockResolvedValue(
      okResponse(
        sseStream(['data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}']),
      ),
    )
  vi.stubGlobal('fetch', fetchMock)
  await streamForProvider('ollama', config, 'sys', messages, [], 1024, callbacks())
  return JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string)
}

describe('image input', () => {
  it('sends text and image as separate content parts', async () => {
    const body = await requestBody([{ role: 'user', text: 'what is this?', images: [IMAGE] }])
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      ],
    })
  })

  it('omits the text part when the turn is an image alone', async () => {
    const body = await requestBody([{ role: 'user', text: '', images: [IMAGE] }])
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }],
    })
  })

  it('keeps a plain text turn a plain string, not a one-element part array', async () => {
    const body = await requestBody([{ role: 'user', text: 'hi' }])
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hi' })
  })

  it('sends every image of a multi-image turn', async () => {
    const body = await requestBody([
      { role: 'user', text: 'compare', images: [IMAGE, { mime: 'image/jpeg', base64: 'BBB' }] },
    ])
    expect(body.messages[1].content).toHaveLength(3)
  })
})
