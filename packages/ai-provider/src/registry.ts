import { ollamaOpenAiBaseUrl } from './ollama'
import { OLLAMA_PROVIDER_META } from './providers'
import type { AiProviderConfig, AiProviderId, AiProviderMeta } from './types'

/**
 * One wire protocol is left. Ollama serves an OpenAI-compatible
 * /v1/chat/completions with streaming, tool calls and image input, which is
 * everything the agent loop needs; the vendor-specific Anthropic, Gemini and
 * Codex transports upstream carried are gone with their providers.
 */
export type AiProtocol = 'openai-compatible'

export interface ProviderCapabilities {
  /** local daemons are open by default; a key is only sent if the user set one for a proxy */
  auth: 'none-or-key'
  /** whether *some* installed model takes images — per-model truth lives in OllamaModelInfo.vision */
  vision: boolean
}

export interface ResolvedEndpoint {
  protocol: AiProtocol
  baseUrl: string
  /** the endpoint fixes its sampling and rejects a temperature field */
  omitTemperature?: boolean
  /** vendor-specific request fields merged into the chat-completions body */
  bodyExtras?: Record<string, unknown>
}

export interface ProviderAdapter {
  meta: AiProviderMeta
  capabilities: ProviderCapabilities
  /** pick the wire protocol and base URL for one request */
  resolveEndpoint(config: AiProviderConfig): ResolvedEndpoint
}

/**
 * Ollama honours `temperature` on every model it serves, including the ones
 * whose hosted twins refuse it (the daemon owns sampling, not the vendor), so
 * nothing needs to be omitted. Kept as a function because the streaming and
 * chat paths both ask before building a body.
 */
export function modelHasFixedSampling(_model: string): boolean {
  return false
}

/**
 * Whether a model rejects image input. With a live catalog this is answered by
 * `OllamaModelInfo.vision`; callers that only hold a model id (the editors
 * deciding whether to attach a screenshot) get a conservative answer from the
 * name, since a non-vision model errors on an image part.
 */
export function modelLacksVision(model: string): boolean {
  return !/(^|[-:_/])(llava|bakllava|moondream|minicpm-v|llama3\.2-vision|qwen[\d.]*-?vl|qwen3\.5|gemma3|mistral-small3|granite3\.2-vision)/i.test(
    model,
  )
}

/**
 * Whether assistant turns must echo the model's own reasoning back. Ollama
 * strips thinking from the transcript it keeps, and its OpenAI-compatible
 * surface has no field to round-trip it, so nothing is echoed.
 */
export function modelEchoesReasoning(_model: string): boolean {
  return false
}

export const AI_PROVIDER_ADAPTERS: Record<AiProviderId, ProviderAdapter> = {
  ollama: {
    meta: OLLAMA_PROVIDER_META,
    capabilities: { auth: 'none-or-key', vision: true },
    resolveEndpoint(config) {
      return { protocol: 'openai-compatible', baseUrl: ollamaOpenAiBaseUrl(config.baseUrl) }
    },
  },
}

/** Throws on ids not in the registry — settings files are user data and can carry anything. */
export function getProviderAdapter(provider: AiProviderId): ProviderAdapter {
  const adapter = AI_PROVIDER_ADAPTERS[provider]
  if (!adapter) throw new Error(`Unknown provider: ${provider}`)
  return adapter
}
