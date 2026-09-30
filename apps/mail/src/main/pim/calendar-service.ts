import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { DAVCalendar, DAVResponse } from 'tsdav'
import type {
  Attendee,
  CalendarEvent,
  CalendarInfo,
  EventInput,
  EventRange,
} from '../../shared/pim'
import { parseComponents } from './contentline'
import { connectDav, fetchIcs, forgetDav, friendlyDavError, type DavClient } from './dav'
import {
  alignTime,
  attendeeStatus,
  buildCalendarObject,
  dateFromMs,
  dateMs,
  deriveOccurrence,
  fromInstant,
  groupByUid,
  isRecurring,
  newEvent,
  normalizeRrule,
  parseIcs,
  partstatOf,
  sameTime,
  serializeRaw,
  timeAt,
  timeMs,
  toInstant,
  wallIn,
  wallMs,
  type EventGroup,
  type EventTime,
  type ParsedIcs,
  type VAttendee,
  type VEvent,
  type VEventFields,
} from './ics'
import {
  expandOccurrences,
  findOccurrence,
  generates,
  matchesOccurrence,
  occurrenceKey,
  type Occurrence,
} from './recurrence'
import { readJson, writeJsonAtomic, type SourceStore, type StoredSource } from './store'
import { formatUtc, resolveTimezone, systemTimezone, type WallTime } from './timezone'

/**
 * The calendars: the local one(s) on this computer, CalDAV collections and
 * read-only .ics subscriptions behind one API. Everything is served from
 * files under <userData>/pim, so the views work offline and fast; CalDAV
 * writes go to the server first and land in the cache only once accepted.
 *
 *   local-calendars.json      { calendars: [{id,name,color}], objects: {calendarId: {uid: ics}} }
 *   caldav-<sourceId>.json    collections (url, name, color, ctag, sync token, read-only)
 *                             with their objects {url, etag, ics}
 *   ics-<sourceId>.json       { text, fetchedAt } of a subscription
 *   calendar-settings.json    per calendar: color / visible / name chosen by the user
 */

export interface CalendarIdentity {
  accountId: string
  name: string
  email: string
}

export type ItipSender = (
  fromAccountId: string,
  to: string[],
  subject: string,
  text: string,
  ics: string,
  method: 'REQUEST' | 'CANCEL' | 'REPLY',
) => Promise<void>

export interface CalendarServiceOptions {
  /** <userData>/pim */
  dir: () => string
  sources: SourceStore
  /** name of the built-in local calendar */
  localName: string
  /** the user's mail identities */
  identities: () => CalendarIdentity[]
  sendItip?: ItipSender
}

export const CALENDAR_COLORS = [
  '#0f6cbd',
  '#c4314b',
  '#13a10e',
  '#8764b8',
  '#ca5010',
  '#038387',
  '#986f0b',
]

export const LOCAL_DEFAULT_ID = 'local:default'

const DAY_MS = 86_400_000
const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

// ---- cache shapes ----

export interface CachedObject {
  url: string
  etag?: string
  ics: string
}

export interface CachedCalendar {
  /** stable part of the calendar id: the collection's path */
  key: string
  url: string
  displayName: string
  color?: string
  /** the collection state the cached objects belong to */
  ctag?: string
  syncToken?: string
  readOnly: boolean
  components?: string[]
  /** objects were loaded at least once */
  synced?: boolean
  objects: CachedObject[]
}

interface DavCache {
  calendars: CachedCalendar[]
}

interface IcsCache {
  text: string
  fetchedAt: string
}

interface LocalCalendar {
  id: string
  name: string
  color: string
}

interface LocalStore {
  calendars: LocalCalendar[]
  objects: Record<string, Record<string, string>>
}

interface CalendarSetting {
  color?: string
  visible?: boolean
  name?: string
}

type Entry =
  | { kind: 'local'; info: CalendarInfo; source: StoredSource }
  | { kind: 'caldav'; info: CalendarInfo; source: StoredSource; cal: CachedCalendar }
  | { kind: 'ics'; info: CalendarInfo; source: StoredSource }

interface StoredObject {
  /** local: the UID; CalDAV: the object URL; subscriptions: 'feed' */
  key: string
  ics: string
  etag?: string
}

interface ParsedObject {
  text: string
  parsed: ParsedIcs
  groups: EventGroup[]
}

// ---- pure helpers (exported for tests) ----

/** the collection part of a CalDAV calendar id: its decoded path, without trailing slash */
export function collectionKey(url: string): string {
  let path: string
  try {
    path = new URL(url).pathname
  } catch {
    path = url
  }
  try {
    path = decodeURIComponent(path)
  } catch {
    // keep it encoded
  }
  // '|' separates the parts of an event id
  return path.replace(/\/+$/, '').replace(/\|/g, '%7C') || '/'
}

/** "#FF2968FF" (Apple, with alpha) or "#f00" → "#ff2968" / "#ff0000"; anything else → undefined */
export function normalizeColor(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const v = value.trim()
  const long = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(v)
  if (long) return `#${long[1]!.toLowerCase()}`
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(v)
  if (short)
    return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`.toLowerCase()
  return undefined
}

/**
 * Whether a DAV:current-user-privilege-set (as tsdav parses it) lacks every
 * privilege that allows writing events. Unknown shapes count as writable —
 * the server will say no if it disagrees.
 */
export function privilegesReadOnly(set: unknown): boolean {
  if (!set || typeof set !== 'object') return false
  const raw = (set as { privilege?: unknown }).privilege
  if (raw === undefined) return false
  const list = Array.isArray(raw) ? raw : [raw]
  const names = new Set<string>()
  for (const p of list) {
    if (p && typeof p === 'object') for (const k of Object.keys(p)) names.add(k.toLowerCase())
  }
  if (names.size === 0) return false
  return !['all', 'write', 'writecontent', 'bind'].some((n) => names.has(n))
}

export interface RemoteCalendar {
  key: string
  url: string
  displayName: string
  color?: string
  ctag?: string
  syncToken?: string
  readOnly: boolean
  components: string[]
}

function scalar(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value && typeof value === 'object' && '_cdata' in value)
    return scalar((value as { _cdata: unknown })._cdata)
  return undefined
}

function lastSegment(url: string): string {
  const key = collectionKey(url)
  return key.slice(key.lastIndexOf('/') + 1)
}

export function remoteCalendarOf(cal: DAVCalendar): RemoteCalendar {
  const projected = cal.projectedProps as Record<string, unknown> | undefined
  const ctag = scalar(cal.ctag)
  const syncToken = scalar(cal.syncToken)
  const color = normalizeColor(scalar(cal.calendarColor))
  return {
    key: collectionKey(cal.url),
    url: cal.url,
    displayName: (scalar(cal.displayName) ?? '').trim() || lastSegment(cal.url) || 'Kalender',
    ...(color ? { color } : {}),
    ...(ctag ? { ctag } : {}),
    ...(syncToken ? { syncToken } : {}),
    readOnly: privilegesReadOnly(projected?.currentUserPrivilegeSet),
    components: Array.isArray(cal.components)
      ? cal.components.map((c) => String(c).toUpperCase())
      : [],
  }
}

/**
 * The cache after a collection listing: collections that hold no events are
 * skipped, vanished ones dropped, and `stale` names those whose objects must
 * be reloaded (new, never loaded, or ctag / sync token moved on).
 */
export function planCalendarSync(
  cached: CachedCalendar[],
  remote: RemoteCalendar[],
): { calendars: CachedCalendar[]; stale: string[] } {
  const byKey = new Map(cached.map((c) => [c.key, c]))
  const calendars: CachedCalendar[] = []
  const stale: string[] = []
  const seen = new Set<string>()
  for (const r of remote) {
    if (r.components.length > 0 && !r.components.includes('VEVENT')) continue
    if (seen.has(r.key)) continue
    seen.add(r.key)
    const old = byKey.get(r.key)
    const unchanged =
      old?.synced === true &&
      Boolean(r.ctag || r.syncToken) &&
      old.ctag === r.ctag &&
      old.syncToken === r.syncToken
    calendars.push({
      key: r.key,
      url: r.url,
      displayName: r.displayName,
      ...(r.color ? { color: r.color } : {}),
      ...(old?.ctag ? { ctag: old.ctag } : {}),
      ...(old?.syncToken ? { syncToken: old.syncToken } : {}),
      readOnly: r.readOnly,
      components: r.components,
      synced: old?.synced ?? false,
      objects: old?.objects ?? [],
    })
    if (!unchanged) stale.push(r.key)
  }
  return { calendars, stale }
}

/** the path of an object URL, decoded — servers differ in how they encode hrefs */
export function objectPath(url: string): string {
  try {
    return decodeURIComponent(new URL(url).pathname)
  } catch {
    return url
  }
}

/** which cached objects are still current and which must be downloaded */
export function diffObjects(
  cached: CachedObject[],
  remote: Array<{ url: string; etag?: string }>,
): { keep: CachedObject[]; fetch: string[] } {
  const byPath = new Map(cached.map((o) => [objectPath(o.url), o]))
  const keep: CachedObject[] = []
  const fetch: string[] = []
  const seen = new Set<string>()
  for (const r of remote) {
    const path = objectPath(r.url)
    if (seen.has(path)) continue
    seen.add(path)
    const old = byPath.get(path)
    if (old && r.etag && old.etag === r.etag) keep.push(old)
    else fetch.push(r.url)
  }
  return { keep, fetch }
}

/** the file name a new event gets on a CalDAV server */
export function objectFilename(uid: string): string {
  const safe = uid.length <= 200 && !/[\u0000-\u001f]/.test(uid)
  return `${safe ? encodeURIComponent(uid) : createHash('sha1').update(uid).digest('hex')}.ics`
}

/**
 * An invitation stored in a CalDAV calendar: without METHOD (servers refuse
 * it in stored objects) and with SCHEDULE-AGENT=CLIENT on the organizer and
 * attendees, so a scheduling server does not mail its own replies next to ours.
 */
export function prepareStoredIcs(ics: string, scheduleAgentClient: boolean): string {
  const roots = parseComponents(ics)
  const calendar = roots.find((r) => r.name === 'VCALENDAR')
  if (!calendar) return ics
  calendar.props = calendar.props.filter((p) => p.name !== 'METHOD')
  if (scheduleAgentClient) {
    for (const child of calendar.children) {
      if (child.name !== 'VEVENT') continue
      for (const p of child.props) {
        if (p.name === 'ORGANIZER' || p.name === 'ATTENDEE') {
          p.params['SCHEDULE-AGENT'] = ['CLIENT']
          delete p.params['SCHEDULE-STATUS']
        }
      }
    }
  }
  return serializeRaw(calendar) + '\r\n'
}

const CALENDAR_PROPS = {
  'c:calendar-description': {},
  'c:calendar-timezone': {},
  'd:displayname': {},
  'ca:calendar-color': {},
  'cs:getctag': {},
  'd:resourcetype': {},
  'c:supported-calendar-component-set': {},
  'd:sync-token': {},
  'd:current-user-privilege-set': {},
}

const EVENT_FILTER = [
  {
    'comp-filter': {
      _attributes: { name: 'VCALENDAR' },
      'comp-filter': { _attributes: { name: 'VEVENT' } },
    },
  },
]

function withSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

function httpError(status: number): Error {
  return friendlyDavError(Object.assign(new Error(`HTTP ${status}`), { status }))
}

function conflictError(): Error {
  return new Error(
    'Der Termin wurde inzwischen auf einem anderen Gerät geändert. Die aktuelle Fassung ist geladen – bitte die Änderung noch einmal vornehmen.',
  )
}

function feedError(err: unknown): Error {
  const status = (err as { status?: number })?.status
  if (status === 401 || status === 403)
    return new Error('Anmeldung fehlgeschlagen. Benutzername und Passwort prüfen.')
  if (status === 404 || status === 410)
    return new Error('Unter dieser Adresse wurde kein Kalender gefunden.')
  return friendlyDavError(err)
}

/** a user-data file that no longer parses is set aside, never overwritten */
function readUserData<T>(path: string): Partial<T> {
  if (!existsSync(path)) return {}
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return data && typeof data === 'object' ? (data as Partial<T>) : {}
  } catch {
    try {
      renameSync(path, `${path}.corrupt-${Date.now()}`)
    } catch {
      // leave it where it is
    }
    return {}
  }
}

// ---- input → model ----

type InputTimes =
  { allDay: true; startDate: string; endDate: string } | { allDay: false; start: Date; end: Date }

function localDate(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function inputTimes(input: EventInput): InputTimes {
  const bad = (): Error => new Error('Ungültige Zeitangabe.')
  if (input.allDay) {
    const day = (v: string): string => {
      if (DATE_KEY.test(v)) return v
      const d = new Date(v)
      if (Number.isNaN(d.getTime())) throw bad()
      return localDate(d)
    }
    const startDate = day(String(input.start ?? ''))
    let endDate = input.end ? day(String(input.end)) : startDate
    if (!(endDate > startDate)) endDate = dateFromMs(dateMs(startDate) + DAY_MS)
    return { allDay: true, startDate, endDate }
  }
  const start = new Date(String(input.start ?? ''))
  let end = new Date(String(input.end ?? input.start ?? ''))
  if (Number.isNaN(start.getTime())) throw bad()
  if (Number.isNaN(end.getTime()) || end < start) end = start
  return { allDay: false, start, end }
}

const NOON: WallTime = { year: 2000, month: 1, day: 1, hour: 12, minute: 0, second: 0 }

/** the frame (UTC, a zone, or floating) new timed values are written in */
function frame(zone: string | null): EventTime {
  if (zone === 'UTC') return { kind: 'datetime', utc: true, wall: NOON }
  return zone ? { kind: 'datetime', wall: NOON, tzid: zone } : { kind: 'datetime', wall: NOON }
}

function timesIn(times: InputTimes, zone: string | null): { start: EventTime; end: EventTime } {
  if (times.allDay) {
    return {
      start: { kind: 'date', date: times.startDate },
      end: { kind: 'date', date: times.endDate },
    }
  }
  const like = frame(zone)
  return { start: fromInstant(times.start, like), end: fromInstant(times.end, like) }
}

const dayOf = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS

/** start + end moved together: end keeps its distance (days for all-day, exact time otherwise) */
function withLength(start: EventTime, oldStart: EventTime, oldEnd: EventTime): EventTime {
  if (start.kind === 'date' || oldStart.kind === 'date' || oldEnd.kind === 'date') {
    const days =
      start.kind === 'date' && oldStart.kind === 'date' && oldEnd.kind === 'date'
        ? timeMs(oldEnd) - timeMs(oldStart)
        : 0
    return start.kind === 'date' ? timeAt(timeMs(start) + Math.max(days, DAY_MS), start) : start
  }
  const length = toInstant(oldEnd).getTime() - toInstant(oldStart).getTime()
  return fromInstant(new Date(toInstant(start).getTime() + Math.max(length, 0)), start)
}

/**
 * Editing "the whole series" from one of its later occurrences: the series
 * start moves by the same number of days as that occurrence did, and takes
 * its new time of day and length.
 */
function shiftSeries(
  series: EventTime,
  occurrenceStart: string,
  moved: { start: EventTime; end: EventTime },
): { start: EventTime; end: EventTime } {
  const occDay = DATE_KEY.test(occurrenceStart)
    ? dateMs(occurrenceStart)
    : dayOf(wallMs(wallIn(new Date(occurrenceStart), series)))
  const newMs = timeMs(moved.start)
  const startDay = dayOf(timeMs(series)) + (dayOf(newMs) - occDay)
  const start = timeAt(startDay + (newMs - dayOf(newMs)), moved.start)
  return { start, end: withLength(start, moved.start, moved.end) }
}

/** maps EXDATEs / RECURRENCE-IDs of a series whose start moved onto the new start */
function rebaser(oldStart: EventTime, newStart: EventTime): (t: EventTime) => EventTime {
  if (oldStart.kind === newStart.kind) {
    const delta = timeMs(newStart) - timeMs(oldStart)
    return (t) => timeAt(timeMs(alignTime(t, oldStart)) + delta, newStart)
  }
  // all-day ↔ timed: same day (shifted like the start), the new time of day
  const dayDelta = dayOf(timeMs(newStart)) - dayOf(timeMs(oldStart))
  const timeOfDay = timeMs(newStart) - dayOf(timeMs(newStart))
  return (t) => timeAt(dayOf(timeMs(alignTime(t, oldStart))) + dayDelta + timeOfDay, newStart)
}

function sameMoment(a: EventTime, b: EventTime): boolean {
  if (a.kind === 'date' || b.kind === 'date') return timeMs(alignTime(a, b)) === timeMs(b)
  return toInstant(a).getTime() === toInstant(b).getTime()
}

function cleanReminders(list: unknown): number[] {
  if (!Array.isArray(list)) return []
  const out: number[] = []
  for (const v of list) {
    const n = Math.round(Number(v))
    if (Number.isFinite(n) && n >= 0 && n <= 60 * 24 * 7 * 8 && !out.includes(n)) out.push(n)
  }
  return out
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+$/

function mergeAttendees(existing: VAttendee[], input: Attendee[]): VAttendee[] {
  const out: VAttendee[] = []
  for (const a of input) {
    const email = String(a?.email ?? '').trim()
    if (!EMAIL.test(email) || out.some((x) => x.email.toLowerCase() === email.toLowerCase()))
      continue
    const old = existing.find((e) => e.email.toLowerCase() === email.toLowerCase())
    const name = a.name?.trim() || old?.name
    const optionalBefore = old?.role === 'OPT-PARTICIPANT' || old?.role === 'NON-PARTICIPANT'
    const role = a.optional
      ? optionalBefore
        ? old!.role
        : 'OPT-PARTICIPANT'
      : old && !optionalBefore
        ? old.role
        : 'REQ-PARTICIPANT'
    const status = a.status ?? 'needs-action'
    const partstat =
      old && attendeeStatus(old.partstat) === status ? old.partstat : partstatOf(status)
    out.push({
      ...(name ? { name } : {}),
      email: old?.email ?? email,
      partstat,
      role,
      rsvp: old?.rsvp ?? true,
    })
  }
  return out
}

function toAttendee(a: VAttendee): Attendee {
  return {
    ...(a.name ? { name: a.name } : {}),
    email: a.email,
    status: attendeeStatus(a.partstat),
    ...(a.role === 'OPT-PARTICIPANT' || a.role === 'NON-PARTICIPANT' ? { optional: true } : {}),
  }
}

function eventStatus(status: string | undefined): CalendarEvent['status'] {
  if (status === 'CANCELLED') return 'cancelled'
  if (status === 'TENTATIVE') return 'tentative'
  return 'confirmed'
}

/** the main-process language for mail texts: German unless the system is set otherwise */
function mailLanguage(): 'de' | 'en' {
  const locale = Intl.DateTimeFormat().resolvedOptions().locale
  return /^de\b/i.test(locale) || !/^en\b/i.test(locale) ? 'de' : 'en'
}

function describeWhen(ev: VEventFields, lang: 'de' | 'en'): string {
  const locale = lang === 'de' ? 'de-DE' : 'en-US'
  if (ev.start.kind === 'date') {
    const day = new Intl.DateTimeFormat(locale, { dateStyle: 'full' })
    const first = day.format(toInstant(ev.start))
    const last = day.format(new Date(toInstant(ev.end).getTime() - 1))
    return first === last ? first : `${first} – ${last}`
  }
  const zone = ev.start.utc ? 'UTC' : (ev.start.tzid ?? systemTimezone())
  const startAt = toInstant(ev.start)
  const endAt = toInstant(ev.end)
  const day = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: zone })
  const time = new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: zone })
  const range =
    day.format(startAt) === day.format(endAt)
      ? `${day.format(startAt)}, ${time.format(startAt)}–${time.format(endAt)}`
      : `${day.format(startAt)}, ${time.format(startAt)} – ${day.format(endAt)}, ${time.format(endAt)}`
  return `${range} (${zone})`
}

function itipMail(
  kind: 'request' | 'cancel',
  ev: VEventFields,
  recurring: boolean,
): { subject: string; text: string } {
  const lang = mailLanguage()
  const title = ev.summary || (lang === 'de' ? '(Ohne Titel)' : '(No title)')
  const de = lang === 'de'
  const lines = [
    kind === 'request'
      ? de
        ? 'Sie sind zu folgendem Termin eingeladen:'
        : 'You are invited to the following event:'
      : de
        ? 'Der folgende Termin wurde abgesagt:'
        : 'The following event has been canceled:',
    '',
    title,
    `${de ? 'Wann' : 'When'}: ${describeWhen(ev, lang)}`,
  ]
  if (recurring) lines.push(de ? 'Serientermin' : 'Recurring event')
  if (ev.location) lines.push(`${de ? 'Ort' : 'Where'}: ${ev.location}`)
  if (ev.description.trim()) lines.push('', ev.description.trim())
  const subject = kind === 'request' ? title : `${de ? 'Abgesagt' : 'Canceled'}: ${title}`
  return { subject, text: lines.join('\n') }
}

/** a Promise-chain mutex per key (a source): syncs and writes do not interleave */
class KeyedQueue {
  private readonly tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const next = prev.then(work, work)
    this.tails.set(key, next)
    const clear = (): void => {
      if (this.tails.get(key) === next) this.tails.delete(key)
    }
    next.then(clear, clear)
    return next
  }
}

interface CancelNotice {
  accountId: string
  to: string[]
  master: VEvent
  overrides: VEvent[]
  timezones: Record<string, string>
  /** what the mail text describes */
  about: VEventFields
  recurring: boolean
}

export class CalendarService {
  private local: LocalStore | null = null
  private settingsData: Record<string, CalendarSetting> | null = null
  private readonly davCaches = new Map<string, DavCache>()
  private readonly feeds = new Map<string, IcsCache | null>()
  private readonly parsed = new Map<string, Map<string, ParsedObject>>()
  private readonly uidIndex = new Map<string, Map<string, string>>()
  private readonly queue = new KeyedQueue()

  constructor(private readonly opts: CalendarServiceOptions) {}

  // ---- files ----

  private path(name: string): string {
    return join(this.opts.dir(), name)
  }

  private fileId(sourceId: string): string {
    return sourceId.replace(/[^\w.-]/g, '_')
  }

  private localStore(): LocalStore {
    if (!this.local) {
      const data = readUserData<LocalStore>(this.path('local-calendars.json'))
      const calendars = (Array.isArray(data.calendars) ? data.calendars : []).filter(
        (c): c is LocalCalendar =>
          Boolean(c) && typeof c.id === 'string' && typeof c.name === 'string',
      )
      if (!calendars.some((c) => c.id === LOCAL_DEFAULT_ID)) {
        calendars.unshift({
          id: LOCAL_DEFAULT_ID,
          name: this.opts.localName,
          color: CALENDAR_COLORS[0]!,
        })
      }
      const objects =
        data.objects && typeof data.objects === 'object' && !Array.isArray(data.objects)
          ? data.objects
          : {}
      this.local = { calendars, objects }
    }
    return this.local
  }

  private saveLocal(): void {
    writeJsonAtomic(this.path('local-calendars.json'), { version: 1, ...this.localStore() })
  }

  private settings(): Record<string, CalendarSetting> {
    if (!this.settingsData) {
      const data = readJson<Record<string, CalendarSetting>>(
        this.path('calendar-settings.json'),
        {},
      )
      this.settingsData = data && typeof data === 'object' && !Array.isArray(data) ? data : {}
    }
    return this.settingsData
  }

  private saveSettings(): void {
    writeJsonAtomic(this.path('calendar-settings.json'), this.settings())
  }

  private davCache(sourceId: string): DavCache {
    let cache = this.davCaches.get(sourceId)
    if (!cache) {
      const data = readJson<Partial<DavCache>>(
        this.path(`caldav-${this.fileId(sourceId)}.json`),
        {},
      )
      const calendars = (Array.isArray(data.calendars) ? data.calendars : []).filter(
        (c): c is CachedCalendar =>
          Boolean(c) &&
          typeof c.key === 'string' &&
          typeof c.url === 'string' &&
          Array.isArray(c.objects),
      )
      cache = { calendars }
      this.davCaches.set(sourceId, cache)
    }
    return cache
  }

  private saveDav(sourceId: string): void {
    writeJsonAtomic(this.path(`caldav-${this.fileId(sourceId)}.json`), {
      version: 1,
      calendars: this.davCache(sourceId).calendars,
    })
  }

  private feed(sourceId: string): IcsCache | null {
    if (!this.feeds.has(sourceId)) {
      const data = readJson<Partial<IcsCache>>(this.path(`ics-${this.fileId(sourceId)}.json`), {})
      this.feeds.set(
        sourceId,
        typeof data.text === 'string'
          ? { text: data.text, fetchedAt: String(data.fetchedAt ?? '') }
          : null,
      )
    }
    return this.feeds.get(sourceId) ?? null
  }

  // ---- calendars ----

  private entries(): Entry[] {
    const settings = this.settings()
    const localSource = this.opts.sources.ensureLocal(this.opts.localName)
    const list: Array<Omit<Entry, 'info'> & { base: Omit<CalendarInfo, 'visible'> }> = []
    for (const c of this.localStore().calendars) {
      list.push({
        kind: 'local',
        source: localSource,
        base: { id: c.id, sourceId: localSource.id, name: c.name, color: c.color, readOnly: false },
      })
    }
    for (const source of this.opts.sources.list()) {
      if (source.kind === 'caldav') {
        for (const cal of this.davCache(source.id).calendars) {
          list.push({
            kind: 'caldav',
            source,
            cal,
            base: {
              id: `${source.id}:${cal.key}`,
              sourceId: source.id,
              name: cal.displayName || lastSegment(cal.url) || 'Kalender',
              color: cal.color ?? '',
              readOnly: cal.readOnly,
            },
          } as Omit<Entry, 'info'> & { base: Omit<CalendarInfo, 'visible'> })
        }
      } else if (source.kind === 'ics') {
        list.push({
          kind: 'ics',
          source,
          base: {
            id: `${source.id}:ics`,
            sourceId: source.id,
            name: source.name || 'Abonnement',
            color: '',
            readOnly: true,
          },
        })
      }
    }
    return list.map(({ base, ...rest }, i) => {
      const s = settings[base.id] ?? {}
      const info: CalendarInfo = {
        ...base,
        name: (typeof s.name === 'string' && s.name.trim()) || base.name,
        color: s.color || base.color || CALENDAR_COLORS[i % CALENDAR_COLORS.length]!,
        visible: s.visible ?? true,
      }
      return { ...rest, info } as Entry
    })
  }

  private entry(id: string): Entry {
    const found = this.entries().find((e) => e.info.id === id)
    if (!found) throw new Error('Der Kalender wurde nicht gefunden.')
    return found
  }

  private writable(id: string): Entry {
    const found = this.entry(id)
    if (found.info.readOnly) throw new Error('Dieser Kalender ist schreibgeschützt.')
    return found
  }

  listCalendars(): CalendarInfo[] {
    return this.entries().map((e) => e.info)
  }

  async updateCalendar(
    id: string,
    patch: { color?: string; visible?: boolean; name?: string },
  ): Promise<void> {
    this.entry(id)
    const settings = this.settings()
    const next: CalendarSetting = { ...(settings[id] ?? {}) }
    if (patch.color !== undefined) {
      const color = String(patch.color).trim()
      if (color && !/^[#\w(),.%\s-]{1,64}$/.test(color)) throw new Error('Ungültige Farbe.')
      if (color) next.color = color
      else delete next.color
    }
    if (patch.visible !== undefined) next.visible = Boolean(patch.visible)
    if (patch.name !== undefined) {
      const name = String(patch.name).trim()
      if (name) next.name = name.slice(0, 200)
      else delete next.name
    }
    settings[id] = next
    this.saveSettings()
  }

  async createCalendar(sourceId: string, name: string, color: string): Promise<CalendarInfo> {
    const title = String(name ?? '').trim() || 'Kalender'
    const localSource = this.opts.sources.ensureLocal(this.opts.localName)
    const source = sourceId === localSource.id ? localSource : this.opts.sources.get(sourceId)
    if (!source) throw new Error('Die Quelle wurde nicht gefunden.')
    const chosen = normalizeColor(color) ?? (String(color ?? '').trim() || undefined)
    if (source.kind === 'local') {
      const id = `${localSource.id}:${randomUUID()}`
      this.localStore().calendars.push({ id, name: title, color: chosen ?? CALENDAR_COLORS[0]! })
      this.saveLocal()
      return this.listCalendars().find((c) => c.id === id)!
    }
    if (source.kind !== 'caldav') {
      throw new Error('In einem abonnierten Kalender können keine Kalender angelegt werden.')
    }
    return this.queue.run(source.id, async () => {
      const client = await this.client(source)
      const home = await this.homeUrl(client, source)
      const url = new URL(`${randomUUID()}/`, withSlash(home)).href
      let responses: DAVResponse[]
      try {
        responses = await client.makeCalendar({
          url,
          props: {
            'd:displayname': title,
            ...(chosen ? { 'ca:calendar-color': chosen } : {}),
            'c:supported-calendar-component-set': { 'c:comp': { _attributes: { name: 'VEVENT' } } },
          },
        })
      } catch (err) {
        throw friendlyDavError(err)
      }
      const failed = responses.find((r) => !r.ok)
      if (failed) throw httpError(failed.status)
      await this.syncDav(source)
      const id = `${source.id}:${collectionKey(url)}`
      if (chosen) {
        this.settings()[id] = { ...(this.settings()[id] ?? {}), color: chosen }
        this.saveSettings()
      }
      const info = this.listCalendars().find((c) => c.id === id)
      if (!info)
        throw new Error('Der Kalender wurde angelegt, ist aber auf dem Server nicht zu finden.')
      return info
    })
  }

  // ---- objects ----

  private objectsOf(entry: Entry): StoredObject[] {
    if (entry.kind === 'local') {
      const map = this.localStore().objects[entry.info.id] ?? {}
      return Object.entries(map).map(([key, ics]) => ({ key, ics }))
    }
    if (entry.kind === 'caldav') {
      return entry.cal.objects.map((o) => ({
        key: o.url,
        ics: o.ics,
        ...(o.etag ? { etag: o.etag } : {}),
      }))
    }
    const feed = this.feed(entry.source.id)
    return feed ? [{ key: 'feed', ics: feed.text }] : []
  }

  /** parsed objects of a calendar; unchanged texts are not parsed again */
  private parsedObjects(entry: Entry): Array<{ object: StoredObject; parsed: ParsedObject }> {
    const id = entry.info.id
    const before = this.parsed.get(id)
    const now = new Map<string, ParsedObject>()
    const out: Array<{ object: StoredObject; parsed: ParsedObject }> = []
    for (const object of this.objectsOf(entry)) {
      let parsed = before?.get(object.key)
      if (!parsed || parsed.text !== object.ics) {
        try {
          const ics = parseIcs(object.ics)
          parsed = { text: object.ics, parsed: ics, groups: groupByUid(ics.events) }
        } catch {
          continue
        }
      }
      now.set(object.key, parsed)
      out.push({ object, parsed })
    }
    this.parsed.set(id, now)
    return out
  }

  private indexOf(entry: Entry): Map<string, string> {
    let index = this.uidIndex.get(entry.info.id)
    if (!index) {
      index = new Map()
      for (const { object, parsed } of this.parsedObjects(entry)) {
        if (entry.kind === 'local') index.set(object.key, object.key)
        for (const g of parsed.groups) if (!index.has(g.uid)) index.set(g.uid, object.key)
      }
      this.uidIndex.set(entry.info.id, index)
    }
    return index
  }

  private invalidate(calendarId: string): void {
    this.uidIndex.delete(calendarId)
  }

  private findObject(entry: Entry, uid: string): StoredObject | undefined {
    if (entry.kind === 'local') {
      const ics = this.localStore().objects[entry.info.id]?.[uid]
      if (ics !== undefined) return { key: uid, ics }
    }
    const key = this.indexOf(entry).get(uid)
    if (key === undefined) return undefined
    return this.objectsOf(entry).find((o) => o.key === key)
  }

  /** an event in `preferred`, else in any other writable calendar */
  private locate(
    uid: string,
    preferred?: Entry,
  ): { entry: Entry; object: StoredObject } | undefined {
    if (preferred) {
      const object = this.findObject(preferred, uid)
      if (object) return { entry: preferred, object }
    }
    for (const entry of this.entries()) {
      if (entry.info.readOnly || entry.kind === 'ics' || entry.info.id === preferred?.info.id)
        continue
      const object = this.findObject(entry, uid)
      if (object) return { entry, object }
    }
    return undefined
  }

  private async putObject(
    entry: Entry,
    uid: string,
    text: string,
    existing?: StoredObject,
    deferSave = false,
  ): Promise<void> {
    if (entry.kind === 'local') {
      const objects = (this.localStore().objects[entry.info.id] ??= {})
      if (existing && existing.key !== uid) delete objects[existing.key]
      objects[uid] = text
      if (!deferSave) this.saveLocal()
      this.invalidate(entry.info.id)
      return
    }
    if (entry.kind === 'ics') throw new Error('Dieser Kalender ist schreibgeschützt.')
    await this.putDav(entry, uid, text, existing)
  }

  private async removeObject(entry: Entry, object: StoredObject): Promise<void> {
    if (entry.kind === 'local') {
      const objects = this.localStore().objects[entry.info.id]
      if (objects) delete objects[object.key]
      this.saveLocal()
      this.invalidate(entry.info.id)
      return
    }
    if (entry.kind === 'ics') throw new Error('Dieser Kalender ist schreibgeschützt.')
    const { cal, source } = entry
    const cached = cal.objects.find((o) => objectPath(o.url) === objectPath(object.key))
    const client = await this.client(source)
    let res: Response
    try {
      res = await client.deleteCalendarObject({
        calendarObject: { url: object.key, ...(cached?.etag ? { etag: cached.etag } : {}) },
      })
    } catch (err) {
      throw friendlyDavError(err)
    }
    if (res.status === 412) {
      await this.refreshQuietly(client, source, cal)
      throw conflictError()
    }
    // gone already is as good as deleted
    if (!res.ok && res.status !== 404 && res.status !== 410) throw httpError(res.status)
    cal.objects = cal.objects.filter((o) => objectPath(o.url) !== objectPath(object.key))
    this.saveDav(source.id)
    this.invalidate(entry.info.id)
  }

  // ---- CalDAV ----

  private async client(source: StoredSource): Promise<DavClient> {
    if (!source.url) throw new Error('Für diese Quelle ist keine Serveradresse hinterlegt.')
    const password = this.opts.sources.password(source)
    try {
      return await connectDav(source.id, 'caldav', source.url, source.user ?? '', password)
    } catch (err) {
      forgetDav(source.id)
      throw friendlyDavError(err)
    }
  }

  /** the calendar home: discovered from the server, else the parent of a known collection */
  private async homeUrl(client: DavClient, source: StoredSource): Promise<string> {
    let discoveryError: unknown = null
    try {
      const account = await client.createAccount({ account: { accountType: 'caldav' } })
      if (account.homeUrl) return account.homeUrl
    } catch (err) {
      discoveryError = err
    }
    const known = this.davCache(source.id).calendars[0]?.url
    if (known) return new URL('..', withSlash(known)).href
    if (discoveryError) throw friendlyDavError(discoveryError)
    throw new Error('Auf dem Server wurde kein Ort für Kalender gefunden.')
  }

  private async listRemote(client: DavClient): Promise<RemoteCalendar[]> {
    const calendars = await client.fetchCalendars({
      props: CALENDAR_PROPS,
      projectedProps: { currentUserPrivilegeSet: true },
    })
    return calendars.map(remoteCalendarOf)
  }

  /** reload a collection's objects: list etags, download only what changed */
  private async refreshObjects(client: DavClient, cal: CachedCalendar): Promise<void> {
    const responses = await client.calendarQuery({
      url: cal.url,
      props: { 'd:getetag': {} },
      filters: EVENT_FILTER,
      depth: '1',
    })
    const failed = responses.length === 1 && !responses[0]!.ok && !responses[0]!.props
    if (failed) throw httpError(responses[0]!.status)
    const own = objectPath(withSlash(cal.url))
    const remote: Array<{ url: string; etag?: string }> = []
    for (const r of responses) {
      if (!r.href || !r.props || r.ok === false) continue
      const url = new URL(r.href, withSlash(cal.url)).href
      if (url.endsWith('/') || objectPath(url) === own) continue
      const etag = scalar(r.props.getetag)
      remote.push({ url, ...(etag ? { etag } : {}) })
    }
    const { keep, fetch } = diffObjects(cal.objects, remote)
    const fetched: CachedObject[] = []
    for (let i = 0; i < fetch.length; i += 50) {
      const objects = await client.fetchCalendarObjects({
        calendar: { url: cal.url } as DAVCalendar,
        objectUrls: fetch.slice(i, i + 50),
        urlFilter: (url: string) => Boolean(url),
      })
      for (const o of objects) {
        const data = scalar(o.data)
        if (!data || !/BEGIN:VCALENDAR/i.test(data)) continue
        const etag = scalar(o.etag)
        fetched.push({ url: o.url, ics: data, ...(etag ? { etag } : {}) })
      }
    }
    cal.objects = [...keep, ...fetched]
  }

  private async refreshQuietly(
    client: DavClient,
    source: StoredSource,
    cal: CachedCalendar,
  ): Promise<void> {
    try {
      await this.refreshObjects(client, cal)
      this.saveDav(source.id)
    } catch {
      // the next sync will catch up
    }
    this.invalidate(`${source.id}:${cal.key}`)
  }

  private async syncDav(source: StoredSource): Promise<void> {
    const client = await this.client(source)
    let remote: RemoteCalendar[]
    try {
      remote = await this.listRemote(client)
    } catch (err) {
      forgetDav(source.id)
      throw friendlyDavError(err)
    }
    const cache = this.davCache(source.id)
    const plan = planCalendarSync(cache.calendars, remote)
    const byKey = new Map(remote.map((r) => [r.key, r]))
    cache.calendars = plan.calendars
    let firstError: unknown = null
    for (const cal of plan.calendars) {
      if (!plan.stale.includes(cal.key)) continue
      try {
        await this.refreshObjects(client, cal)
        const r = byKey.get(cal.key)
        if (r?.ctag) cal.ctag = r.ctag
        else delete cal.ctag
        if (r?.syncToken) cal.syncToken = r.syncToken
        else delete cal.syncToken
        cal.synced = true
      } catch (err) {
        firstError ??= err
      }
      this.invalidate(`${source.id}:${cal.key}`)
    }
    this.saveDav(source.id)
    for (const key of [...this.parsed.keys()]) {
      if (
        key.startsWith(`${source.id}:`) &&
        !plan.calendars.some((c) => `${source.id}:${c.key}` === key)
      ) {
        this.parsed.delete(key)
        this.uidIndex.delete(key)
      }
    }
    if (firstError) throw friendlyDavError(firstError)
  }

  private async putDav(
    entry: Extract<Entry, { kind: 'caldav' }>,
    uid: string,
    text: string,
    existing?: StoredObject,
  ): Promise<void> {
    const { cal, source } = entry
    const client = await this.client(source)
    const cached = existing
      ? cal.objects.find((o) => objectPath(o.url) === objectPath(existing.key))
      : undefined
    const url = existing ? existing.key : new URL(objectFilename(uid), withSlash(cal.url)).href
    let res: Response
    try {
      res = existing
        ? await client.updateCalendarObject({
            calendarObject: { url, data: text, ...(cached?.etag ? { etag: cached.etag } : {}) },
          })
        : await client.createCalendarObject({
            calendar: { url: cal.url } as DAVCalendar,
            iCalString: text,
            filename: objectFilename(uid),
          })
    } catch (err) {
      throw friendlyDavError(err)
    }
    if (res.status === 412) {
      await this.refreshQuietly(client, source, cal)
      throw conflictError()
    }
    if (existing && (res.status === 404 || res.status === 410)) {
      await this.refreshQuietly(client, source, cal)
      throw new Error('Der Termin wurde auf dem Server inzwischen gelöscht.')
    }
    if (!res.ok) throw httpError(res.status)
    const etag = res.headers?.get('etag') ?? undefined
    let stored: CachedObject = { url, ics: text, ...(etag ? { etag } : {}) }
    if (!etag) {
      // no ETag: the server changed the object on the way in; take its version
      try {
        const [fresh] = await client.fetchCalendarObjects({
          calendar: { url: cal.url } as DAVCalendar,
          objectUrls: [url],
          urlFilter: (u: string) => Boolean(u),
        })
        const data = scalar(fresh?.data)
        const freshTag = scalar(fresh?.etag)
        if (data) stored = { url, ics: data, ...(freshTag ? { etag: freshTag } : {}) }
      } catch {
        // keep our copy; the next sync replaces it
      }
    }
    const at = cal.objects.findIndex((o) => objectPath(o.url) === objectPath(url))
    if (at >= 0) cal.objects[at] = stored
    else cal.objects.push(stored)
    this.saveDav(source.id)
    this.invalidate(entry.info.id)
  }

  // ---- sources ----

  async testSource(source: StoredSource, password: string): Promise<void> {
    if (source.kind === 'local') return
    if (!source.url) throw new Error('Bitte die Adresse des Servers bzw. Kalenders angeben.')
    if (source.kind === 'ics') {
      let text: string
      try {
        text = await fetchIcs(source.url, source.user, password)
      } catch (err) {
        throw feedError(err)
      }
      parseIcs(text)
      return
    }
    if (source.kind !== 'caldav') return
    const key = `test:${source.id}`
    try {
      const client = await connectDav(key, 'caldav', source.url, source.user ?? '', password)
      const remote = await this.listRemote(client)
      if (!remote.some((r) => r.components.length === 0 || r.components.includes('VEVENT'))) {
        throw new Error('Auf dem Server wurde kein Kalender gefunden.')
      }
    } catch (err) {
      throw friendlyDavError(err)
    } finally {
      forgetDav(key)
    }
  }

  async syncSource(source: StoredSource): Promise<void> {
    if (source.kind === 'caldav') {
      await this.queue.run(source.id, () => this.syncDav(source))
      return
    }
    if (source.kind !== 'ics') return
    if (!source.url) throw new Error('Für dieses Abonnement ist keine Adresse hinterlegt.')
    const password = this.opts.sources.password(source)
    let text: string
    try {
      text = await fetchIcs(source.url, source.user, password)
    } catch (err) {
      throw feedError(err)
    }
    const cache = { text, fetchedAt: new Date().toISOString() }
    writeJsonAtomic(this.path(`ics-${this.fileId(source.id)}.json`), cache)
    this.feeds.set(source.id, cache)
    this.invalidate(`${source.id}:ics`)
  }

  forgetSource(sourceId: string): void {
    forgetDav(sourceId)
    this.davCaches.delete(sourceId)
    this.feeds.delete(sourceId)
    for (const key of [...this.parsed.keys()])
      if (key.startsWith(`${sourceId}:`)) this.parsed.delete(key)
    for (const key of [...this.uidIndex.keys()])
      if (key.startsWith(`${sourceId}:`)) this.uidIndex.delete(key)
    if (this.opts.sources.get(sourceId)) return
    // the source was removed: its caches and settings go with it
    for (const name of [
      `caldav-${this.fileId(sourceId)}.json`,
      `ics-${this.fileId(sourceId)}.json`,
    ]) {
      try {
        rmSync(this.path(name), { force: true })
      } catch {
        // not there
      }
    }
    const settings = this.settings()
    let changed = false
    for (const id of Object.keys(settings)) {
      if (id.startsWith(`${sourceId}:`)) {
        delete settings[id]
        changed = true
      }
    }
    if (changed) this.saveSettings()
  }

  // ---- events ----

  private occurrencesOf(group: EventGroup, from: Date, to: Date): Occurrence[] {
    if (group.master && !group.master.timeless) {
      return expandOccurrences(group.master, group.overrides, from, to)
    }
    // single occurrences of a series we do not have (an invitation to one date)
    return group.overrides.flatMap((o) =>
      expandOccurrences(o, [], from, to).map((occ) => ({
        ...occ,
        override: true,
        ...(o.recurrenceId ? { recurrenceId: o.recurrenceId } : {}),
      })),
    )
  }

  private toEvent(info: CalendarInfo, group: EventGroup, occ: Occurrence): CalendarEvent {
    const ev = occ.event
    const series = group.master && !group.master.timeless ? group.master : undefined
    const recurring = Boolean(series && isRecurring(series)) || occ.override
    const start = occ.start.kind === 'date' ? occ.start.date : occ.startAt.toISOString()
    const end = occ.end.kind === 'date' ? occ.end.date : occ.endAt.toISOString()
    const occurrenceStart =
      recurring && occ.recurrenceId ? occurrenceKey(occ.recurrenceId) : undefined
    return {
      id: `${info.id}|${group.uid}|${occurrenceStart ?? start}`,
      uid: group.uid,
      calendarId: info.id,
      title: ev.summary,
      location: ev.location,
      description: ev.description,
      start,
      end,
      allDay: occ.start.kind === 'date',
      recurring,
      ...(series?.rrule ? { rrule: series.rrule } : {}),
      ...(occurrenceStart ? { occurrenceStart } : {}),
      status: eventStatus(ev.status),
      ...(ev.organizer
        ? {
            organizer: {
              ...(ev.organizer.name ? { name: ev.organizer.name } : {}),
              email: ev.organizer.email,
            },
          }
        : {}),
      attendees: ev.attendees.map(toAttendee),
      reminders: [...ev.alarms],
      ...(occ.start.kind === 'datetime' && occ.start.tzid ? { timezone: occ.start.tzid } : {}),
      ...(ev.url ? { url: ev.url } : {}),
      readOnly: info.readOnly,
    }
  }

  async listEvents(range: EventRange): Promise<CalendarEvent[]> {
    const from = new Date(range?.from)
    const to = new Date(range?.to)
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()))
      throw new Error('Ungültiger Zeitraum.')
    const wanted = Array.isArray(range.calendarIds) ? new Set(range.calendarIds) : null
    const found: Array<{ at: number; allDay: boolean; event: CalendarEvent }> = []
    for (const entry of this.entries()) {
      if (wanted ? !wanted.has(entry.info.id) : !entry.info.visible) continue
      for (const { parsed } of this.parsedObjects(entry)) {
        for (const group of parsed.groups) {
          let occurrences: Occurrence[]
          try {
            occurrences = this.occurrencesOf(group, from, to)
          } catch {
            continue
          }
          for (const occ of occurrences) {
            found.push({
              at: occ.startAt.getTime(),
              allDay: occ.start.kind === 'date',
              event: this.toEvent(entry.info, group, occ),
            })
          }
        }
      }
    }
    found.sort(
      (a, b) =>
        a.at - b.at ||
        Number(b.allDay) - Number(a.allDay) ||
        a.event.title.localeCompare(b.event.title),
    )
    return found.map((f) => f.event)
  }

  private groupOf(entry: Entry, uid: string): EventGroup | undefined {
    if (entry.kind === 'ics') {
      for (const { parsed } of this.parsedObjects(entry)) {
        const g = parsed.groups.find((x) => x.uid === uid)
        if (g) return g
      }
      return undefined
    }
    const object = this.findObject(entry, uid)
    if (!object) return undefined
    return this.parsedObjects(entry)
      .find((p) => p.object.key === object.key)
      ?.parsed.groups.find((g) => g.uid === uid)
  }

  /** one occurrence of a group by its IPC occurrence start */
  private occurrenceOf(group: EventGroup, occurrenceStart: string): Occurrence | null {
    const override = group.overrides.find(
      (o) => o.recurrenceId && matchesOccurrence(o.recurrenceId, occurrenceStart),
    )
    if (override && !override.timeless) {
      return {
        event: override,
        override: true,
        start: override.start,
        end: override.end,
        startAt: toInstant(override.start),
        endAt: toInstant(override.end),
        recurrenceId: override.recurrenceId!,
      }
    }
    if (!group.master || group.master.timeless || !isRecurring(group.master)) return null
    return findOccurrence(group.master, group.overrides, occurrenceStart)
  }

  async getEvent(
    calendarId: string,
    uid: string,
    occurrenceStart?: string,
  ): Promise<CalendarEvent> {
    const entry = this.entry(calendarId)
    const group = this.groupOf(entry, uid)
    if (!group) throw new Error('Der Termin wurde nicht gefunden.')
    if (occurrenceStart) {
      const occ = this.occurrenceOf(group, occurrenceStart)
      if (occ) return this.toEvent(entry.info, group, occ)
      if (group.master && isRecurring(group.master))
        throw new Error('Dieser Termin der Serie wurde nicht gefunden.')
    }
    const ev =
      group.master && !group.master.timeless
        ? group.master
        : group.overrides.find((o) => !o.timeless)
    if (!ev) throw new Error('Der Termin wurde nicht gefunden.')
    const occ: Occurrence = {
      event: ev,
      override: ev !== group.master,
      start: ev.start,
      end: ev.end,
      startAt: toInstant(ev.start),
      endAt: toInstant(ev.end),
      ...(ev.recurrenceId
        ? { recurrenceId: ev.recurrenceId }
        : isRecurring(ev)
          ? { recurrenceId: ev.start }
          : {}),
    }
    return this.toEvent(entry.info, group, occ)
  }

  private identity(accountId: string): CalendarIdentity {
    const found = this.opts.identities().find((i) => i.accountId === accountId)
    if (!found) throw new Error('Das Absender-Konto wurde nicht gefunden.')
    return found
  }

  private isMine(email: string | undefined): boolean {
    if (!email) return false
    const e = email.toLowerCase()
    return this.opts.identities().some((i) => i.email.toLowerCase() === e)
  }

  /** the zone an edit is written in: the event's own, else the user's */
  private writeZone(ev: VEventFields | undefined, input: EventInput): string | null {
    if (ev && ev.start.kind === 'datetime') {
      if (ev.start.tzid) return ev.start.tzid
      if (ev.start.utc && isRecurring(ev)) return 'UTC'
    }
    return resolveTimezone(input.timezone) ?? resolveTimezone(systemTimezone()) ?? 'UTC'
  }

  private applyInput(ev: VEvent, input: EventInput, now: string): void {
    ev.summary = String(input.title ?? '').trim()
    if (input.location !== undefined) ev.location = String(input.location ?? '').trim()
    if (input.description !== undefined) ev.description = String(input.description ?? '')
    if (input.reminders !== undefined) ev.alarms = cleanReminders(input.reminders)
    if (input.attendees !== undefined) ev.attendees = mergeAttendees(ev.attendees, input.attendees)
    ev.dtstamp = now
    ev.lastModified = now
  }

  /** the series' EXDATEs and overrides after its start or rule changed */
  private reconcileSeries(group: EventGroup, before: { start: EventTime; rrule?: string }): void {
    const master = group.master!
    const moved = !sameTime(before.start, master.start)
    const ruleChanged = normalizeRrule(before.rrule) !== normalizeRrule(master.rrule)
    if (!moved && !ruleChanged) return
    if (!isRecurring(master)) {
      master.exdates = []
      group.overrides = []
      return
    }
    if (moved) {
      const rebase = rebaser(before.start, master.start)
      master.exdates = master.exdates.map(rebase)
      master.rdates = master.rdates.map(rebase)
      for (const o of group.overrides) {
        if (!o.recurrenceId) continue
        const rid = rebase(o.recurrenceId)
        // an override that only changed details moves along with the series
        if (sameMoment(o.start, o.recurrenceId)) {
          const end =
            o.start.kind === rid.kind
              ? withLength(rid, o.start, o.end)
              : withLength(rid, master.start, master.end)
          o.start = rid
          o.end = end
          delete o.duration
        }
        o.recurrenceId = rid
      }
    }
    // exceptions the new rule no longer produces would turn into stray extra events
    master.exdates = master.exdates.filter((t) => generates(master, t))
    group.overrides = group.overrides.filter(
      (o) => !o.recurrenceId || generates(master, o.recurrenceId),
    )
  }

  async saveEvent(input: EventInput): Promise<CalendarEvent> {
    if (!input || typeof input !== 'object') throw new Error('Ungültiger Termin.')
    const target = this.writable(String(input.calendarId ?? ''))
    const times = inputTimes(input)
    const sender = input.inviteFromAccountId ? this.identity(input.inviteFromAccountId) : undefined

    const saved = await this.queue.run(target.source.id, async () => {
      const now = formatUtc(new Date())
      const uid = typeof input.uid === 'string' ? input.uid.trim() : ''
      const found = uid ? this.locate(uid, target) : undefined
      let parsed: ParsedIcs | undefined
      let group: EventGroup | undefined
      if (found) {
        parsed = parseIcs(found.object.ics)
        group = groupByUid(parsed.events).find((g) => g.uid === uid)
      }
      const moving = Boolean(found && found.entry.info.id !== target.info.id)
      const timezones = parsed?.timezones ?? {}

      let edited: VEvent
      if (!group || (!group.master && group.overrides.length === 0)) {
        // a new event
        const zone = this.writeZone(undefined, input)
        const { start, end } = timesIn(times, zone)
        const ev = newEvent(uid || `${randomUUID()}@suite-office`, start, end)
        ev.raw.props.push(
          { name: 'UID', params: {}, value: ev.uid },
          { name: 'CREATED', params: {}, value: now },
        )
        this.applyInput(ev, input, now)
        const rule =
          typeof input.rrule === 'string' ? input.rrule.trim().replace(/^RRULE:/i, '') : ''
        if (rule) ev.rrule = rule
        group = { uid: ev.uid, master: ev, overrides: [] }
        edited = ev
      } else if (
        input.scope === 'occurrence' &&
        input.occurrenceStart &&
        (!group.master || isRecurring(group.master))
      ) {
        if (moving) {
          throw new Error(
            'Ein einzelner Termin einer Serie kann nicht in einen anderen Kalender verschoben werden.',
          )
        }
        const key = input.occurrenceStart
        let ov = group.overrides.find(
          (o) => o.recurrenceId && matchesOccurrence(o.recurrenceId, key),
        )
        if (!ov) {
          const occ = group.master ? findOccurrence(group.master, group.overrides, key) : null
          if (!occ?.recurrenceId || !group.master)
            throw new Error('Dieser Termin der Serie wurde nicht gefunden.')
          ov = deriveOccurrence(group.master, occ.recurrenceId, occ.start, occ.end)
          group.overrides.push(ov)
        }
        const { start, end } = timesIn(times, this.writeZone(group.master ?? ov, input))
        ov.start = start
        ov.end = end
        delete ov.duration
        this.applyInput(ov, input, now)
        edited = ov
      } else {
        const ev =
          group.master ??
          group.overrides.find(
            (o) =>
              input.occurrenceStart &&
              o.recurrenceId &&
              matchesOccurrence(o.recurrenceId, input.occurrenceStart),
          ) ??
          group.overrides[0]!
        const before = { start: ev.start, ...(ev.rrule ? { rrule: ev.rrule } : {}) }
        const moved = timesIn(times, this.writeZone(ev, input))
        const fromOccurrence =
          ev === group.master &&
          isRecurring(ev) &&
          input.occurrenceStart &&
          !matchesOccurrence(ev.start, input.occurrenceStart)
        const { start, end } = fromOccurrence
          ? shiftSeries(ev.start, input.occurrenceStart!, moved)
          : moved
        ev.start = start
        ev.end = end
        delete ev.duration
        this.applyInput(ev, input, now)
        if (ev === group.master) {
          if (input.rrule === null || (typeof input.rrule === 'string' && !input.rrule.trim())) {
            delete ev.rrule
            ev.rdates = []
          } else if (typeof input.rrule === 'string') {
            ev.rrule = input.rrule.trim().replace(/^RRULE:/i, '')
          }
          this.reconcileSeries(group, before)
        }
        edited = ev
      }

      // organizer: invitations go out in the name of the chosen mail account
      const all = [group.master, ...group.overrides].filter((e): e is VEvent => Boolean(e))
      const withAttendees = all.some((e) => e.attendees.length > 0)
      if (sender && withAttendees) {
        for (const e of all) {
          if (e.organizer && !this.isMine(e.organizer.email)) {
            throw new Error('Einladungen kann nur der Organisator des Termins versenden.')
          }
        }
        for (const e of all) {
          e.organizer = { ...(sender.name ? { name: sender.name } : {}), email: sender.email }
        }
      }
      // Suite mails invitations itself; a scheduling server (RFC 6638) must
      // not send its own on top. Events another client created stay under the
      // server's scheduling unless we are the ones sending this time.
      const organizerIsMe = all.some((e) => e.organizer && this.isMine(e.organizer.email))
      const scheduleAgentClient =
        target.kind === 'caldav' && withAttendees && organizerIsMe && (Boolean(sender) || !found)

      const master = group.master ?? group.overrides[0]!
      const rest = group.master ? group.overrides : group.overrides.slice(1)
      const text = buildCalendarObject(master, rest, { timezones, scheduleAgentClient })
      await this.putObject(target, group.uid, text, moving ? undefined : found?.object)
      if (moving && found) await this.removeObject(found.entry, found.object)

      const occ: Occurrence = {
        event: edited,
        override: Boolean(edited.recurrenceId),
        start: edited.start,
        end: edited.end,
        startAt: toInstant(edited.start),
        endAt: toInstant(edited.end),
        ...(edited.recurrenceId
          ? { recurrenceId: edited.recurrenceId }
          : isRecurring(edited)
            ? { recurrenceId: edited.start }
            : {}),
      }
      return { event: this.toEvent(target.info, group, occ), group, master, rest, timezones }
    })

    if (sender && this.opts.sendItip) {
      const { group, master, rest, timezones } = saved
      const organizer = master.organizer?.email.toLowerCase()
      const to = [
        ...new Set(
          [master, ...rest]
            .flatMap((e) => e.attendees.map((a) => a.email))
            .filter((email) => email.toLowerCase() !== organizer && !this.isMine(email)),
        ),
      ]
      if (to.length) {
        const ics = buildCalendarObject(master, rest, { method: 'REQUEST', timezones })
        const mail = itipMail('request', master, Boolean(group.master && isRecurring(group.master)))
        try {
          await this.opts.sendItip(sender.accountId, to, mail.subject, mail.text, ics, 'REQUEST')
        } catch (err) {
          throw new Error(
            `Der Termin wurde gespeichert, aber die Einladung konnte nicht gesendet werden: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
      }
    }
    return saved.event
  }

  async deleteEvent(
    calendarId: string,
    uid: string,
    scope?: 'occurrence' | 'series',
    occurrenceStart?: string,
  ): Promise<void> {
    const entry = this.writable(calendarId)
    const notice = await this.queue.run(entry.source.id, async (): Promise<CancelNotice | null> => {
      const object = this.findObject(entry, uid)
      if (!object) throw new Error('Der Termin wurde nicht gefunden.')
      const parsed = parseIcs(object.ics)
      const group = groupByUid(parsed.events).find((g) => g.uid === uid)
      if (!group) throw new Error('Der Termin wurde nicht gefunden.')
      const master = group.master
      const now = formatUtc(new Date())
      const organizerEvent = master ?? group.overrides[0]
      const organizer = organizerEvent?.organizer
      const account = organizer
        ? this.opts
            .identities()
            .find((i) => i.email.toLowerCase() === organizer.email.toLowerCase())
        : undefined
      const recipients = (events: VEvent[]): string[] => [
        ...new Set(
          events
            .flatMap((e) => e.attendees.map((a) => a.email))
            .filter((e) => e.toLowerCase() !== organizer?.email.toLowerCase() && !this.isMine(e)),
        ),
      ]

      const oneOccurrence =
        scope === 'occurrence' && occurrenceStart && (master ? isRecurring(master) : true)
      if (oneOccurrence) {
        const occ = this.occurrenceOf(group, occurrenceStart!)
        if (!occ?.recurrenceId) throw new Error('Dieser Termin der Serie wurde nicht gefunden.')
        const rid = occ.recurrenceId
        const override = group.overrides.find(
          (o) => o.recurrenceId && sameTime(o.recurrenceId, rid),
        )
        group.overrides = group.overrides.filter((o) => o !== override)
        const cancelled =
          override ?? (master ? deriveOccurrence(master, rid, occ.start, occ.end) : null)
        const to = cancelled ? recipients([cancelled]) : []
        const notifying = Boolean(account && to.length && this.opts.sendItip)
        if (master) {
          master.exdates.push(alignTime(rid, master.start))
          master.dtstamp = now
          master.lastModified = now
          const text = buildCalendarObject(master, group.overrides, {
            timezones: parsed.timezones,
            // we mail the cancellation ourselves; the server must not
            scheduleAgentClient: notifying && entry.kind === 'caldav',
          })
          await this.putObject(entry, uid, text, object)
        } else if (group.overrides.length) {
          const text = buildCalendarObject(group.overrides[0]!, group.overrides.slice(1), {
            timezones: parsed.timezones,
          })
          await this.putObject(entry, uid, text, object)
        } else {
          await this.removeObject(entry, object)
        }
        if (!notifying || !cancelled || !account) return null
        cancelled.status = 'CANCELLED'
        cancelled.sequence =
          Math.max(cancelled.sequence, master?.origin?.sequence ?? master?.sequence ?? 0) + 1
        return {
          accountId: account.accountId,
          to,
          master: cancelled,
          overrides: [],
          timezones: parsed.timezones,
          about: { ...cancelled, start: occ.start, end: occ.end },
          recurring: false,
        }
      }

      await this.removeObject(entry, object)
      const events = [master, ...group.overrides].filter((e): e is VEvent => Boolean(e))
      const to = recipients(events)
      if (!account || !to.length || !this.opts.sendItip) return null
      for (const e of events) {
        e.status = 'CANCELLED'
        e.sequence = (e.origin?.sequence ?? e.sequence) + 1
      }
      return {
        accountId: account.accountId,
        to,
        master: events[0]!,
        overrides: events.slice(1),
        timezones: parsed.timezones,
        about: events[0]!,
        recurring: Boolean(master && isRecurring(master)),
      }
    })

    if (notice && this.opts.sendItip) {
      const ics = buildCalendarObject(notice.master, notice.overrides, {
        method: 'CANCEL',
        timezones: notice.timezones,
      })
      const mail = itipMail('cancel', notice.about, notice.recurring)
      try {
        await this.opts.sendItip(
          notice.accountId,
          notice.to,
          mail.subject,
          mail.text,
          ics,
          'CANCEL',
        )
      } catch (err) {
        throw new Error(
          `Der Termin wurde gelöscht, aber die Absage konnte nicht gesendet werden: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  async importIcs(calendarId: string, text: string): Promise<number> {
    const entry = this.writable(calendarId)
    const parsed = parseIcs(String(text ?? ''))
    const groups = groupByUid(parsed.events.filter((e) => !e.timeless))
    if (!groups.length) throw new Error('Die Datei enthält keine Termine.')
    return this.queue.run(entry.source.id, async () => {
      let count = 0
      let firstError: unknown = null
      try {
        for (const group of groups) {
          const events = [group.master, ...group.overrides].filter((e): e is VEvent => Boolean(e))
          let uid = events[0]!.uid
          if (!uid) {
            uid = `${randomUUID()}@suite-office`
            for (const e of events) e.uid = uid
          }
          try {
            const ics = buildCalendarObject(events[0]!, events.slice(1), {
              timezones: parsed.timezones,
            })
            await this.putObject(entry, uid, ics, this.findObject(entry, uid), true)
            count++
          } catch (err) {
            firstError ??= err
          }
        }
      } finally {
        if (entry.kind === 'local') this.saveLocal()
      }
      if (firstError) {
        const reason = firstError instanceof Error ? firstError.message : String(firstError)
        throw new Error(`${count} von ${groups.length} Terminen importiert. ${reason}`)
      }
      return count
    })
  }

  async exportIcs(calendarId: string): Promise<string> {
    const entry = this.entry(calendarId)
    if (entry.kind === 'ics') return this.feed(entry.source.id)?.text ?? ''
    const zones = new Map<string, string>()
    const events: string[] = []
    for (const { parsed } of this.parsedObjects(entry)) {
      for (const [tzid, block] of Object.entries(parsed.parsed.timezones))
        if (!zones.has(tzid)) zones.set(tzid, block)
      for (const ev of parsed.parsed.events) events.push(serializeRaw(ev.raw))
    }
    const head = [
      'VERSION:2.0',
      'PRODID:-//Suite Office//DE',
      'CALSCALE:GREGORIAN',
      `X-WR-CALNAME:${entry.info.name.replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\r?\n/g, ' ')}`,
    ]
    return (
      ['BEGIN:VCALENDAR', ...head, ...zones.values(), ...events, 'END:VCALENDAR'].join('\r\n') +
      '\r\n'
    )
  }

  findByUid(uid: string): { calendarId: string } | null {
    if (!uid) return null
    for (const entry of this.entries()) {
      if (entry.info.readOnly || entry.kind === 'ics') continue
      if (this.findObject(entry, uid)) return { calendarId: entry.info.id }
    }
    return null
  }

  async upsertIcs(calendarId: string, ics: string): Promise<void> {
    const entry = this.writable(calendarId)
    const parsed = parseIcs(String(ics ?? ''))
    const uid = parsed.events.find((e) => e.uid)?.uid
    if (!uid) throw new Error('Der Termin enthält keine UID.')
    const text = prepareStoredIcs(ics, entry.kind === 'caldav')
    await this.queue.run(entry.source.id, () =>
      this.putObject(entry, uid, text, this.findObject(entry, uid)),
    )
  }

  async removeByUid(calendarId: string, uid: string): Promise<void> {
    const entry = this.writable(calendarId)
    await this.queue.run(entry.source.id, async () => {
      const object = this.findObject(entry, uid)
      if (object) await this.removeObject(entry, object)
    })
  }

  getRawIcs(calendarId: string, uid: string): string | null {
    let entry: Entry
    try {
      entry = this.entry(calendarId)
    } catch {
      return null
    }
    if (entry.kind === 'ics') return null
    return this.findObject(entry, uid)?.ics ?? null
  }
}
