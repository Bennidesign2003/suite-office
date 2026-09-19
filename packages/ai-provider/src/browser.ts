/** Browser-safe settings surface. Keep Node-backed transports out of renderer bundles. */
export type {
  AiMediaProviderConfig,
  AiMediaProviderId,
  AiMediaProviderMeta,
  AiMediaSettings,
  AiProviderConfig,
  AiProviderId,
  AiProviderMeta,
  AiSearchProviderId,
  AiSearchSettings,
  AiSettings,
  OllamaCatalog,
  OllamaModelInfo,
} from './types'
export { OLLAMA_DEFAULT_HOST } from './types'
export {
  AI_PROVIDERS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  clampMaxOutputTokens,
  defaultAiSettings,
} from './providers'
export { formatModelSize, ollamaHost, ollamaOpenAiBaseUrl, pickDefaultModel } from './ollama'
export { getProviderAdapter, modelLacksVision } from './registry'
export {
  AI_MEDIA_PROVIDERS,
  imageGenerationAvailable,
  mediaAnalysisAvailable,
  mediaAnalysisModel,
} from './media'
export { AI_SEARCH_PROVIDERS } from './search-settings'
