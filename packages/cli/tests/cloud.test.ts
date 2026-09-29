import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { aiSettingsPath, proxyUrlFromEnv } from '../src/cloud'
import { resultCount } from '../src/commands/search'
import { run } from './helpers'

describe('cloud command plumbing', () => {
  it('locates the shell ai-settings.json without Electron and honours the override', () => {
    expect(aiSettingsPath({ GENOFFICE_AI_SETTINGS: '/x/ai.json' })).toBe('/x/ai.json')
    const p = aiSettingsPath({})
    expect(p.endsWith(join('GenOffice', 'ai-settings.json'))).toBe(true)
    if (process.platform === 'darwin') expect(p).toContain('Library/Application Support')
    expect(aiSettingsPath({ GENOFFICE_USER_DATA: '/ud' })).toBe(join('/ud', 'ai-settings.json'))
  })

  it('picks the first http(s) proxy variable and ignores socks', () => {
    expect(proxyUrlFromEnv({})).toBeNull()
    expect(proxyUrlFromEnv({ ALL_PROXY: 'socks5://h:1', HTTP_PROXY: 'http://h:8080' })).toBe(
      'http://h:8080',
    )
    expect(proxyUrlFromEnv({ https_proxy: 'http://a:1', HTTP_PROXY: 'http://b:2' })).toBe(
      'http://a:1',
    )
  })

  it('keeps the per-mode default when --max is absent and clamps it otherwise', async () => {
    expect(resultCount(undefined)).toBeUndefined()
    expect(resultCount('3')).toBe(3)
    expect(resultCount('0')).toBe(1)
    expect(resultCount('99')).toBe(20)
    expect(() => resultCount('lots')).toThrow()
    expect((await run(['search', 'x', '--max', 'lots', '--json'])).code).toBe(1)
  })

  it('rejects missing arguments before touching the network', async () => {
    expect((await run(['search', '--json'])).code).toBe(1)
    expect((await run(['media', '--json'])).code).toBe(1)
    const missing = await run(['media', '/nonexistent/photo.jpg', '--json'])
    expect(missing.code).toBe(2)
    const missingUrl = await run(['media', 'file:///nonexistent/photo.jpg', '--json'])
    expect(missingUrl.code).toBe(2)
    expect(missingUrl.json().message).toContain('/nonexistent/photo.jpg')
  })

  it('lists the network-facing commands in help', async () => {
    const r = await run(['help'])
    expect(r.stdout).toMatch(/\bsearch\b/)
    expect(r.stdout).toMatch(/\bmedia\b/)
    // image generation has no local backend and must not be advertised
    expect(r.stdout).not.toMatch(/^\s*image\b/m)
  })
})
