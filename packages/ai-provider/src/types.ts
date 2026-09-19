import type { AgentMessage, AgentToolCall, AgentToolDef } from '@genoffice/agent-core'

/**
 * Suite talks to exactly one backend: a local Ollama daemon. Everything the
 * upstream project routed to hosted vendors now runs on the user's own
 * machine, so there is a single provider id instead of a vendor catalog.
 */
export type AiProviderId = 'ollama'

/** Default Ollama daemon root (the OpenAI-compatible surface lives under /v1) */
export const OLLAMA_DEFAULT_HOST = 'http://127.0.0.1:11434'

export interface AiProviderConfig {
  /**
   * Blank for a plain local daemon. Ollama itself ignores Authorization, but a
   * reverse proxy in front of it (or a remote host on the LAN) may require one.
   */
  apiKey: string
  model: string
  /** daemon root; empty means OLLAMA_DEFAULT_HOST */
  baseUrl?: string | undefined
}

/** One entry of the local daemon's model list (GET /api/tags). */
export interface OllamaModelInfo {
  /** the id to put in `model`, e.g. "qwen3.5:latest" */
  name: string
  /** "9.7B" and friends, straight from the daemon */
  parameterSize?: string | undefined
  quantization?: string | undefined
  /** training context window in tokens, when the daemon reports it */
  contextLength?: number | undefined
  sizeBytes?: number | undefined
  /** raw capability list as reported ("vision", "tools", "thinking", "completion", ...) */
  capabilities: string[]
  /** accepts image input */
  vision: boolean
  /** can emit tool calls — required for the agent loop, so the picker warns without it */
  tools: boolean
  /** emits reasoning before the answer */
  thinking: boolean
}

/**
 * Live picker data. Replaces the hardcoded per-vendor model arrays upstream
 * carried: which models exist is a property of the user's machine, not of a
 * list we can ship.
 */
export interface OllamaCatalog {
  reachable: boolean
  /** the daemon root the catalog was read from */
  baseUrl: string
  /** daemon version from GET /api/version */
  version?: string | undefined
  models: OllamaModelInfo[]
  /** why the daemon could not be reached (only set when reachable is false) */
  error?: string | undefined
}

export interface AiProviderMeta {
  id: AiProviderId
  label: string
  /** always empty: the catalog is discovered at runtime, never shipped */
  models: string[]
  defaultModel: string
  keyPlaceholder: string
  needsBaseUrl?: boolean
}

/**
 * Media backends. Ollama serves vision models, so image *analysis* works
 * locally; it has no image *generation* endpoint, so that capability is gone
 * rather than pointed at a cloud vendor.
 */
export type AiMediaProviderId = 'ollama'

/** wire shape of the understanding endpoint */
export type AiAnalysisProtocol = 'openai-chat'

export interface AiMediaProviderConfig {
  apiKey: string
  baseUrl?: string | undefined
  /** vision model used by analyze_media (empty = reuse the chat model) */
  analysisModel: string
}

export interface AiMediaProviderMeta {
  id: AiMediaProviderId
  label: string
  /** one-line English blurb shown on the provider card */
  description: string
  keyPlaceholder: string
  needsBaseUrl?: boolean
  defaultBaseUrl: string
  analysisProtocol: AiAnalysisProtocol
  /** discovered at runtime like the chat catalog */
  analysisModels: string[]
  defaultAnalysisModel: string
}

export interface AiMediaSettings {
  /** provider behind analyze_media */
  analysisProvider: AiMediaProviderId
  providers: Record<AiMediaProviderId, AiMediaProviderConfig>
}

/**
 * Web/image search backends. 'free' is the keyless chain (DuckDuckGo and
 * friends) and is the default, so a stock install reaches the web without any
 * account at all; Serper and Tavily stay available for users who have a key.
 */
export type AiSearchProviderId = 'free' | 'serper' | 'tavily'

export interface AiSearchProviderMeta {
  id: AiSearchProviderId
  label: string
  keyPlaceholder: string
  /** the backend also serves image search (otherwise image search falls back to free sources) */
  imageSearch: boolean
}

export interface AiSearchSettings {
  provider: AiSearchProviderId
  providers: Record<Exclude<AiSearchProviderId, 'free'>, { apiKey: string }>
}

export interface AiSettings {
  provider: AiProviderId
  providers: Record<AiProviderId, AiProviderConfig>
  /** provider for analyze_media; absent means the Ollama defaults */
  media?: AiMediaSettings | undefined
  /** web/image search backend; absent means the keyless chain */
  search?: AiSearchSettings | undefined
  /**
   * Output-token cap for ONE model turn of agent runs (default
   * DEFAULT_MAX_OUTPUT_TOKENS). Reasoning models bill their thinking against
   * this same budget, so a heavy edit turn can consume all of it and close with
   * finish_reason=length and no prose at all — raising it is the user's lever
   * (absent = the default, so pre-existing settings files keep working).
   */
  maxOutputTokens?: number | undefined
}

/**
 * Pre-Suite settings shapes we still read: the upstream multi-vendor file (a
 * `provider` id plus a bag of per-vendor configs, of which only a
 * custom/OpenAI-compatible entry could have pointed at Ollama) and the even
 * older single-endpoint file. Migration is one-way and lossy on purpose —
 * cloud keys are dropped, not carried over.
 */
export interface LegacyAiSettings {
  baseUrl?: string
  apiKey?: string
  model?: string
  providers?: Record<string, { apiKey?: string; model?: string; baseUrl?: string }>
}

export interface AiChatRequest {
  settings: AiSettings
  system: string
  user: string
}

export interface AiChatResponse {
  ok: boolean
  content?: string
  error?: string
}

export interface AiStreamRequest {
  requestId: string
  /** Stable renderer transport id used to retain native provider sessions. */
  sessionId?: string
  settings: AiSettings
  system: string
  messages: AgentMessage[]
  tools?: AgentToolDef[]
  maxTokens?: number
}

export interface AiStreamChunk {
  requestId: string
  /** 'ping' = wire-level keepalive so the renderer can tell a live stream from a dead one;
   * 'reasoning' = model thinking delta (text carries it), stored for interleaved-thinking echo */
  type: 'delta' | 'reasoning' | 'tool-call' | 'done' | 'error' | 'ping'
  text?: string
  /** complete parsed tool call (emitted once its arguments finish streaming) */
  toolCall?: AgentToolCall
  error?: string
  /** machine-readable error cause ('timeout', 'network' connectivity failure — including a daemon
   * that is not running, 'overloaded' when the daemon is still loading a model) */
  errorCode?: 'timeout' | 'network' | 'overloaded'
  /** normalized stop reason carried on 'done' ('max_tokens' = output cut off by the token limit) */
  stopReason?: string
}
