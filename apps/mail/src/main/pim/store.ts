import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { PimSource, PimSourceInput, SourceKind } from '../../shared/pim'
import type { SecretBox } from '../accounts'

/**
 * Calendar and address-book sources (local, CalDAV, CardDAV, ICS
 * subscriptions) in <userData>/pim/sources.json — private to the user, with
 * passwords sealed like the mail accounts' (OS keychain where available).
 * Also the JSON helpers the services use for their caches under <userData>/pim.
 */

export interface StoredSource {
  id: string
  kind: SourceKind
  name: string
  url?: string
  user?: string
  /** 'enc:' + base64 (safeStorage) or 'plain:' + password ('plain:' = none) */
  secret: string
  lastSync?: string
  error?: string
}

export function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

/** write-then-rename, so a crash never leaves half a file; readable by the user only */
export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
  renameSync(tmp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    // not supported on this file system
  }
}

export class SourceStore {
  /**
   * @param dir   <userData>/pim
   * @param box   Electron safeStorage, or null (browser build, tests)
   */
  constructor(
    private readonly dir: () => string,
    private readonly box: SecretBox | null,
  ) {}

  private file(): string {
    return join(this.dir(), 'sources.json')
  }

  private read(): StoredSource[] {
    const data = readJson<{ sources?: StoredSource[] }>(this.file(), {})
    return Array.isArray(data.sources) ? data.sources : []
  }

  private write(sources: StoredSource[]): void {
    writeJsonAtomic(this.file(), { version: 1, sources })
  }

  seal(password: string): string {
    if (!password) return 'plain:'
    try {
      if (this.box?.isEncryptionAvailable()) {
        return 'enc:' + this.box.encryptString(password).toString('base64')
      }
    } catch {
      // keychain refused; fall through to the private file
    }
    return 'plain:' + password
  }

  password(source: StoredSource): string {
    if (source.secret.startsWith('plain:')) return source.secret.slice('plain:'.length)
    if (source.secret.startsWith('enc:') && this.box) {
      return this.box.decryptString(Buffer.from(source.secret.slice('enc:'.length), 'base64'))
    }
    throw new Error(
      'Das gespeicherte Passwort kann nicht entschlüsselt werden. Bitte neu eingeben.',
    )
  }

  static info(source: StoredSource): PimSource {
    return {
      id: source.id,
      kind: source.kind,
      name: source.name,
      ...(source.url ? { url: source.url } : {}),
      ...(source.user ? { user: source.user } : {}),
      hasPassword: source.secret !== 'plain:',
      ...(source.lastSync ? { lastSync: source.lastSync } : {}),
      ...(source.error ? { error: source.error } : {}),
    }
  }

  list(): StoredSource[] {
    return this.read()
  }

  get(id: string): StoredSource | undefined {
    return this.read().find((s) => s.id === id)
  }

  /**
   * A stored source merged with form input. An empty password keeps the old
   * one; `borrowed` (user + password of a mail account) fills both when given.
   */
  resolve(input: PimSourceInput, borrowed?: { user: string; password: string }): StoredSource {
    const existing = input.id ? this.get(input.id) : undefined
    const password = borrowed?.password ?? input.password ?? ''
    return {
      id: existing?.id ?? input.id ?? randomUUID(),
      kind: input.kind,
      name: input.name.trim() || existing?.name || '',
      ...(input.url?.trim() ? { url: input.url.trim() } : {}),
      ...((borrowed?.user ?? input.user)?.trim()
        ? { user: (borrowed?.user ?? input.user)!.trim() }
        : {}),
      secret: password ? this.seal(password) : (existing?.secret ?? 'plain:'),
      ...(existing?.lastSync ? { lastSync: existing.lastSync } : {}),
    }
  }

  save(source: StoredSource): StoredSource {
    const sources = this.read()
    const at = sources.findIndex((s) => s.id === source.id)
    if (at >= 0) sources[at] = source
    else sources.push(source)
    this.write(sources)
    return source
  }

  /** record the outcome of a sync without touching anything else */
  markSynced(id: string, error?: string): void {
    const sources = this.read()
    const source = sources.find((s) => s.id === id)
    if (!source) return
    if (error) source.error = error
    else {
      delete source.error
      source.lastSync = new Date().toISOString()
    }
    this.write(sources)
  }

  remove(id: string): void {
    this.write(this.read().filter((s) => s.id !== id))
  }

  /** the one local calendar/address-book source, created on first use */
  ensureLocal(name: string): StoredSource {
    const local = this.read().find((s) => s.kind === 'local')
    if (local) return local
    return this.save({ id: 'local', kind: 'local', name, secret: 'plain:' })
  }
}
