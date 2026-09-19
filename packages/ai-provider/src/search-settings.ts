import type {
  AiSearchProviderId,
  AiSearchProviderMeta,
  AiSearchSettings,
  AiSettings,
} from './types'

/**
 * 'free' is the keyless chain and the default, so web search works out of the
 * box on a machine with no accounts on it at all. Serper and Tavily stay for
 * users who have a key and want better results — they are the only remaining
 * places in Suite where a request leaves the machine, and both are opt-in.
 */
export const AI_SEARCH_PROVIDERS: AiSearchProviderMeta[] = [
  { id: 'free', label: 'Free sources (no key)', keyPlaceholder: '', imageSearch: true },
  { id: 'serper', label: 'Serper', keyPlaceholder: 'Serper API key', imageSearch: true },
  { id: 'tavily', label: 'Tavily', keyPlaceholder: 'tvly-...', imageSearch: false },
]

export function defaultAiSearchSettings(): AiSearchSettings {
  return { provider: 'free', providers: { serper: { apiKey: '' }, tavily: { apiKey: '' } } }
}

export function resolveAiSearchSettings(
  stored: Partial<AiSearchSettings> | undefined,
): AiSearchSettings {
  const defaults = defaultAiSearchSettings()
  if (!stored) return defaults
  const providers = { ...defaults.providers }
  for (const id of ['serper', 'tavily'] as const) {
    const key = stored.providers?.[id]?.apiKey
    if (typeof key === 'string') providers[id] = { apiKey: key.trim() }
  }
  const provider = AI_SEARCH_PROVIDERS.some((m) => m.id === stored.provider)
    ? stored.provider!
    : defaults.provider
  return { provider, providers }
}

/** The stored search backend, honored only with a key; otherwise the keyless chain. */
export function activeSearchProvider(settings: Pick<AiSettings, 'search'>): AiSearchProviderId {
  const search = settings.search
  if (!search || search.provider === 'free') return 'free'
  if (!AI_SEARCH_PROVIDERS.some((m) => m.id === search.provider)) return 'free'
  // Trim-aware: a whitespace-only key from in-memory settings falls back
  // instead of sending `Bearer    ` to the search backend.
  return search.providers?.[search.provider]?.apiKey?.trim() ? search.provider : 'free'
}
