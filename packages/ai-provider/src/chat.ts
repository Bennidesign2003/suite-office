import { chatOpenAiCompatible } from './protocols/openai-compatible'
import { getProviderAdapter } from './registry'
import type { AiChatResponse, AiProviderConfig, AiProviderId } from './types'
import { AI_CHAT_RESPONSE_TIMEOUT_MS, createStreamWatchdog } from './watchdog'

/** route a one-shot (non-streaming, non-tool-calling) chat call */
export async function chatForProvider(
  provider: AiProviderId,
  config: AiProviderConfig,
  system: string,
  user: string,
  signal?: AbortSignal,
): Promise<AiChatResponse> {
  // non-streaming: the daemon generates the full answer before the headers arrive,
  // so the connect phase gets the long budget; the body read then gets the idle budget
  const wd = createStreamWatchdog(signal, AI_CHAT_RESPONSE_TIMEOUT_MS)
  return wd.guard(() => {
    if (!config.model?.trim()) {
      return Promise.resolve({
        ok: false as const,
        error: 'No Ollama model selected. Pick one in Settings › AI.',
      })
    }
    const endpoint = getProviderAdapter(provider).resolveEndpoint(config)
    return chatOpenAiCompatible(wd, endpoint.baseUrl, config, system, user, {
      omitTemperature: endpoint.omitTemperature,
      bodyExtras: endpoint.bodyExtras,
    })
  })
}
