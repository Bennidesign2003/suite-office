import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { run, tempDir } from './helpers'

// the audit log lives under GENOFFICE_AUTH_DIR (read from process.env): keep it out of $HOME
const saved: Record<string, string | undefined> = {}
beforeEach(() => {
  for (const k of ['GENOFFICE_AUTH_DIR']) saved[k] = process.env[k]
  process.env.GENOFFICE_AUTH_DIR = join(tempDir(), 'no-auth')
})
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

// a real settings file always carries the chat provider block; without it every section resets to defaults
function settingsFile(dir: string, settings: Record<string, unknown>): string {
  const path = join(dir, 'ai-settings.json')
  writeFileSync(path, JSON.stringify({ provider: 'ollama', providers: {}, ...settings }))
  return path
}

describe('genoffice capabilities', () => {
  it('reports no model features with default settings, but keyless search', async () => {
    const dir = tempDir()
    const r = await run(['capabilities', '--json'], {
      env: {
        ...process.env,
        GENOFFICE_AI_SETTINGS: join(dir, 'missing.json'),
        GENOFFICE_APP_BIN: '',
      },
    })
    expect(r.code).toBe(0)
    const d = r.json().detail
    expect(d.chat.available).toBe(false)
    expect(d.media_analysis.available).toBe(false)
    // Ollama serves no image output, so generation is never available
    expect(d.image_generation.available).toBe(false)
    // the keyless fallbacks always answer
    expect(d.search).toEqual({ available: true, via: 'free' })
    expect(d.image_search).toEqual({ available: true, via: 'free' })
  })

  it('counts a Serper key as search + image search, never as image generation', async () => {
    const dir = tempDir()
    mkdirSync(join(dir, 'bin'))
    const settings = settingsFile(dir, {
      search: {
        provider: 'serper',
        providers: { serper: { apiKey: 'k' }, tavily: { apiKey: '' } },
      },
      media: {
        imageProvider: 'openai',
        providers: { openai: { apiKey: 'sk', imageModel: 'gpt-image-1' } },
      },
    })
    const r = await run(['capabilities', '--json'], {
      env: {
        ...process.env,
        GENOFFICE_AI_SETTINGS: settings,
        GENOFFICE_APP_BIN: join(dir, 'bin', 'app'),
      },
    })
    expect(r.code).toBe(0)
    const d = r.json().detail
    expect(d.search).toEqual({ available: true, via: 'serper' })
    expect(d.image_search).toEqual({ available: true, via: 'serper' })
    expect(d.image_generation.available).toBe(false)
    expect(d.media_analysis.available).toBe(false)
    expect(d.app.available).toBe(true)
    expect(r.json().summary).not.toContain('image_generation')
  })

  it('Tavily gives web search; image search falls back to the keyless source', async () => {
    const dir = tempDir()
    const settings = settingsFile(dir, {
      search: {
        provider: 'tavily',
        providers: { serper: { apiKey: '' }, tavily: { apiKey: 't' } },
      },
    })
    const r = await run(['capabilities', '--json'], {
      env: { ...process.env, GENOFFICE_AI_SETTINGS: settings },
    })
    const d = r.json().detail
    expect(d.search).toEqual({ available: true, via: 'tavily' })
    expect(d.image_search).toEqual({ available: true, via: 'free' })
  })
})
