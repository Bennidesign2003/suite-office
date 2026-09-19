/**
 * analyze_media for the editors: one place that reads ai-settings.json live
 * and hands the bytes to a local Ollama vision model.
 *
 * There is no generate_image counterpart any more. Ollama serves no image
 * *output* endpoint, and reaching for a hosted one would undo the whole point
 * of the fork, so the tool is gone rather than degraded.
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, extname } from 'node:path'
import {
  analyzeMediaWithProvider,
  defaultAiSettings,
  mediaAnalysisModel,
  resolveAiSettings,
  type AiSettings,
  type LegacyAiSettings,
  type MediaBlob,
} from '@genoffice/ai-provider'
// deep imports: the package root re-exports host-bound modules, and this file also runs in the CLI
import { readGeneratedImage, storeGeneratedImage } from '@genoffice/electron-utils/generated-images'
import { fetchRemoteImage } from '@genoffice/electron-utils/remote-image'
import { fetchWithSsrfGuard } from '@genoffice/electron-utils/safe-remote-url'

export const NO_VISION_MODEL_ERROR =
  'No Ollama vision model is configured; pick one under Settings (AI) to use this tool'

/** 200 MB: bigger than any screenshot, small enough to hold in memory */
const MAX_MEDIA_BYTES = 200 * 1024 * 1024

export class MediaTooLargeError extends Error {}

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.heic': 'image/heic',
}

export function readAiSettingsFile(path: string): AiSettings {
  let stored: Partial<AiSettings> & LegacyAiSettings = {}
  try {
    if (existsSync(path)) stored = JSON.parse(readFileSync(path, 'utf-8'))
  } catch {
    /* corrupted settings file: defaults */
  }
  return resolveAiSettings(stored, defaultAiSettings())
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Resolves a tool-supplied media reference to bytes: an https URL (SSRF-guarded),
 * a file:// URL from the generated-image store, or a local image file
 * (attachments). Only image extensions are read locally — the model must not be
 * able to ship arbitrary files anywhere.
 */
export async function loadMediaReference(ref: string): Promise<MediaBlob> {
  if (/^https?:\/\//i.test(ref)) {
    const resp = await (ref.match(/\.(png|jpe?g|gif|webp)(\?|$)/i)
      ? fetchRemoteImage(ref)
      : fetchWithSsrfGuard(ref, { headers: { 'User-Agent': 'Mozilla/5.0' } }))
    if (!resp || !resp.ok) throw new Error(`Could not download ${ref}`)
    const declared = Number(resp.headers.get('content-length') ?? 0)
    if (declared > MAX_MEDIA_BYTES) throw new MediaTooLargeError(`${ref} is too large to analyze`)
    const bytes = new Uint8Array(await resp.arrayBuffer())
    if (bytes.byteLength > MAX_MEDIA_BYTES) {
      throw new MediaTooLargeError(`${ref} is too large to analyze`)
    }
    const rawCt = resp.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase()
    const ct = rawCt && rawCt !== 'application/octet-stream' ? rawCt : undefined
    const name = basename(new URL(ref).pathname) || undefined
    const mime =
      ct && ct !== 'application/octet-stream' ? ct : MIME_BY_EXT[extname(name ?? '').toLowerCase()]
    if (!mime) throw new Error(`Could not tell the media type of ${ref}`)
    return { bytes, mime, ...(name ? { name } : {}) }
  }
  if (ref.startsWith('file:')) {
    const local = readGeneratedImage(ref)
    if (!local) throw new Error(`Not an accessible image: ${ref}`)
    return { bytes: new Uint8Array(local.bytes), mime: local.mime }
  }
  const mime = MIME_BY_EXT[extname(ref).toLowerCase()]
  if (!mime) throw new Error(`Unsupported media file: ${ref} (images only)`)
  if (!existsSync(ref)) throw new Error(`File not found: ${ref}`)
  if (statSync(ref).size > MAX_MEDIA_BYTES) {
    throw new MediaTooLargeError(`${ref} is too large to analyze`)
  }
  return { bytes: new Uint8Array(readFileSync(ref)), mime, name: basename(ref) }
}

export async function analyzeMediaTool(
  settingsPath: string,
  op: { mediaUrls: string[]; requirements: string },
): Promise<{ text?: string; error?: string }> {
  const mediaUrls = (op.mediaUrls ?? []).map(String).filter(Boolean)
  const requirements = String(op.requirements ?? '').trim()
  if (!mediaUrls.length) return { error: 'mediaUrls must not be empty' }
  if (!requirements) return { error: 'requirements must not be empty' }
  const settings = readAiSettingsFile(settingsPath)
  const model = mediaAnalysisModel(settings)
  if (!model) return { error: NO_VISION_MODEL_ERROR }
  const config = settings.media!.providers.ollama
  try {
    const media = await Promise.all(mediaUrls.map(loadMediaReference))
    return { text: await analyzeMediaWithProvider(config, model, { media, requirements }) }
  } catch (err) {
    return { error: errorText(err) }
  }
}

export { storeGeneratedImage }
