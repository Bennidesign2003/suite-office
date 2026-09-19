import { ollamaHost } from './ollama'
import type {
  AiMediaProviderConfig,
  AiMediaProviderId,
  AiMediaProviderMeta,
  AiMediaSettings,
  AiSettings,
} from './types'
import { OLLAMA_DEFAULT_HOST } from './types'

/**
 * Media, the local way. Ollama serves vision models, so `analyze_media` reads
 * images and screenshots on the user's own machine. It has no image *output*
 * endpoint, so `generate_image` is genuinely unavailable in Suite rather than
 * quietly reaching for a hosted vendor — every cloud media provider upstream
 * shipped is gone.
 */
export const AI_MEDIA_PROVIDERS: AiMediaProviderMeta[] = [
  {
    id: 'ollama',
    label: 'Ollama',
    description: 'Reads images with a local vision model — nothing leaves your machine',
    keyPlaceholder: 'Not required for a local daemon',
    needsBaseUrl: true,
    defaultBaseUrl: OLLAMA_DEFAULT_HOST,
    analysisProtocol: 'openai-chat',
    // discovered from the daemon like the chat catalog
    analysisModels: [],
    defaultAnalysisModel: '',
  },
]

export function getMediaProviderMeta(id: AiMediaProviderId): AiMediaProviderMeta | undefined {
  return AI_MEDIA_PROVIDERS.find((m) => m.id === id)
}

export function defaultAiMediaSettings(): AiMediaSettings {
  return {
    analysisProvider: 'ollama',
    providers: { ollama: { apiKey: '', analysisModel: '', baseUrl: OLLAMA_DEFAULT_HOST } },
  }
}

export function resolveAiMediaSettings(
  stored: Partial<AiMediaSettings> | undefined,
): AiMediaSettings {
  const defaults = defaultAiMediaSettings()
  const config = stored?.providers?.ollama
  if (!config) return defaults
  return {
    analysisProvider: 'ollama',
    providers: {
      ollama: {
        apiKey: (config.apiKey ?? '').trim(),
        analysisModel: (config.analysisModel ?? '').trim(),
        baseUrl: ollamaHost(config.baseUrl),
      },
    },
  }
}

/** The media config in force, or null when media settings have not been written yet. */
export function activeMediaConfig(
  settings: Pick<AiSettings, 'media'>,
): { provider: AiMediaProviderId; config: AiMediaProviderConfig } | null {
  const config = settings.media?.providers?.ollama
  return config ? { provider: 'ollama', config } : null
}

export function activeMediaProvider(_settings: Pick<AiSettings, 'media'>): AiMediaProviderId {
  return 'ollama'
}

/**
 * The model `analyze_media` will use: the dedicated vision model when one is
 * set, otherwise the chat model, which on a single-model install is the same
 * thing and saves the user a second choice.
 */
export function mediaAnalysisModel(
  settings: Pick<AiSettings, 'media' | 'providers'> | null | undefined,
): string {
  const dedicated = settings?.media?.providers?.ollama?.analysisModel?.trim()
  if (dedicated) return dedicated
  return settings?.providers?.ollama?.model?.trim() ?? ''
}

/**
 * Live predicate for the analyze_media tool. Whether the chosen model actually
 * has the `vision` capability is the catalog's answer, not this one — this
 * only says a model is configured at all.
 */
export function mediaAnalysisAvailable(
  settings: Pick<AiSettings, 'media' | 'providers'> | null | undefined,
): boolean {
  return mediaAnalysisModel(settings) !== ''
}

/**
 * Always false: no local image-generation backend exists behind Ollama. Kept
 * so the tool registry can keep asking instead of special-casing its absence.
 */
export function imageGenerationAvailable(): boolean {
  return false
}

/** Always false — Ollama's vision models take stills, not video or audio tracks. */
export function videoAnalysisAvailable(): boolean {
  return false
}
