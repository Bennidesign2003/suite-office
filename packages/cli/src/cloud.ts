import { join } from 'node:path'
import { setSearchProxyUrl } from '@genoffice/ai-search'
import { genofficeUserDataDir } from './gui'

/**
 * The network-facing commands (search / media) reuse the app's own settings:
 * the Ollama daemon for media analysis, and the search backend chosen in
 * Settings. That settings file lives in the app's user-data directory, which
 * the CLI has to locate on its own.
 */
export function aiSettingsPath(env: NodeJS.ProcessEnv): string {
  return env.GENOFFICE_AI_SETTINGS || join(genofficeUserDataDir(env), 'ai-settings.json')
}

/** First http(s) proxy in the usual environment variables, as the app's main process reads them. */
export function proxyUrlFromEnv(env: NodeJS.ProcessEnv): string | null {
  return (
    [
      env.HTTPS_PROXY,
      env.https_proxy,
      env.HTTP_PROXY,
      env.http_proxy,
      env.ALL_PROXY,
      env.all_proxy,
    ].find((v) => v && /^https?:\/\//.test(v)) ?? null
  )
}

let prepared = false

/**
 * Once per process: route outbound search through the environment's proxy.
 * Model traffic is deliberately left alone — it goes to a daemon on the
 * loopback interface, and sending that through a corporate proxy would both
 * fail and leak the prompt.
 */
export async function prepareCloud(env: NodeJS.ProcessEnv): Promise<void> {
  if (prepared) return
  prepared = true
  const proxy = proxyUrlFromEnv(env)
  if (!proxy) return
  setSearchProxyUrl(proxy)
  const { ProxyAgent, setGlobalDispatcher } = await import('undici')
  setGlobalDispatcher(new ProxyAgent(proxy))
}
