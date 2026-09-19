import { defaultAiMediaSettings, resolveAiMediaSettings } from './media'
import { ollamaHost } from './ollama'
import { defaultAiSearchSettings, resolveAiSearchSettings } from './search-settings'
import {
  OLLAMA_DEFAULT_HOST,
  type AiProviderId,
  type AiProviderMeta,
  type AiSettings,
  type LegacyAiSettings,
} from './types'

/**
 * One provider, one entry. `models` stays empty on purpose: the installed
 * models are read from the daemon at runtime (see ollama.ts), so there is no
 * shipped catalog that can go stale.
 */
export const OLLAMA_PROVIDER_META: AiProviderMeta = {
  id: 'ollama',
  label: 'Ollama',
  models: [],
  defaultModel: '',
  keyPlaceholder: 'Not required for a local daemon',
  needsBaseUrl: true,
}

export const AI_PROVIDERS: AiProviderMeta[] = [OLLAMA_PROVIDER_META]

/** Fresh settings pointing at a stock local daemon with no model chosen yet. */
export function defaultAiSettings(): AiSettings {
  return {
    provider: 'ollama',
    providers: {
      ollama: { apiKey: '', model: '', baseUrl: OLLAMA_DEFAULT_HOST },
    },
    media: defaultAiMediaSettings(),
    search: defaultAiSearchSettings(),
  }
}

/**
 * Whether AI features can run at all. There is nothing to fall back to now, so
 * this replaces upstream's `activeProvider()` (which downgraded a half-filled
 * config to the hosted default): either a model is selected or the AI surfaces
 * tell the user to pick one.
 */
export function aiConfigured(settings: AiSettings): boolean {
  return !!settings.providers?.ollama?.model?.trim()
}

/** The one provider id, kept as a function so call sites read the same as before. */
export function activeProvider(_settings: AiSettings): AiProviderId {
  return 'ollama'
}

/**
 * Per-turn output cap applied when the settings carry none. The historic 8192
 * was the budget a reasoning model burns on thinking before it writes any prose,
 * and too small for a large sheet DSL or long-form generation in one turn. Models
 * whose own ceiling is lower reject this and are retried at that ceiling
 * (see output-cap.ts).
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32768
/** bounds accepted for AiSettings.maxOutputTokens: below the first a short answer cannot even finish, above the second one turn risks the whole context window */
export const MIN_MAX_OUTPUT_TOKENS = 1024
export const MAX_MAX_OUTPUT_TOKENS = 131072

/** Out-of-range or non-finite input falls back to a bound / the default (a mistyped settings field must not kill AI features) */
export function clampMaxOutputTokens(value: unknown): number {
  const n = typeof value === 'number' ? Math.floor(value) : Number.NaN
  if (!Number.isFinite(n)) return DEFAULT_MAX_OUTPUT_TOKENS
  return Math.min(MAX_MAX_OUTPUT_TOKENS, Math.max(MIN_MAX_OUTPUT_TOKENS, n))
}

/** The effective per-turn output cap of a settings object (clamped; absent → default) */
export function maxOutputTokensOf(
  settings: Pick<AiSettings, 'maxOutputTokens'> | null | undefined,
): number {
  return settings?.maxOutputTokens === undefined
    ? DEFAULT_MAX_OUTPUT_TOKENS
    : clampMaxOutputTokens(settings.maxOutputTokens)
}

/** pasted keys/URLs/model ids often carry stray whitespace, which turns into a 401 with a valid key */
function trimConfig(config: AiSettings['providers']['ollama']): AiSettings['providers']['ollama'] {
  return {
    apiKey: config.apiKey?.trim() ?? '',
    model: config.model?.trim() ?? '',
    baseUrl: ollamaHost(config.baseUrl),
  }
}

/**
 * Upstream GenOffice settings files list one config per hosted vendor. Only a
 * `custom` entry could ever have pointed at a local daemon, so that is the one
 * we carry across; every cloud key is intentionally left behind rather than
 * migrated into a product that has no way to use it.
 */
function fromLegacyProviders(
  stored: LegacyAiSettings,
): Partial<AiSettings['providers']['ollama']> | null {
  const custom = stored.providers?.custom
  if (!custom?.baseUrl) return null
  const host = ollamaHost(custom.baseUrl)
  // a custom endpoint that was not a local Ollama is not ours to adopt
  if (!/(^|\/\/)(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1\])/.test(host) && !/:11434\b/.test(host)) {
    return null
  }
  return { baseUrl: host, model: custom.model?.trim() ?? '', apiKey: custom.apiKey?.trim() ?? '' }
}

/**
 * Merge on-disk settings over freshly computed defaults. `stored` is whatever
 * the caller read from its settings file (already JSON-parsed); this function
 * does no file I/O.
 */
export function resolveAiSettings(
  stored: Partial<AiSettings> & LegacyAiSettings,
  defaults: AiSettings = defaultAiSettings(),
): AiSettings {
  const ollama =
    (stored.providers as AiSettings['providers'] | undefined)?.ollama ??
    fromLegacyProviders(stored) ??
    // the pre-provider single-endpoint shape
    (stored.baseUrl || stored.model
      ? { apiKey: stored.apiKey ?? '', model: stored.model ?? '', baseUrl: stored.baseUrl }
      : null)
  return {
    provider: 'ollama',
    providers: { ollama: trimConfig({ ...defaults.providers.ollama, ...ollama }) },
    media: resolveAiMediaSettings(stored.media),
    search: resolveAiSearchSettings(stored.search),
    // clamped on read: a hand-edited settings file with an absurd cap must not be
    // forwarded to the endpoint verbatim
    ...(stored.maxOutputTokens !== undefined || defaults.maxOutputTokens !== undefined
      ? {
          maxOutputTokens: clampMaxOutputTokens(stored.maxOutputTokens ?? defaults.maxOutputTokens),
        }
      : {}),
  }
}
