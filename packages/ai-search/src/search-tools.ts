/**
 * ai:web-search / ai:image-search for the server: reads ai-settings.json live
 * and turns the search provider choice into SearchOptions. 'free' is the
 * keyless chain (env keys if the machine has them, then DuckDuckGo); a user
 * Serper / Tavily key runs first.
 */

import { activeSearchProvider, type AiSearchProviderId, type AiSettings } from '@genoffice/ai-provider'
import { imageSearch, webSearch, type SearchOptions } from './index'
import { readAiSettingsFile } from './media-tools'

export function searchOptionsFromSettings(settings: AiSettings): SearchOptions {
  const provider = activeSearchProvider(settings)
  if (provider === 'free') return {}
  const key = settings.search!.providers[provider].apiKey
  return provider === 'tavily' ? { tavilyKey: key, prefer: 'tavily' } : { serperKey: key }
}

export function webSearchTool(settingsPath: string, query: string, maxResults = 6) {
  return webSearch(query, maxResults, searchOptionsFromSettings(readAiSettingsFile(settingsPath)))
}

export function imageSearchTool(settingsPath: string, query: string, maxResults = 8) {
  return imageSearch(query, maxResults, searchOptionsFromSettings(readAiSettingsFile(settingsPath)))
}

/** settings-UI test: one minimal query against the given key must be answered by that backend */
export async function testSearchProvider(
  provider: AiSearchProviderId,
  apiKey: string,
): Promise<{ ok: boolean; error?: string }> {
  if (provider === 'free') return { ok: true }
  if (!apiKey) return { ok: false, error: 'API key is empty' }
  const options: SearchOptions =
    provider === 'tavily'
      ? { tavilyKey: apiKey, serperKey: '', prefer: 'tavily' }
      : { serperKey: apiKey, tavilyKey: '' }
  const r = await webSearch('Suite', 1, options)
  if (r.method === provider) return { ok: true }
  return {
    ok: false,
    error:
      r.method === 'error'
        ? (r.error ?? 'search failed')
        : `${provider} did not answer (key rejected or quota exhausted); fell back to ${r.method}`,
  }
}
