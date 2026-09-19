import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@genoffice/ai-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@genoffice/ai-provider')>()),
  analyzeMediaWithProvider: vi.fn(),
}))

import { analyzeMediaWithProvider } from '@genoffice/ai-provider'
import { analyzeMediaTool, NO_VISION_MODEL_ERROR } from '../src/media-tools'

const analyze = vi.mocked(analyzeMediaWithProvider)
/** nonexistent settings file → defaults, which carry no model yet */
const UNCONFIGURED = '/nonexistent/ai-settings.json'

beforeEach(() => analyze.mockReset())

describe('analyzeMediaTool', () => {
  it('refuses up front when no model is configured, without loading any bytes', async () => {
    expect(
      await analyzeMediaTool(UNCONFIGURED, { mediaUrls: ['/tmp/x.png'], requirements: 'q' }),
    ).toEqual({
      error: NO_VISION_MODEL_ERROR,
    })
    expect(analyze).not.toHaveBeenCalled()
  })

  it('validates its arguments before touching the settings file', async () => {
    expect(await analyzeMediaTool(UNCONFIGURED, { mediaUrls: [], requirements: 'q' })).toEqual({
      error: 'mediaUrls must not be empty',
    })
    expect(
      await analyzeMediaTool(UNCONFIGURED, { mediaUrls: ['/tmp/x.png'], requirements: '  ' }),
    ).toEqual({ error: 'requirements must not be empty' })
  })

  it('rejects a path that is not an image instead of shipping it to the model', async () => {
    const settings = writeSettings({ model: 'llava:13b' })
    expect(
      await analyzeMediaTool(settings, { mediaUrls: ['/tmp/secrets.env'], requirements: 'q' }),
    ).toEqual({ error: 'Unsupported media file: /tmp/secrets.env (images only)' })
    expect(analyze).not.toHaveBeenCalled()
  })

  it('passes the loaded image and the chat model through to the daemon', async () => {
    analyze.mockResolvedValueOnce('a red square')
    const settings = writeSettings({ model: 'qwen3.5:latest' })
    const png = writePng()
    expect(await analyzeMediaTool(settings, { mediaUrls: [png], requirements: 'what?' })).toEqual({
      text: 'a red square',
    })
    const [config, model, input] = analyze.mock.calls[0]!
    expect(model).toBe('qwen3.5:latest')
    expect(config.baseUrl).toBe('http://127.0.0.1:11434')
    expect(input.requirements).toBe('what?')
    expect(input.media[0]!.mime).toBe('image/png')
  })

  it('prefers a dedicated vision model over the chat model', async () => {
    analyze.mockResolvedValueOnce('ok')
    const settings = writeSettings({ model: 'llama3.2:3b', analysisModel: 'llava:13b' })
    await analyzeMediaTool(settings, { mediaUrls: [writePng()], requirements: 'q' })
    expect(analyze.mock.calls[0]![1]).toBe('llava:13b')
  })

  it('reports a daemon failure as an error rather than throwing', async () => {
    analyze.mockRejectedValueOnce(new Error('model not loaded'))
    const settings = writeSettings({ model: 'llava:13b' })
    expect(
      await analyzeMediaTool(settings, { mediaUrls: [writePng()], requirements: 'q' }),
    ).toEqual({ error: 'model not loaded' })
  })
})

// ── fixtures ────────────────────────────────────────────────────────

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'suite-media-'))

function writeSettings(ollama: { model: string; analysisModel?: string }): string {
  const path = join(dir, `settings-${Math.random().toString(36).slice(2)}.json`)
  writeFileSync(
    path,
    JSON.stringify({
      provider: 'ollama',
      providers: { ollama: { apiKey: '', model: ollama.model } },
      ...(ollama.analysisModel
        ? {
            media: {
              analysisProvider: 'ollama',
              providers: { ollama: { apiKey: '', analysisModel: ollama.analysisModel } },
            },
          }
        : {}),
    }),
  )
  return path
}

function writePng(): string {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.png`)
  writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  return path
}
