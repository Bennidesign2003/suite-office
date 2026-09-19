/**
 * Talking to the local Ollama daemon's *native* API (/api/...). The chat turn
 * itself rides the daemon's OpenAI-compatible surface (/v1/chat/completions,
 * see protocols/openai-compatible.ts) because that path already carries tool
 * calls, streaming and image input. The native API is used only for the two
 * things the compatible surface cannot answer: which models are installed and
 * what each of them can do.
 */
import { aiFetch } from './fetch'
import { httpBodyDetail } from './http-error'
import { OLLAMA_DEFAULT_HOST, type OllamaCatalog, type OllamaModelInfo } from './types'

/** Model discovery must not hang the settings pane behind a dead host. */
const CATALOG_TIMEOUT_MS = 4000

/** `http://host:11434/v1/` and `http://host:11434` both mean the same daemon. */
export function ollamaHost(baseUrl?: string | null): string {
  const raw = baseUrl?.trim()
  if (!raw) return OLLAMA_DEFAULT_HOST
  return raw.replace(/\/+$/, '').replace(/\/v1$/, '')
}

/** The OpenAI-compatible base URL the chat protocols post to. */
export function ollamaOpenAiBaseUrl(baseUrl?: string | null): string {
  return `${ollamaHost(baseUrl)}/v1`
}

interface RawTag {
  name?: string
  model?: string
  size?: number
  capabilities?: unknown
  details?: {
    parameter_size?: string
    quantization_level?: string
    context_length?: number
  }
}

function toModelInfo(raw: RawTag): OllamaModelInfo | null {
  const name = raw.model || raw.name
  if (!name) return null
  const capabilities = Array.isArray(raw.capabilities)
    ? raw.capabilities.filter((c): c is string => typeof c === 'string')
    : []
  return {
    name,
    parameterSize: raw.details?.parameter_size,
    quantization: raw.details?.quantization_level,
    contextLength: raw.details?.context_length,
    sizeBytes: raw.size,
    capabilities,
    vision: capabilities.includes('vision'),
    tools: capabilities.includes('tools'),
    thinking: capabilities.includes('thinking'),
  }
}

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  const response = await aiFetch(url, { method: 'GET', signal })
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${httpBodyDetail(await response.text())}`)
  }
  return JSON.parse(await response.text()) as unknown
}

/**
 * Everything the model picker needs, in one round trip pair. Never rejects: a
 * daemon that is not running is the normal first-launch state, not an error
 * the caller should have to catch, so it comes back as `reachable: false` with
 * the reason attached.
 */
export async function fetchOllamaCatalog(
  baseUrl?: string | null,
  signal?: AbortSignal,
): Promise<OllamaCatalog> {
  const host = ollamaHost(baseUrl)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS)
  const onOuterAbort = () => controller.abort()
  signal?.addEventListener('abort', onOuterAbort)
  try {
    const [tags, version] = await Promise.all([
      getJson(`${host}/api/tags`, controller.signal),
      // a daemon too old for /api/version is still perfectly usable
      getJson(`${host}/api/version`, controller.signal).catch(() => null),
    ])
    const list = (tags as { models?: RawTag[] } | null)?.models ?? []
    const models = list
      .map(toModelInfo)
      .filter((m): m is OllamaModelInfo => m !== null)
      .sort((a, b) => a.name.localeCompare(b.name))
    return {
      reachable: true,
      baseUrl: host,
      version: (version as { version?: string } | null)?.version,
      models,
    }
  } catch (e) {
    return {
      reachable: false,
      baseUrl: host,
      models: [],
      error: describeUnreachable(e, host),
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onOuterAbort)
  }
}

/**
 * "fetch failed" tells a user nothing. The two states worth distinguishing are
 * "the daemon isn't running" (by far the common one) and "it answered, badly".
 */
function describeUnreachable(error: unknown, host: string): string {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof Error && error.name === 'AbortError') {
    return `Ollama at ${host} did not answer within ${CATALOG_TIMEOUT_MS} ms.`
  }
  if (/HTTP \d{3}/.test(message)) return message
  return `Could not reach Ollama at ${host}. Start it with \`ollama serve\`, then try again. (${message})`
}

/**
 * Which installed model to preselect. The agent loop is built on tool calls,
 * so a tool-capable model always beats one without; among equals prefer vision
 * (the editors hand the model screenshots) and then the larger download, which
 * is the better model often enough to be a sane default.
 */
export function pickDefaultModel(models: OllamaModelInfo[]): string {
  const score = (m: OllamaModelInfo) => (m.tools ? 4 : 0) + (m.vision ? 2 : 0)
  const best = [...models].sort(
    (a, b) => score(b) - score(a) || (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0),
  )[0]
  return best?.name ?? ''
}

/** Human-readable size for the model picker ("6.6 GB"). */
export function formatModelSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  const gb = bytes / 1e9
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`
}
