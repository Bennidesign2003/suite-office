import {
  activeSearchProvider,
  aiConfigured,
  fetchOllamaCatalog,
  imageGenerationAvailable,
  mediaAnalysisAvailable,
  mediaAnalysisModel,
} from '@genoffice/ai-provider'
import { readAiSettingsFile } from '@genoffice/ai-search'
import { aiSettingsPath, prepareCloud } from '../cloud'
import type { CommandDef } from '../registry'
import { appLaunch } from '../resources'

/**
 * What this machine can actually do, read from Suite's own settings plus one
 * probe of the local daemon. Agents check this once before planning work that
 * needs a model, a picture read or web facts — the daemon probe matters
 * because a configured model that is not installed fails at the first turn.
 *
 * Unkeyed search fallbacks (DuckDuckGo) count as available but are reported
 * as `via: free`, so a caller that needs good results can tell the difference.
 */
export const capabilitiesCommand: CommandDef = {
  name: 'capabilities',
  summary:
    'Report which AI features (chat, media analysis, search, image search) are configured in Suite, whether the Ollama daemon is reachable, and whether the app is installed.',
  usage: 'capabilities',
  async run(_args, ctx) {
    await prepareCloud(ctx.env)
    const settings = readAiSettingsFile(aiSettingsPath(ctx.env))
    const catalog = await fetchOllamaCatalog(settings.providers.ollama.baseUrl)
    const chatModel = settings.providers.ollama.model
    const installed = new Set(catalog.models.map((m) => m.name))
    const usable = (model: string) => model !== '' && catalog.reachable && installed.has(model)
    const searchProvider = activeSearchProvider(settings)
    const detail = {
      ollama: {
        reachable: catalog.reachable,
        base_url: catalog.baseUrl,
        ...(catalog.version ? { version: catalog.version } : {}),
        installed_models: catalog.models.map((m) => m.name),
        ...(catalog.error ? { error: catalog.error } : {}),
      },
      chat: {
        available: usable(chatModel),
        model: chatModel || null,
        // a selected model the daemon does not serve is the one failure worth naming here
        ...(aiConfigured(settings) && !usable(chatModel) ? { reason: 'model not installed' } : {}),
      },
      media_analysis: {
        available: mediaAnalysisAvailable(settings) && usable(mediaAnalysisModel(settings)),
        model: mediaAnalysisModel(settings) || null,
      },
      image_generation: {
        available: imageGenerationAvailable(),
        reason: 'Ollama cannot generate images',
      },
      search: { available: true, via: searchProvider },
      image_search: {
        available: true,
        via: searchProvider === 'serper' ? 'serper' : 'free',
      },
      app: { available: appLaunch(ctx.env) !== null },
      settings_path: aiSettingsPath(ctx.env),
    }
    const on = (['chat', 'media_analysis', 'search', 'image_search'] as const).filter(
      (k) => detail[k].available,
    )
    return {
      summary: on.length ? `configured: ${on.join(', ')}` : 'no AI feature configured',
      detail,
    }
  },
}
