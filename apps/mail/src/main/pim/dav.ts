import { createDAVClient } from 'tsdav'

/**
 * CalDAV / CardDAV connections (tsdav) and plain .ics downloads, with the
 * timeouts and error wording the rest of the module relies on.
 */

export type DavClient = Awaited<ReturnType<typeof createDAVClient>>
export type DavKind = 'caldav' | 'carddav'

const TIMEOUT_MS = 30_000
const MAX_ICS_BYTES = 25 * 1024 * 1024

/** every request gets its own deadline (a shared AbortSignal would fire once for all) */
export function timeoutFetch(ms = TIMEOUT_MS): typeof fetch {
  return (input, init) => fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(ms) })
}

/** webcal:// → https://, a bare host → https://host */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  if (/^webcals?:\/\//i.test(trimmed)) return trimmed.replace(/^webcals?:/i, 'https:')
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return `https://${trimmed}`
  return trimmed
}

const clients = new Map<string, Promise<DavClient>>()

/**
 * A logged-in client (principal and home discovery done). Cached per
 * source+credentials; `forget` drops it after a failure or an edit.
 */
export function connectDav(
  key: string,
  kind: DavKind,
  url: string,
  user: string,
  password: string,
): Promise<DavClient> {
  const cacheKey = `${key}\n${kind}\n${url}\n${user}\n${password.length}`
  let pending = clients.get(cacheKey)
  if (!pending) {
    pending = createDAVClient({
      serverUrl: normalizeUrl(url),
      credentials: { username: user, password },
      authMethod: 'Basic',
      defaultAccountType: kind,
      fetch: timeoutFetch(),
    })
    clients.set(cacheKey, pending)
    pending.catch(() => clients.delete(cacheKey))
  }
  return pending
}

export function forgetDav(key: string): void {
  for (const k of clients.keys()) if (k.startsWith(`${key}\n`)) clients.delete(k)
}

/** the body of an .ics subscription (optionally with Basic auth) */
export async function fetchIcs(url: string, user?: string, password?: string): Promise<string> {
  const headers: Record<string, string> = { accept: 'text/calendar, */*;q=0.5' }
  if (user)
    headers.authorization = `Basic ${Buffer.from(`${user}:${password ?? ''}`).toString('base64')}`
  const res = await timeoutFetch()(normalizeUrl(url), { headers, redirect: 'follow' })
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
  const length = Number(res.headers.get('content-length') ?? 0)
  if (length > MAX_ICS_BYTES) throw new Error('Der Kalender ist zu groß (über 25 MB).')
  const text = await res.text()
  if (text.length > MAX_ICS_BYTES) throw new Error('Der Kalender ist zu groß (über 25 MB).')
  if (!/BEGIN:VCALENDAR/i.test(text))
    throw new Error('Unter dieser Adresse liegt kein Kalender (keine .ics-Datei).')
  return text
}

/** protocol and HTTP failures in words a person can act on */
export function friendlyDavError(err: unknown): Error {
  const e = err as {
    status?: number
    code?: string
    cause?: { code?: string }
    message?: string
    name?: string
  }
  const message = e?.message ?? String(err)
  const code = e?.code ?? e?.cause?.code
  const status = e?.status ?? Number(/\b(401|403|404|405|500|502|503)\b/.exec(message)?.[1] ?? 0)
  if (status === 401 || /unauthori[sz]ed|invalid credentials/i.test(message)) {
    return new Error('Anmeldung fehlgeschlagen. Benutzername und (App-)Passwort prüfen.')
  }
  if (status === 403)
    return new Error('Zugriff verweigert. Hat das Konto Rechte auf diesen Kalender?')
  if (status === 404 || /cannot find (homeUrl|principalUrl)/i.test(message)) {
    return new Error('Unter dieser Adresse wurde kein CalDAV/CardDAV-Dienst gefunden.')
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN')
    return new Error('Server nicht gefunden. Adresse prüfen.')
  if (code === 'ECONNREFUSED') return new Error('Der Server lehnt die Verbindung ab.')
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError' || code === 'ETIMEDOUT') {
    return new Error('Keine Antwort vom Server (Zeitüberschreitung).')
  }
  return err instanceof Error ? err : new Error(message)
}
