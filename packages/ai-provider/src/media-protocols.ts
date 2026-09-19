/**
 * Wire implementation for local media understanding. Ollama's
 * OpenAI-compatible surface takes images as `image_url` parts, so a vision
 * model answers questions about screenshots and embedded pictures without any
 * of it leaving the machine. Image *generation* has no counterpart here: the
 * daemon serves no such endpoint, so that capability was removed with the
 * hosted providers rather than reintroduced through a cloud vendor.
 */

import { aiFetch } from './fetch'
import { httpBodyDetail } from './http-error'
import { ollamaOpenAiBaseUrl } from './ollama'
import type { AiMediaProviderConfig } from './types'

export interface MediaBlob {
  bytes: Uint8Array
  mime: string
  name?: string
}

export interface AnalyzeMediaInput {
  media: MediaBlob[]
  requirements: string
}

/** local models are slow on big images, and a cold model is loaded on first use */
const ANALYZE_TIMEOUT_MS = 300_000
const TEST_TIMEOUT_MS = 20_000

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function dataUrl(blob: MediaBlob): string {
  return `data:${blob.mime};base64,${bytesToBase64(blob.bytes)}`
}

/** Magic-number sniff: callers hand us bytes from disk or the clipboard with no declared type. */
export function sniffImageMime(bytes: Uint8Array, fallback = 'image/png'): string {
  if (bytes.length >= 8) {
    const [a, b, c, d] = bytes
    if (a === 0x89 && b === 0x50 && c === 0x4e && d === 0x47) return 'image/png'
    if (a === 0xff && b === 0xd8 && c === 0xff) return 'image/jpeg'
    if (a === 0x47 && b === 0x49 && c === 0x46) return 'image/gif'
    if (a === 0x42 && b === 0x4d) return 'image/bmp'
    if (
      a === 0x52 &&
      b === 0x49 &&
      c === 0x46 &&
      d === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    ) {
      return 'image/webp'
    }
  }
  return fallback
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function bearer(config: AiMediaProviderConfig): Record<string, string> {
  return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}
}

function openAiContentText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const p = asRecord(part)
        return typeof p.text === 'string' ? p.text : ''
      })
      .join('')
  }
  return ''
}

/**
 * Reads the given images with a local vision model. Video and audio are
 * rejected outright instead of being silently dropped: no Ollama vision model
 * decodes a track, and a half-answered analysis is worse than a clear no.
 */
export async function analyzeMediaWithProvider(
  config: AiMediaProviderConfig,
  model: string,
  input: AnalyzeMediaInput,
  signal?: AbortSignal,
): Promise<string> {
  if (!model) throw new Error('No vision model configured for media analysis')
  const parts: unknown[] = [{ type: 'text', text: input.requirements }]
  for (const m of input.media) {
    if (!m.mime.startsWith('image/')) {
      throw new Error(
        `Ollama cannot analyze ${m.name ?? m.mime} (${m.mime}) — local vision models read still images only.`,
      )
    }
    parts.push({ type: 'image_url', image_url: { url: dataUrl(m) } })
  }
  const resp = await aiFetch(`${ollamaOpenAiBaseUrl(config.baseUrl)}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...bearer(config) },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: parts }] }),
    signal: withTimeout(signal, ANALYZE_TIMEOUT_MS),
  })
  if (!resp.ok) {
    throw new Error(
      `Media analysis failed: HTTP ${resp.status}: ${httpBodyDetail(await resp.text())}`,
    )
  }
  const json = asRecord(await resp.json())
  const choice = asRecord((json.choices as unknown[] | undefined)?.[0])
  const text = openAiContentText(asRecord(choice.message).content).trim()
  if (!text) throw new Error('Media analysis returned an empty answer')
  return text
}

/**
 * Connection check for the settings pane. A model listing is the cheapest
 * proof that the daemon is up and (behind a proxy) that the key is accepted.
 */
export async function testMediaProvider(
  config: AiMediaProviderConfig,
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const resp = await aiFetch(`${ollamaOpenAiBaseUrl(config.baseUrl)}/models`, {
      headers: bearer(config),
      signal: withTimeout(signal, TEST_TIMEOUT_MS),
    })
    if (resp.ok) return { ok: true }
    const detail = httpBodyDetail(await resp.text().catch(() => ''))
    return { ok: false, error: `HTTP ${resp.status}: ${detail}` }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
