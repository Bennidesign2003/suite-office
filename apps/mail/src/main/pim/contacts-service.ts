import { createHash, randomUUID } from 'node:crypto'
import { rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type {
  AddressBookInfo,
  AddressSuggestion,
  Contact,
  ContactInput,
  LabeledValue,
} from '../../shared/pim'
import { connectDav, forgetDav, friendlyDavError, timeoutFetch, type DavClient } from './dav'
import { readJson, writeJsonAtomic, type SourceStore, type StoredSource } from './store'
import {
  normalizeBirthday,
  parseVcard,
  parseVcards,
  serializeVcard,
  type CardFields,
  type ParsedCard,
} from './vcard'

/**
 * Address books: one on this computer (<pim>/local-contacts.json) and every
 * CardDAV server's, mirrored into <pim>/carddav-<source>.json so the list,
 * search and address completion work offline and instantly. Writes go to the
 * server first (with the ETag, so a concurrent edit elsewhere is never
 * overwritten) and only then into the mirror. Also remembers whom the user
 * writes to, for completing addresses of people who are not contacts.
 */

interface CachedObject {
  url: string
  etag: string
  vcf: string
}

interface CachedBook {
  /** stable part of the address book id: the collection's last path segment */
  key: string
  url: string
  displayName: string
  ctag?: string
  syncToken?: string
  readOnly: boolean
  objects: CachedObject[]
}

interface CardDavCache {
  version: 1
  /** the source's server and user when the mirror was made; a changed login starts over */
  url: string
  user: string
  books: CachedBook[]
}

interface LocalFile {
  version: 1
  books: Array<{ id: string; name: string }>
  /** book id → uid → vCard text */
  cards: Record<string, Record<string, string>>
}

interface RecentEntry {
  name: string
  email: string
  count: number
  /** ISO time */
  lastUsed: string
}

type RecentMap = Record<string, RecentEntry>

interface SuggestEntry {
  name: string
  email: string
}

interface Snapshot {
  sig: string
  books: AddressBookInfo[]
  /** sorted by name */
  contacts: Contact[]
  /** one per e-mail address of a contact */
  addresses: SuggestEntry[]
}

type Target =
  | { kind: 'local'; bookId: string }
  | { kind: 'remote'; bookId: string; source: StoredSource; key: string }

const LOCAL_FILE = 'local-contacts.json'
const RECENT_FILE = 'recent-recipients.json'
const MAX_RECENT = 500
const DEFAULT_SUGGESTIONS = 8
/** vCards per addressbook-multiget: photos make them big, and each request has a deadline */
const MULTIGET_CHUNK = 40
const PARALLEL_REQUESTS = 4
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+$/

const collator = new Intl.Collator('de', { sensitivity: 'base', numeric: true })

/** lower case, accents and ß folded; "Müller" also reads as "mueller" */
function fold(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').replace(/ß/g, 'ss').toLowerCase()
}

function searchable(value: string): string {
  const lower = value.toLowerCase()
  const umlauts = lower.replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
  return umlauts === lower ? fold(value) : `${fold(value)}\n${fold(umlauts)}`
}

function tokens(query: string): string[] {
  return fold(String(query ?? ''))
    .split(/[\s,;<>"]+/)
    .filter(Boolean)
}

/** changes whenever the file is replaced (writes are write-then-rename) */
function stamp(path: string): string {
  try {
    const st = statSync(path)
    return `${st.mtimeMs}:${st.size}:${st.ino}`
  } catch {
    return '-'
  }
}

function hash(text: string): string {
  return createHash('sha1').update(text).digest('base64')
}

function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

/** servers answer with differently encoded hrefs for the same object */
function urlKey(url: string): string {
  try {
    const u = new URL(url)
    let path = u.pathname
    try {
      path = decodeURIComponent(path)
    } catch {
      // keep it encoded
    }
    return path.replace(/\/+$/, '')
  } catch {
    return url.replace(/\/+$/, '')
  }
}

function keyFor(url: string): string {
  const path = urlKey(url)
  return path.slice(path.lastIndexOf('/') + 1) || path || url
}

function uidFromUrl(url: string): string {
  const path = urlKey(url)
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.vcf$/i, '')
}

function fileNameFor(uid: string): string {
  return /^[A-Za-z0-9._@-]{1,200}$/.test(uid) ? uid : randomUUID()
}

/** a weak ETag can never match If-Match; sending none beats a permanent conflict */
function ifMatch(etag: string): string | undefined {
  return etag && !etag.startsWith('W/') ? etag : undefined
}

function etagOf(res: Response): string {
  return res.headers?.get('etag') ?? ''
}

function vcardText(data: unknown): string {
  const value =
    typeof data === 'string'
      ? data
      : data && typeof data === 'object'
        ? ((data as { _cdata?: unknown; _text?: unknown })._cdata ??
          (data as { _text?: unknown })._text)
        : undefined
  return typeof value === 'string' && /BEGIN:VCARD/i.test(value) ? value : ''
}

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function labeled(list: unknown): LabeledValue[] {
  if (!Array.isArray(list)) return []
  return list
    .filter((v): v is LabeledValue => !!v && typeof (v as LabeledValue).value === 'string')
    .map((v) => ({ type: str(v.type).toLowerCase(), value: v.value.trim() }))
    .filter((v) => v.value)
}

function toContact(
  card: ParsedCard,
  addressBookId: string,
  uid: string,
  readOnly: boolean,
): Contact {
  return {
    id: `${addressBookId}|${uid}`,
    uid,
    addressBookId,
    name: card.name,
    firstName: card.firstName,
    lastName: card.lastName,
    emails: card.emails.map((v) => ({ ...v })),
    phones: card.phones.map((v) => ({ ...v })),
    organization: card.organization,
    jobTitle: card.jobTitle,
    birthday: card.birthday,
    addresses: card.addresses.map((v) => ({ ...v })),
    note: card.note,
    ...(card.photo ? { photo: card.photo } : {}),
    readOnly,
  }
}

function fieldsOf(card: ParsedCard, uid: string): CardFields {
  return {
    uid,
    name: card.name,
    firstName: card.firstName,
    lastName: card.lastName,
    emails: card.emails,
    phones: card.phones,
    organization: card.organization,
    jobTitle: card.jobTitle,
    birthday: card.birthday,
    addresses: card.addresses,
    note: card.note,
    ...(card.photo ? { photo: card.photo } : {}),
  }
}

/** what the user sees of a card — equal means an import would add nothing */
function fingerprint(card: ParsedCard): string {
  return JSON.stringify({ ...fieldsOf(card, ''), photo: card.photo ?? '' })
}

function writeError(status: number): Error {
  if (status === 401)
    return new Error('Anmeldung fehlgeschlagen. Benutzername und (App-)Passwort prüfen.')
  if (status === 403) return new Error('Keine Schreibrechte für dieses Adressbuch.')
  if (status === 404 || status === 409) {
    return new Error('Das Adressbuch gibt es auf dem Server nicht mehr. Bitte neu synchronisieren.')
  }
  if (status === 413)
    return new Error('Der Kontakt ist zu groß für den Server (Foto verkleinern?).')
  if (status === 400 || status === 415 || status === 422) {
    return new Error('Der Server hat den Kontakt als ungültig abgelehnt.')
  }
  if (status === 507) return new Error('Auf dem Server ist kein Speicherplatz mehr frei.')
  return new Error(`Der Server hat die Änderung nicht angenommen (HTTP ${status}).`)
}

const READ_ONLY = 'Dieses Adressbuch ist schreibgeschützt.'
const CONFLICT =
  'Der Kontakt wurde inzwischen an anderer Stelle geändert. Die aktuelle Fassung ist jetzt geladen – bitte die Änderung noch einmal vornehmen.'

async function inParallel<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await work(items[next++]!)
  })
  await Promise.all(runners)
}

export class ContactsService {
  private memo = new Map<string, ParsedCard | null>()
  private snap: Snapshot | null = null
  /** bumped by every write of this service, in case a file's stamp does not move */
  private generation = 0
  private recent: { sig: string; data: RecentMap } | null = null
  private chains = new Map<string, Promise<void>>()

  constructor(
    private readonly opts: { dir: () => string; sources: SourceStore; localName: string },
  ) {}

  // ---- files ----

  private localPath(): string {
    return join(this.opts.dir(), LOCAL_FILE)
  }

  private cachePath(sourceId: string): string {
    return join(this.opts.dir(), `carddav-${sourceId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`)
  }

  private recentPath(): string {
    return join(this.opts.dir(), RECENT_FILE)
  }

  private localSource(): StoredSource {
    return this.opts.sources.ensureLocal(this.opts.localName)
  }

  private defaultBookId(): string {
    return `${this.localSource().id}:contacts`
  }

  private readLocal(): LocalFile {
    const raw = readJson<Partial<LocalFile> | null>(this.localPath(), null)
    const books = (Array.isArray(raw?.books) ? raw.books : [])
      .filter((b) => b && typeof b.id === 'string' && b.id)
      .map((b) => ({ id: b.id, name: str(b.name) || this.opts.localName }))
    const defaultId = this.defaultBookId()
    if (!books.some((b) => b.id === defaultId))
      books.unshift({ id: defaultId, name: this.opts.localName })
    // UIDs come from files: "__proto__" must be a key like any other
    const cards: LocalFile['cards'] = Object.create(null)
    if (raw?.cards && typeof raw.cards === 'object') {
      for (const [bookId, map] of Object.entries(raw.cards)) {
        if (!map || typeof map !== 'object') continue
        cards[bookId] = Object.create(null)
        for (const [uid, vcf] of Object.entries(map)) {
          if (typeof vcf === 'string') cards[bookId][uid] = vcf
        }
      }
    }
    return { version: 1, books, cards }
  }

  private writeLocal(file: LocalFile): void {
    writeJsonAtomic(this.localPath(), file)
    this.generation++
  }

  private readCache(source: StoredSource): CardDavCache {
    const empty: CardDavCache = {
      version: 1,
      url: source.url ?? '',
      user: source.user ?? '',
      books: [],
    }
    const raw = readJson<Partial<CardDavCache> | null>(this.cachePath(source.id), null)
    if (
      !raw ||
      typeof raw !== 'object' ||
      !Array.isArray(raw.books) ||
      (raw.url ?? '') !== empty.url ||
      (raw.user ?? '') !== empty.user
    ) {
      return empty
    }
    const books: CachedBook[] = []
    for (const b of raw.books as Array<Partial<CachedBook>>) {
      if (!b || typeof b.url !== 'string' || typeof b.key !== 'string') continue
      books.push({
        key: b.key,
        url: b.url,
        displayName: str(b.displayName),
        ...(typeof b.ctag === 'string' && b.ctag ? { ctag: b.ctag } : {}),
        ...(typeof b.syncToken === 'string' && b.syncToken ? { syncToken: b.syncToken } : {}),
        readOnly: b.readOnly === true,
        objects: (Array.isArray(b.objects) ? b.objects : [])
          .filter((o) => o && typeof o.url === 'string' && typeof o.vcf === 'string')
          .map((o) => ({ url: o.url, etag: typeof o.etag === 'string' ? o.etag : '', vcf: o.vcf })),
      })
    }
    return { ...empty, books }
  }

  private writeCache(source: StoredSource, cache: CardDavCache): void {
    // a sync that outlived its source must not bring the deleted mirror back
    if (!this.opts.sources.get(source.id)) return
    writeJsonAtomic(this.cachePath(source.id), {
      ...cache,
      url: source.url ?? '',
      user: source.user ?? '',
    })
    this.generation++
  }

  private readRecent(): RecentMap {
    const path = this.recentPath()
    const sig = stamp(path)
    if (this.recent?.sig === sig) return this.recent.data
    const raw = readJson<unknown>(path, {})
    const data: RecentMap = {}
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, v] of Object.entries(raw as Record<string, Partial<RecentEntry>>)) {
        if (!v || typeof v.email !== 'string' || !v.email) continue
        data[key] = {
          name: str(v.name),
          email: v.email,
          count: typeof v.count === 'number' && v.count > 0 ? v.count : 1,
          lastUsed: typeof v.lastUsed === 'string' ? v.lastUsed : '',
        }
      }
    }
    this.recent = { sig, data }
    return data
  }

  // ---- parsed view ----

  private parseCached(vcf: string, memo = this.memo): ParsedCard | null {
    const key = hash(vcf)
    // null (not a usable card) is a result too: only undefined means "not parsed yet"
    let card = memo.has(key) ? memo.get(key) : this.memo.get(key)
    if (card === undefined) card = parseVcard(vcf)
    memo.set(key, card)
    return card
  }

  /**
   * A remote book's cards with the uid each is addressed by: its UID, or —
   * for cards without one or with a duplicate — the object's file name.
   */
  private entries(
    book: CachedBook,
    memo?: Map<string, ParsedCard | null>,
  ): Array<{ uid: string; card: ParsedCard; obj: CachedObject }> {
    const seen = new Set<string>()
    const out: Array<{ uid: string; card: ParsedCard; obj: CachedObject }> = []
    for (const obj of book.objects) {
      const card = this.parseCached(obj.vcf, memo)
      if (!card) continue
      let uid = card.uid
      if (!uid || seen.has(uid)) uid = uidFromUrl(obj.url)
      if (!uid || seen.has(uid)) continue
      seen.add(uid)
      out.push({ uid, card, obj })
    }
    return out
  }

  private carddavSources(): StoredSource[] {
    return this.opts.sources.list().filter((s) => s.kind === 'carddav')
  }

  private signature(): string {
    const parts = [String(this.generation), this.defaultBookId(), stamp(this.localPath())]
    for (const s of this.carddavSources()) {
      parts.push(
        `${s.id}\n${s.name}\n${s.url ?? ''}\n${s.user ?? ''}\n${stamp(this.cachePath(s.id))}`,
      )
    }
    return parts.join('|')
  }

  private snapshot(): Snapshot {
    const sig = this.signature()
    if (this.snap?.sig === sig) return this.snap
    const memo = new Map<string, ParsedCard | null>()
    const books: AddressBookInfo[] = []
    const contacts: Contact[] = []

    const local = this.localSource()
    const file = this.readLocal()
    for (const book of file.books) {
      books.push({ id: book.id, sourceId: local.id, name: book.name, readOnly: false })
      for (const [uid, vcf] of Object.entries(file.cards[book.id] ?? {})) {
        const card = this.parseCached(vcf, memo)
        if (card && card.kind !== 'group') contacts.push(toContact(card, book.id, uid, false))
      }
    }
    for (const source of this.carddavSources()) {
      for (const book of this.readCache(source).books) {
        const id = `${source.id}:${book.key}`
        books.push({
          id,
          sourceId: source.id,
          name: book.displayName || source.name,
          readOnly: book.readOnly,
        })
        for (const e of this.entries(book, memo)) {
          if (e.card.kind !== 'group') contacts.push(toContact(e.card, id, e.uid, book.readOnly))
        }
      }
    }
    contacts.sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id))
    const addresses: SuggestEntry[] = []
    for (const c of contacts) {
      for (const e of c.emails)
        if (e.value.includes('@')) addresses.push({ name: c.name, email: e.value })
    }
    // only what the current files use stays memoized
    this.memo = memo
    this.snap = { sig, books, contacts, addresses }
    return this.snap
  }

  // ---- CardDAV ----

  /** one write or sync per source at a time: they all rewrite the same mirror */
  private exclusive<T>(sourceId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(sourceId) ?? Promise.resolve()
    const run = previous.then(work, work)
    const tail = run.then(
      () => undefined,
      () => undefined,
    )
    this.chains.set(sourceId, tail)
    void tail.then(() => {
      if (this.chains.get(sourceId) === tail) this.chains.delete(sourceId)
    })
    return run
  }

  private async client(source: StoredSource): Promise<DavClient> {
    if (!source.url) throw new Error('Für dieses Adressbuch ist keine Serveradresse hinterlegt.')
    const password = this.opts.sources.password(source)
    try {
      return await connectDav(source.id, 'carddav', source.url, source.user ?? '', password)
    } catch (err) {
      forgetDav(source.id)
      throw friendlyDavError(err)
    }
  }

  private async net<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work()
    } catch (err) {
      throw friendlyDavError(err)
    }
  }

  private async readOnlyOf(client: DavClient, url: string): Promise<boolean> {
    const res = await client.propfind({
      url,
      props: { 'd:current-user-privilege-set': {} },
      depth: '0',
    })
    const set: unknown = res[0]?.props?.currentUserPrivilegeSet
    // servers that do not report privileges get the benefit of the doubt
    if (!set || typeof set !== 'object') return false
    return !/"(all|write|writeContent|bind)"/.test(JSON.stringify(set))
  }

  /** the book's vCards by URL and ETag (a PROPFIND works on every server) */
  private async listObjects(
    client: DavClient,
    bookUrl: string,
  ): Promise<Array<{ url: string; etag: string }>> {
    const res = await client.propfind({
      url: bookUrl,
      props: { 'd:getetag': {}, 'd:resourcetype': {} },
      depth: '1',
    })
    const failed = res.length === 1 && !res[0]!.ok && !res[0]!.props ? res[0] : undefined
    if (failed) throw Object.assign(new Error(`HTTP ${failed.status}`), { status: failed.status })
    const base = withSlash(bookUrl)
    const self = urlKey(base)
    const out: Array<{ url: string; etag: string }> = []
    for (const r of res) {
      if (!r.href || !r.ok) continue
      let url: string
      try {
        url = new URL(r.href, base).href
      } catch {
        continue
      }
      if (urlKey(url) === self) continue
      const type: unknown = r.props?.resourcetype
      if (type && typeof type === 'object' && 'collection' in type) continue
      const etag: unknown = r.props?.getetag
      out.push({ url, etag: etag == null ? '' : String(etag) })
    }
    return out
  }

  /** plain GET, for servers without addressbook-multiget and for PUTs that return no ETag */
  private async getObject(source: StoredSource, url: string): Promise<CachedObject | null> {
    const password = this.opts.sources.password(source)
    const auth = Buffer.from(`${source.user ?? ''}:${password}`).toString('base64')
    const res = await timeoutFetch()(url, {
      headers: {
        authorization: `Basic ${auth}`,
        accept: 'text/vcard, text/x-vcard;q=0.9, */*;q=0.5',
      },
    })
    if (!res.ok) return null
    const vcf = vcardText(await res.text())
    return vcf ? { url, etag: etagOf(res), vcf } : null
  }

  /**
   * The book's objects after a change: unchanged ETags keep their cached
   * card, the rest is fetched. `complete` is false when something could not
   * be fetched — the book's ctag is then not recorded, so the next sync looks again.
   */
  private async refreshBook(
    client: DavClient,
    source: StoredSource,
    bookUrl: string,
    previous: CachedObject[],
  ): Promise<{ objects: CachedObject[]; complete: boolean }> {
    const listing = await this.listObjects(client, bookUrl)
    const known = new Map(previous.map((o) => [urlKey(o.url), o]))
    const missing = listing.filter((item) => {
      const old = known.get(urlKey(item.url))
      return !(old && item.etag && old.etag === item.etag)
    })
    const fetched = new Map<string, CachedObject>()
    for (let i = 0; i < missing.length; i += MULTIGET_CHUNK) {
      const chunk = missing.slice(i, i + MULTIGET_CHUNK)
      const cards = await client.fetchVCards({
        addressBook: { url: bookUrl },
        objectUrls: chunk.map((m) => m.url),
      })
      for (const c of cards) {
        const vcf = vcardText(c.data)
        if (!vcf || typeof c.url !== 'string') continue
        fetched.set(urlKey(c.url), { url: c.url, etag: c.etag == null ? '' : String(c.etag), vcf })
      }
    }
    if (missing.length && fetched.size === 0) {
      await inParallel(missing, PARALLEL_REQUESTS, async (m) => {
        const obj = await this.getObject(source, m.url).catch(() => null)
        if (obj) fetched.set(urlKey(m.url), obj)
      })
    }
    let complete = true
    const objects: CachedObject[] = []
    for (const item of listing) {
      const k = urlKey(item.url)
      const got = fetched.get(k)
      if (got) {
        objects.push({ url: item.url, etag: got.etag || item.etag, vcf: got.vcf })
        continue
      }
      const old = known.get(k)
      if (old && item.etag && old.etag === item.etag) {
        objects.push(old)
        continue
      }
      complete = false
      // stale beats gone: the next sync fetches it again
      if (old) objects.push(old)
    }
    return { objects, complete }
  }

  private async syncLocked(source: StoredSource): Promise<void> {
    const client = await this.client(source)
    const remote = await this.net(() => client.fetchAddressBooks())
    const cache = this.readCache(source)
    const books: CachedBook[] = []
    const keys = new Set<string>()
    for (const book of remote) {
      if (!book || typeof book.url !== 'string' || !book.url) continue
      const prev = cache.books.find((b) => urlKey(b.url) === urlKey(book.url))
      let key = prev?.key ?? keyFor(book.url)
      while (keys.has(key)) key += '_'
      keys.add(key)
      const ctag = book.ctag == null || book.ctag === '' ? undefined : String(book.ctag)
      const syncToken =
        book.syncToken == null || book.syncToken === '' ? undefined : String(book.syncToken)
      const displayName = typeof book.displayName === 'string' ? book.displayName.trim() : ''
      const unchanged =
        !!prev &&
        ((ctag !== undefined && ctag === prev.ctag) ||
          (ctag === undefined && syncToken !== undefined && syncToken === prev.syncToken))
      if (prev && unchanged) {
        books.push({ ...prev, key, url: book.url, displayName: displayName || prev.displayName })
        continue
      }
      const readOnly = await this.readOnlyOf(client, book.url).catch(() => prev?.readOnly ?? false)
      const { objects, complete } = await this.net(() =>
        this.refreshBook(client, source, book.url, prev?.objects ?? []),
      )
      books.push({
        key,
        url: book.url,
        displayName,
        ...(complete && ctag ? { ctag } : {}),
        ...(complete && syncToken ? { syncToken } : {}),
        readOnly,
        objects,
      })
    }
    this.writeCache(source, { version: 1, url: source.url ?? '', user: source.user ?? '', books })
  }

  /** where a book id points; throws when it no longer exists */
  private target(addressBookId: string): Target {
    const bookId = String(addressBookId ?? '')
    if (bookId.startsWith(`${this.localSource().id}:`)) {
      if (this.readLocal().books.some((b) => b.id === bookId)) return { kind: 'local', bookId }
      throw new Error('Dieses Adressbuch gibt es nicht mehr.')
    }
    const at = bookId.indexOf(':')
    const source = at > 0 ? this.opts.sources.get(bookId.slice(0, at)) : undefined
    if (!source || source.kind !== 'carddav') {
      throw new Error('Dieses Adressbuch gibt es nicht mehr.')
    }
    return { kind: 'remote', bookId, source, key: bookId.slice(at + 1) }
  }

  /** the mirrored book, fresh from disk (inside `exclusive`) */
  private remoteBook(target: Extract<Target, { kind: 'remote' }>) {
    const source = this.opts.sources.get(target.source.id) ?? target.source
    const cache = this.readCache(source)
    const book = cache.books.find((b) => b.key === target.key)
    if (!book) {
      throw new Error(
        'Dieses Adressbuch wurde auf dem Server nicht gefunden. Bitte neu synchronisieren.',
      )
    }
    return { source, cache, book }
  }

  // ---- public API ----

  /** CardDAV: log in and look for address books, without keeping the connection */
  async testSource(source: StoredSource, password: string): Promise<void> {
    if (source.kind !== 'carddav') return
    if (!source.url?.trim()) throw new Error('Bitte die Adresse des Servers angeben.')
    // its own client key: a test must really log in with the typed password
    const key = `${source.id}#test`
    forgetDav(key)
    try {
      const client = await connectDav(key, 'carddav', source.url, source.user ?? '', password)
      const books = await client.fetchAddressBooks()
      if (!books.length) throw new Error('Auf dem Server wurde kein Adressbuch gefunden.')
    } catch (err) {
      throw friendlyDavError(err)
    } finally {
      forgetDav(key)
    }
  }

  async syncSource(source: StoredSource): Promise<void> {
    if (source.kind !== 'carddav') return
    await this.exclusive(source.id, () => this.syncLocked(source))
  }

  /** after a source was edited or removed; a removed one's mirror is deleted */
  forgetSource(sourceId: string): void {
    this.snap = null
    this.generation++
    if (this.opts.sources.get(sourceId)) return
    try {
      rmSync(this.cachePath(sourceId), { force: true })
    } catch {
      // already gone
    }
  }

  listAddressBooks(): AddressBookInfo[] {
    return this.snapshot().books.map((b) => ({ ...b }))
  }

  async listContacts(query?: string): Promise<Contact[]> {
    const { contacts } = this.snapshot()
    const words = tokens(query ?? '')
    if (!words.length) return [...contacts]
    const raw = String(query ?? '').trim()
    const digits = /^[\d\s+()/.-]+$/.test(raw) ? raw.replace(/\D/g, '') : ''
    return contacts.filter((c) => {
      if (digits.length >= 3 && c.phones.some((p) => p.value.replace(/\D/g, '').includes(digits))) {
        return true
      }
      const hay = searchable(
        [
          c.name,
          c.firstName,
          c.lastName,
          c.organization,
          ...c.emails.map((e) => e.value),
          ...c.phones.map((p) => p.value),
        ].join('\n'),
      )
      return words.every((w) => hay.includes(w))
    })
  }

  async saveContact(input: ContactInput): Promise<Contact> {
    const target = this.target(input?.addressBookId)
    const uid = str(input.uid) || randomUUID()
    const birthday = str(input.birthday)
    if (birthday && !normalizeBirthday(birthday)) throw new Error('Das Geburtsdatum ist ungültig.')
    const fields: CardFields = {
      uid,
      name: str(input.name),
      firstName: str(input.firstName),
      lastName: str(input.lastName),
      emails: labeled(input.emails),
      phones: labeled(input.phones),
      organization: str(input.organization),
      jobTitle: str(input.jobTitle),
      birthday,
      addresses: labeled(input.addresses),
      note: typeof input.note === 'string' ? input.note : '',
      ...(typeof input.photo === 'string' && input.photo.startsWith('data:')
        ? { photo: input.photo }
        : {}),
    }
    if (
      !fields.name &&
      !fields.firstName &&
      !fields.lastName &&
      !fields.organization &&
      !fields.emails!.length &&
      !fields.phones!.length
    ) {
      throw new Error('Bitte einen Namen, eine E-Mail-Adresse oder eine Telefonnummer angeben.')
    }

    if (target.kind === 'local') {
      const file = this.readLocal()
      const cards = (file.cards[target.bookId] ??= Object.create(null))
      const vcf = serializeVcard(fields, cards[uid])
      const card = parseVcard(vcf)
      if (!card) throw new Error('Der Kontakt konnte nicht gespeichert werden.')
      cards[uid] = vcf
      this.writeLocal(file)
      return toContact(card, target.bookId, uid, false)
    }

    return this.exclusive(target.source.id, async () => {
      const { source, cache, book } = this.remoteBook(target)
      if (book.readOnly) throw new Error(READ_ONLY)
      const entry = this.entries(book).find((e) => e.uid === uid)
      const vcf = serializeVcard(fields, entry?.obj.vcf)
      const client = await this.client(source)
      let obj: CachedObject
      if (entry) {
        const res = await this.net(() =>
          client.updateVCard({
            vCard: { url: entry.obj.url, etag: ifMatch(entry.obj.etag), data: vcf },
          }),
        )
        if (res.status === 412) {
          await this.syncLocked(source).catch(() => undefined)
          throw new Error(CONFLICT)
        }
        if (!res.ok) throw writeError(res.status)
        obj = entry.obj
        obj.vcf = vcf
        obj.etag = etagOf(res)
      } else {
        const filename = `${fileNameFor(uid)}.vcf`
        const res = await this.net(() =>
          client.createVCard({ addressBook: { url: book.url }, vCardString: vcf, filename }),
        )
        if (res.status === 412) throw new Error('Auf dem Server gibt es diesen Kontakt schon.')
        if (!res.ok) throw writeError(res.status)
        const fallback = new URL(filename, withSlash(book.url)).href
        const location = res.headers?.get('location')
        obj = {
          url: location ? new URL(location, fallback).href : fallback,
          etag: etagOf(res),
          vcf,
        }
        book.objects.push(obj)
      }
      // without an ETag the next edit could not be guarded: ask for the stored copy
      if (!obj.etag) {
        const stored = await this.getObject(source, obj.url).catch(() => null)
        if (stored) {
          obj.etag = stored.etag
          obj.vcf = stored.vcf
        }
      }
      this.writeCache(source, cache)
      const card = this.parseCached(obj.vcf) ?? parseVcard(vcf)
      if (!card) throw new Error('Der Kontakt konnte nicht gespeichert werden.')
      return toContact(card, target.bookId, uid, false)
    })
  }

  async deleteContact(addressBookId: string, uid: string): Promise<void> {
    const target = this.target(addressBookId)
    if (target.kind === 'local') {
      const file = this.readLocal()
      const cards = file.cards[target.bookId]
      if (!cards || cards[uid] === undefined) return
      delete cards[uid]
      this.writeLocal(file)
      return
    }
    await this.exclusive(target.source.id, async () => {
      const { source, cache, book } = this.remoteBook(target)
      const entry = this.entries(book).find((e) => e.uid === uid)
      if (!entry) return
      if (book.readOnly) throw new Error(READ_ONLY)
      const client = await this.client(source)
      const res = await this.net(() =>
        client.deleteVCard({ vCard: { url: entry.obj.url, etag: ifMatch(entry.obj.etag) } }),
      )
      if (res.status === 412) {
        await this.syncLocked(source).catch(() => undefined)
        throw new Error(CONFLICT)
      }
      // gone already is what we wanted
      if (!res.ok && res.status !== 404 && res.status !== 410) throw writeError(res.status)
      book.objects = book.objects.filter((o) => o !== entry.obj)
      this.writeCache(source, cache)
    })
  }

  /**
   * Adds the file's contacts (converted to vCard 3.0, unknown properties
   * kept). A card the book already holds with the same content is skipped;
   * one whose UID is taken by a different card is added under a new UID —
   * nothing is ever overwritten.
   */
  async importVcf(addressBookId: string, text: string): Promise<number> {
    const target = this.target(addressBookId)
    const cards = parseVcards(String(text ?? '')).filter((c) => c.kind !== 'group')
    if (!cards.length) throw new Error('In der Datei wurden keine Kontakte gefunden.')

    // cards without a UID (Outlook) get a new one each time: recognize them by content
    const plan = (
      existing: Map<string, ParsedCard | null>,
    ): Array<{ uid: string; vcf: string }> => {
      const present = new Set<string>()
      for (const card of existing.values()) if (card) present.add(fingerprint(card))
      const out: Array<{ uid: string; vcf: string }> = []
      for (const card of cards) {
        const print = fingerprint(card)
        if (present.has(print)) continue
        present.add(print)
        let uid = card.uid.trim() || randomUUID()
        if (existing.has(uid)) uid = randomUUID()
        existing.set(uid, card)
        out.push({ uid, vcf: serializeVcard(fieldsOf(card, uid), card.raw) })
      }
      return out
    }

    if (target.kind === 'local') {
      const file = this.readLocal()
      const book = (file.cards[target.bookId] ??= Object.create(null))
      const existing = new Map(
        Object.entries(book).map(([uid, vcf]) => [uid, this.parseCached(vcf)]),
      )
      const jobs = plan(existing)
      if (!jobs.length) return 0
      for (const job of jobs) book[job.uid] = job.vcf
      this.writeLocal(file)
      return jobs.length
    }

    return this.exclusive(target.source.id, async () => {
      const { source, cache, book } = this.remoteBook(target)
      if (book.readOnly) throw new Error(READ_ONLY)
      const existing = new Map<string, ParsedCard | null>(
        this.entries(book).map((e) => [e.uid, e.card]),
      )
      const jobs = plan(existing)
      if (!jobs.length) return 0
      const client = await this.client(source)
      let imported = 0
      let firstError: Error | null = null
      await inParallel(jobs, PARALLEL_REQUESTS, async (job) => {
        let { uid, vcf } = job
        try {
          for (let attempt = 0; attempt < 2; attempt++) {
            const filename = `${fileNameFor(uid)}.vcf`
            const res = await this.net(() =>
              client.createVCard({ addressBook: { url: book.url }, vCardString: vcf, filename }),
            )
            if (res.status === 412 && attempt === 0) {
              // the file name is taken on the server: a new identity avoids overwriting it
              uid = randomUUID()
              vcf = serializeVcard({ ...fieldsOf(parseVcard(vcf)!, uid) }, vcf)
              continue
            }
            if (!res.ok) throw writeError(res.status)
            const fallback = new URL(filename, withSlash(book.url)).href
            const location = res.headers?.get('location')
            book.objects.push({
              url: location ? new URL(location, fallback).href : fallback,
              etag: etagOf(res),
              vcf,
            })
            imported++
            return
          }
        } catch (err) {
          firstError ??= err instanceof Error ? err : new Error(String(err))
        }
      })
      if (imported) this.writeCache(source, cache)
      if (!imported && firstError) throw firstError
      return imported
    })
  }

  /** the book's cards as stored (any version, nothing dropped), one .vcf text */
  async exportVcf(addressBookId: string): Promise<string> {
    const target = this.target(addressBookId)
    const texts =
      target.kind === 'local'
        ? Object.values(this.readLocal().cards[target.bookId] ?? {})
        : this.remoteBook(target).book.objects.map((o) => o.vcf)
    const cards = texts
      .map((t) => t.replace(/\r\n?/g, '\n').trim().replace(/\n/g, '\r\n'))
      .filter(Boolean)
    return cards.length ? `${cards.join('\r\n')}\r\n` : ''
  }

  /**
   * Completion for address fields: every e-mail address of the contacts plus
   * the people the user wrote to. Prefix matches (start of the name, of a
   * name word or of the address) rank before matches inside; within a tier,
   * who is written to more often and more recently comes first.
   */
  suggest(query: string, limit = DEFAULT_SUGGESTIONS): AddressSuggestion[] {
    const words = tokens(query)
    if (!words.length) return []
    const max =
      Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : DEFAULT_SUGGESTIONS
    const whole = words.join(' ')
    /** 0: the name or address starts with the query, 1: words do, 2: found inside, -1: no match */
    const quality = (name: string, email: string): number => {
      const forms = searchable(name).split('\n')
      const e = fold(email)
      if (forms.some((f) => f.startsWith(whole)) || e.startsWith(whole)) return 0
      const nameWords = forms.flatMap((f) => f.split(/[^\p{L}\p{N}]+/u)).filter(Boolean)
      const emailWords = e
        .split('@')[0]!
        .split(/[._+-]+/)
        .filter(Boolean)
      let worst = 1
      for (const w of words) {
        if (nameWords.some((x) => x.startsWith(w)) || emailWords.some((x) => x.startsWith(w)))
          continue
        if (forms.some((f) => f.includes(w)) || e.includes(w)) worst = 2
        else return -1
      }
      return worst
    }

    const recents = this.readRecent()
    interface Candidate extends AddressSuggestion {
      quality: number
      count: number
      lastUsed: string
    }
    const found = new Map<string, Candidate>()
    const add = (name: string, email: string, kind: 'contact' | 'recent'): void => {
      const q = quality(name, email)
      if (q < 0) return
      const key = email.toLowerCase()
      const usage = recents[key]
      const prev = found.get(key)
      if (!prev) {
        found.set(key, {
          name,
          email,
          kind,
          quality: q,
          count: usage?.count ?? 0,
          lastUsed: usage?.lastUsed ?? '',
        })
        return
      }
      // contacts come first and keep their name: it beats what a header once said
      prev.quality = Math.min(prev.quality, q)
    }
    for (const entry of this.snapshot().addresses) add(entry.name, entry.email, 'contact')
    for (const entry of Object.values(recents)) add(entry.name, entry.email, 'recent')

    return [...found.values()]
      .sort(
        (a, b) =>
          a.quality - b.quality ||
          b.count - a.count ||
          (a.lastUsed < b.lastUsed ? 1 : a.lastUsed > b.lastUsed ? -1 : 0) ||
          (a.kind === b.kind ? 0 : a.kind === 'contact' ? -1 : 1) ||
          collator.compare(a.name || a.email, b.name || b.email),
      )
      .slice(0, max)
      .map(({ name, email, kind }) => ({ name, email, kind }))
  }

  /** counts a sent message's recipients; keeps the 500 most recently used */
  rememberRecipients(list: Array<{ name: string; email: string }>): void {
    if (!Array.isArray(list) || !list.length) return
    const data: RecentMap = { ...this.readRecent() }
    const now = new Date().toISOString()
    const seen = new Set<string>()
    for (const item of list) {
      const email = str(item?.email)
      if (email.length > 254 || !EMAIL_RE.test(email)) continue
      const key = email.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      let name = str(item?.name)
        .replace(/^["']+|["']+$/g, '')
        .trim()
        .slice(0, 200)
      if (name.toLowerCase() === key) name = ''
      const prev = data[key]
      data[key] = {
        name: name || prev?.name || '',
        email,
        count: (prev?.count ?? 0) + 1,
        lastUsed: now,
      }
    }
    if (!seen.size) return
    const kept = Object.entries(data)
      .sort(
        ([, a], [, b]) =>
          (a.lastUsed < b.lastUsed ? 1 : a.lastUsed > b.lastUsed ? -1 : 0) || b.count - a.count,
      )
      .slice(0, MAX_RECENT)
    const next: RecentMap = Object.fromEntries(kept)
    try {
      writeJsonAtomic(this.recentPath(), next)
      this.recent = { sig: stamp(this.recentPath()), data: next }
    } catch {
      // completion history is a convenience; a full disk must not fail sending
    }
  }
}
