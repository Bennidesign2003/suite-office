import { describe, expect, it } from 'vitest'
import { defaultAiSettings, resolveAiSettings } from '../src/providers'
import {
  activeSearchProvider,
  defaultAiSearchSettings,
  resolveAiSearchSettings,
} from '../src/search-settings'

describe('search settings', () => {
  it('defaults to the keyless chain and rides along in defaultAiSettings', () => {
    expect(defaultAiSearchSettings()).toEqual({
      provider: 'free',
      providers: { serper: { apiKey: '' }, tavily: { apiKey: '' } },
    })
    expect(defaultAiSettings().search?.provider).toBe('free')
    expect(resolveAiSettings({}).search).toEqual(defaultAiSearchSettings())
  })

  it('merges and trims stored keys', () => {
    const s = resolveAiSearchSettings({
      provider: 'tavily',
      providers: { tavily: { apiKey: ' tvly-1 ' } } as never,
    })
    expect(s.provider).toBe('tavily')
    expect(s.providers.tavily.apiKey).toBe('tvly-1')
    expect(s.providers.serper.apiKey).toBe('')
  })

  it('falls back to the free chain for an unknown stored provider', () => {
    expect(resolveAiSearchSettings({ provider: 'bing' as never }).provider).toBe('free')
  })

  it('activates a keyed search provider only with a key', () => {
    expect(activeSearchProvider({ search: undefined })).toBe('free')
    const withKey = (apiKey: string) => ({
      search: {
        provider: 'serper' as const,
        providers: { serper: { apiKey }, tavily: { apiKey: '' } },
      },
    })
    expect(activeSearchProvider(withKey(''))).toBe('free')
    expect(activeSearchProvider(withKey('   '))).toBe('free')
    expect(activeSearchProvider(withKey('k'))).toBe('serper')
    expect(activeSearchProvider({ search: { provider: 'bing', providers: {} } as never })).toBe(
      'free',
    )
  })
})
