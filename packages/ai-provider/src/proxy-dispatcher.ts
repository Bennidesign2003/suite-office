/**
 * Route the process's outbound fetch through an HTTP proxy — except the
 * model traffic. The Ollama daemon normally listens on the loopback
 * interface: sending that through a corporate proxy both fails and hands the
 * proxy every prompt. NO_PROXY is honoured as well, so a daemon on another
 * machine can be kept direct the usual way.
 */

const ALWAYS_DIRECT = ['localhost', '127.0.0.1', '::1', '[::1]']

export function noProxyList(
  env: NodeJS.ProcessEnv = process.env,
  extraHosts: string[] = [],
): string {
  return [env.NO_PROXY, env.no_proxy, ...ALWAYS_DIRECT, ...extraHosts]
    .filter((v): v is string => !!v && v.trim() !== '')
    .join(',')
}

export async function installProxyDispatcher(
  proxyUrl: string,
  options: { env?: NodeJS.ProcessEnv; directHosts?: string[] } = {},
): Promise<void> {
  const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici')
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
      noProxy: noProxyList(options.env, options.directHosts),
    }),
  )
}
