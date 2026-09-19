import type { AgentMessage, AgentToolDef } from '@genoffice/agent-core'
import { withOutputCapFallback } from './output-cap'
import { streamOpenAiCompatible } from './protocols/openai-compatible'
import type { StreamCallbacks } from './protocols/shared'
import { getProviderAdapter } from './registry'
import type { AiProviderConfig, AiProviderId } from './types'

export { streamOpenAiCompatible } from './protocols/openai-compatible'
export { sseLines } from './protocols/shared'
export type { StreamCallbacks } from './protocols/shared'

/** route a streaming, tool-calling turn to the local daemon */
export async function streamForProvider(
  provider: AiProviderId,
  config: AiProviderConfig,
  system: string,
  messages: AgentMessage[],
  tools: AgentToolDef[],
  maxTokens: number,
  cb: StreamCallbacks,
): Promise<void> {
  if (!config.model?.trim()) {
    throw new Error('No Ollama model selected. Pick one in Settings › AI.')
  }
  const endpoint = getProviderAdapter(provider).resolveEndpoint(config)
  const { baseUrl } = endpoint
  return withOutputCapFallback(baseUrl, config.model, maxTokens, (cap) =>
    streamOpenAiCompatible(baseUrl, config, system, messages, tools, cap, cb, {
      omitTemperature: endpoint.omitTemperature,
      bodyExtras: endpoint.bodyExtras,
    }),
  )
}
