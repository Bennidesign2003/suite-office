export type {
  AiAnalysisProtocol,
  AiChatRequest,
  AiChatResponse,
  AiMediaProviderConfig,
  AiMediaProviderId,
  AiMediaProviderMeta,
  AiMediaSettings,
  AiProviderConfig,
  AiProviderId,
  AiProviderMeta,
  AiSearchProviderId,
  AiSearchProviderMeta,
  AiSearchSettings,
  AiSettings,
  AiStreamChunk,
  AiStreamRequest,
  LegacyAiSettings,
  OllamaCatalog,
  OllamaModelInfo,
} from './types'
export { OLLAMA_DEFAULT_HOST } from './types'
export {
  AI_PROVIDERS,
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  activeProvider,
  aiConfigured,
  clampMaxOutputTokens,
  defaultAiSettings,
  maxOutputTokensOf,
  resolveAiSettings,
} from './providers'
export {
  fetchOllamaCatalog,
  formatModelSize,
  ollamaHost,
  ollamaOpenAiBaseUrl,
  pickDefaultModel,
} from './ollama'
export {
  AI_MEDIA_PROVIDERS,
  activeMediaConfig,
  activeMediaProvider,
  defaultAiMediaSettings,
  getMediaProviderMeta,
  imageGenerationAvailable,
  mediaAnalysisAvailable,
  mediaAnalysisModel,
  resolveAiMediaSettings,
  videoAnalysisAvailable,
} from './media'
export {
  AI_SEARCH_PROVIDERS,
  activeSearchProvider,
  defaultAiSearchSettings,
  resolveAiSearchSettings,
} from './search-settings'
export {
  analyzeMediaWithProvider,
  base64ToBytes,
  bytesToBase64,
  sniffImageMime,
  testMediaProvider,
} from './media-protocols'
export type { AnalyzeMediaInput, MediaBlob } from './media-protocols'
export {
  AI_PROVIDER_ADAPTERS,
  getProviderAdapter,
  modelEchoesReasoning,
  modelHasFixedSampling,
  modelLacksVision,
} from './registry'
export type {
  AiProtocol,
  ProviderAdapter,
  ProviderCapabilities,
  ResolvedEndpoint,
} from './registry'
export { chatForProvider } from './chat'
export { setAiUserAgent, setRescueFetch } from './fetch'
export { isAiNetworkError } from './network-error'
export { isAiOverloadedError } from './overload-error'
export { parseOutputCapRejection } from './output-cap'
export { sseLines, streamForProvider } from './stream'
export type { StreamCallbacks } from './stream'
export {
  AI_CHAT_RESPONSE_TIMEOUT_MS,
  AI_CONNECT_TIMEOUT_MS,
  AI_IDLE_TIMEOUT_MS,
  AiTimeoutError,
  createStreamWatchdog,
} from './watchdog'
export type { StreamWatchdog } from './watchdog'
