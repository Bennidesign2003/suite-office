import { createHash } from 'node:crypto'
import type { AttendeeStatus } from '../../shared/pim'
import {
  escapeText,
  param,
  parseComponents,
  prop,
  props,
  serializeComponent,
  serializeLine,
  unescapeText,
  type Component,
  type ContentLine,
} from './contentline'
import {
  formatUtc,
  formatWallTime,
  resolveTimezone,
  wallTimeIn,
  zonedToUtc,
  type WallTime,
} from './timezone'
import { buildVtimezone, ianaForVtimezone } from './vtimezone'

/**
 * The iCalendar (RFC 5545) event model: what the calendar reads out of a
 * VEVENT and how it writes one back. Every event keeps its parsed component,
 * and writing starts from it — properties the model does not know (X-*,
 * CATEGORIES, CLASS, ATTACH …) and lines the user did not change go out as
 * they came in, so a server's or another client's data survives our edits.
 */

export type EventTime =
  /** an all-day value, "YYYY-MM-DD" */
  | { kind: 'date'; date: string }
  /**
   * a wall-clock time: in UTC (`utc`), in an IANA zone (`tzid`, already
   * resolved from whatever TZID the file used), or floating (neither)
   */
  | { kind: 'datetime'; utc?: true; wall: WallTime; tzid?: string }

export interface VPerson {
  name?: string
  email: string
}

export interface VAttendee extends VPerson {
  /** upper case as in the file: NEEDS-ACTION, ACCEPTED, DECLINED, TENTATIVE, DELEGATED … */
  partstat: string
  /** upper case: REQ-PARTICIPANT, OPT-PARTICIPANT, NON-PARTICIPANT, CHAIR */
  role: string
  rsvp: boolean
}

export interface VEventFields {
  /** as written in the file (not unescaped); '' when the VEVENT has none */
  uid: string
  summary: string
  location: string
  description: string
  /** upper case: CONFIRMED, TENTATIVE, CANCELLED */
  status?: string
  url?: string
  sequence: number
  dtstamp?: string
  lastModified?: string
  start: EventTime
  /** DTEND, or DTSTART + DURATION, or the RFC default; always after or at start */
  end: EventTime
  /** the DURATION value, when the event had no DTEND */
  duration?: string
  /** the RRULE value, e.g. "FREQ=WEEKLY;BYDAY=MO" */
  rrule?: string
  exdates: EventTime[]
  rdates: EventTime[]
  recurrenceId?: EventTime
  organizer?: VPerson
  attendees: VAttendee[]
  /** minutes before start, from relative VALARM triggers */
  alarms: number[]
  /** no (valid) DTSTART — only legal in iTIP messages such as a REPLY */
  timeless?: true
}

export interface VEvent extends VEventFields {
  /** the component as parsed (or a fresh one for new events) */
  raw: Component
  /** the fields as parsed; writing compares against them to keep unchanged lines verbatim */
  origin?: VEventFields
}

export interface ParsedIcs {
  method?: string
  events: VEvent[]
  /** TZID → VTIMEZONE text, for reuse when the object is written back */
  timezones: Record<string, string>
}

// ---- time helpers ----

const DAY_MS = 86_400_000
const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** a wall time as if it were UTC — the "floating" arithmetic space */
export function wallMs(w: WallTime): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
}

export function wallFromMs(ms: number): WallTime {
  const d = new Date(ms)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  }
}

export function dateMs(date: string): number {
  return Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)))
}

export function dateFromMs(ms: number): string {
  const d = new Date(ms)
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

function localWall(instant: Date): WallTime {
  return {
    year: instant.getFullYear(),
    month: instant.getMonth() + 1,
    day: instant.getDate(),
    hour: instant.getHours(),
    minute: instant.getMinutes(),
    second: instant.getSeconds(),
  }
}

function wallDate(w: WallTime): string {
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`
}

/** the floating wall-clock value of a time (all-day: midnight) */
export function timeMs(t: EventTime): number {
  return t.kind === 'date' ? dateMs(t.date) : wallMs(t.wall)
}

/** a time of the same kind and zone as `like`, at floating wall value `ms` */
export function timeAt(ms: number, like: EventTime): EventTime {
  if (like.kind === 'date') return { kind: 'date', date: dateFromMs(ms) }
  const wall = wallFromMs(ms)
  if (like.utc) return { kind: 'datetime', utc: true, wall }
  return like.tzid ? { kind: 'datetime', wall, tzid: like.tzid } : { kind: 'datetime', wall }
}

/** the instant a time means; all-day and floating times use this computer's clock */
export function toInstant(time: EventTime): Date {
  if (time.kind === 'date') {
    return new Date(
      Number(time.date.slice(0, 4)),
      Number(time.date.slice(5, 7)) - 1,
      Number(time.date.slice(8, 10)),
    )
  }
  if (time.utc) return new Date(wallMs(time.wall))
  return zonedToUtc(time.wall, time.tzid ?? null)
}

/** the wall clock of `like`'s zone (all-day and floating: this computer's) at an instant */
export function wallIn(instant: Date, like: EventTime): WallTime {
  if (like.kind === 'date') return localWall(instant)
  if (like.utc) return wallTimeIn(instant, 'UTC')
  return like.tzid ? wallTimeIn(instant, like.tzid) : localWall(instant)
}

/** an instant expressed the way `like` is (same kind, same zone) */
export function fromInstant(instant: Date, like: EventTime): EventTime {
  const wall = wallIn(instant, like)
  if (like.kind === 'date') return { kind: 'date', date: wallDate(wall) }
  return timeAt(wallMs(wall), like)
}

function sameFrame(a: EventTime, b: EventTime): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'date' || b.kind === 'date') return true
  return Boolean(a.utc) === Boolean(b.utc) && (a.tzid ?? '') === (b.tzid ?? '')
}

/**
 * `t` rewritten in `like`'s kind and zone — how EXDATEs and RECURRENCE-IDs are
 * compared with the occurrences a series generates. A date against a timed
 * series means that day at the series' time of day.
 */
export function alignTime(t: EventTime, like: EventTime): EventTime {
  if (sameFrame(t, like)) return t
  if (like.kind === 'date') {
    return { kind: 'date', date: t.kind === 'date' ? t.date : wallDate(t.wall) }
  }
  if (t.kind === 'date') {
    const timeOfDay = ((wallMs(like.wall) % DAY_MS) + DAY_MS) % DAY_MS
    return timeAt(dateMs(t.date) + timeOfDay, like)
  }
  return fromInstant(toInstant(t), like)
}

function timeKey(t: EventTime): string {
  if (t.kind === 'date') return t.date
  return `${t.utc ? 'Z' : (t.tzid ?? '~')}|${formatWallTime(t.wall)}`
}

export function sameTime(a: EventTime | undefined, b: EventTime | undefined): boolean {
  if (!a || !b) return a === b
  return timeKey(a) === timeKey(b)
}

function sameTimes(a: EventTime[], b: EventTime[]): boolean {
  if (a.length !== b.length) return false
  const x = a.map(timeKey).sort()
  const y = b.map(timeKey).sort()
  return x.every((k, i) => k === y[i])
}

/** RRULE parts in a canonical order, for comparing rules */
export function normalizeRrule(rule: string | undefined): string {
  if (!rule) return ''
  return rule
    .toUpperCase()
    .replace(/^RRULE:/, '')
    .split(';')
    .map((p) => p.trim())
    .filter(Boolean)
    .sort()
    .join(';')
}

/** signed length of an RFC 5545 DURATION in seconds, or null */
export function parseDuration(value: string): number | null {
  const v = value.trim().toUpperCase()
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v)
  if (!m || !m.slice(2).some((x) => x !== undefined) || v.endsWith('T')) return null
  const secs =
    Number(m[2] ?? 0) * 7 * 86400 +
    Number(m[3] ?? 0) * 86400 +
    Number(m[4] ?? 0) * 3600 +
    Number(m[5] ?? 0) * 60 +
    Number(m[6] ?? 0)
  return m[1] === '-' ? -secs : secs
}

function addSeconds(t: EventTime, secs: number): EventTime {
  if (t.kind === 'date') return timeAt(dateMs(t.date) + Math.floor(secs / 86400) * DAY_MS, t)
  return timeAt(wallMs(t.wall) + secs * 1000, t)
}

export function isAllDay(ev: VEventFields): boolean {
  return ev.start.kind === 'date'
}

export function isRecurring(ev: VEventFields): boolean {
  return Boolean(ev.rrule) || ev.rdates.length > 0
}

export function attendeeStatus(partstat: string | undefined): AttendeeStatus {
  switch ((partstat ?? '').toUpperCase()) {
    case 'ACCEPTED':
      return 'accepted'
    case 'DECLINED':
      return 'declined'
    case 'TENTATIVE':
      return 'tentative'
    default:
      return 'needs-action'
  }
}

export function partstatOf(status: AttendeeStatus): string {
  return status === 'needs-action' ? 'NEEDS-ACTION' : status.toUpperCase()
}

// ---- parsing ----

type Resolver = (tzid: string | undefined) => string | null

function validWall(w: WallTime): boolean {
  return (
    w.month >= 1 &&
    w.month <= 12 &&
    w.day >= 1 &&
    w.day <= new Date(Date.UTC(w.year, w.month, 0)).getUTCDate() &&
    w.hour <= 24 &&
    w.minute <= 59 &&
    w.second <= 60
  )
}

/**
 * One DATE or DATE-TIME value. Tolerates what real files contain: DATE values
 * without VALUE=DATE, ISO punctuation ("2026-10-01T09:00:00"), missing
 * seconds, and T240000 for the end of a day.
 */
function parseTime(raw: string, zone: string | null, dateOnly: boolean): EventTime | null {
  const v = raw.trim().replace(/\.\d+/, '').replace(/[-:]/g, '').toUpperCase()
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v)
  if (d) {
    const w = { year: +d[1]!, month: +d[2]!, day: +d[3]!, hour: 0, minute: 0, second: 0 }
    return validWall(w) ? { kind: 'date', date: wallDate(w) } : null
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(v)
  if (!m) return null
  const given = {
    year: +m[1]!,
    month: +m[2]!,
    day: +m[3]!,
    hour: +m[4]!,
    minute: +m[5]!,
    second: +(m[6] ?? 0),
  }
  if (!validWall(given)) return null
  // normalizes 24:00:00 and leap seconds
  const wall = wallFromMs(wallMs(given))
  if (dateOnly) return { kind: 'date', date: wallDate(wall) }
  if (m[7] === 'Z' || zone === 'UTC') return { kind: 'datetime', utc: true, wall }
  return zone ? { kind: 'datetime', wall, tzid: zone } : { kind: 'datetime', wall }
}

function parseTimeLine(line: ContentLine, resolve: Resolver): EventTime | null {
  const dateOnly = param(line, 'VALUE')?.toUpperCase() === 'DATE'
  return parseTime(line.value, resolve(param(line, 'TZID')), dateOnly)
}

/** EXDATE / RDATE: comma lists, and PERIOD values of which only the start matters here */
function parseTimeList(lines: ContentLine[], resolve: Resolver): EventTime[] {
  const out: EventTime[] = []
  for (const line of lines) {
    const dateOnly = param(line, 'VALUE')?.toUpperCase() === 'DATE'
    const zone = resolve(param(line, 'TZID'))
    for (const part of line.value.split(',')) {
      const t = parseTime(part.split('/')[0] ?? '', zone, dateOnly)
      if (t) out.push(t)
    }
  }
  return out
}

/** RFC 6868 parameter escapes (^n ^' ^^) */
function decodeParam(value: string): string {
  return value.replace(/\^(n|N|'|\^)/g, (_m, c: string) =>
    c === 'n' || c === 'N' ? '\n' : c === "'" ? '"' : '^',
  )
}

const EMAIL = /^[^\s@<>"]+@[^\s@<>"]+$/

/** the mail address of an ORGANIZER / ATTENDEE, or null for non-mail addresses (urn:uuid rooms …) */
export function addressOf(line: ContentLine): string | null {
  const value = line.value
    .trim()
    .replace(/^mailto:/i, '')
    .replace(/^"|"$/g, '')
    .trim()
  if (EMAIL.test(value)) return value
  const email = param(line, 'EMAIL')?.trim()
  return email && EMAIL.test(email) ? email : null
}

function personOf(line: ContentLine): VPerson | null {
  const email = addressOf(line)
  if (!email) return null
  const cn = param(line, 'CN')
  const name = cn ? decodeParam(cn).trim() : ''
  return name ? { name, email } : { email }
}

function attendeeOf(line: ContentLine): VAttendee | null {
  const person = personOf(line)
  if (!person) return null
  return {
    ...person,
    partstat: (param(line, 'PARTSTAT') ?? 'NEEDS-ACTION').trim().toUpperCase(),
    role: (param(line, 'ROLE') ?? 'REQ-PARTICIPANT').trim().toUpperCase(),
    rsvp: /^true$/i.test(param(line, 'RSVP')?.trim() ?? ''),
  }
}

/** minutes before start of a VALARM, or null when its trigger is absolute, end-related or after start */
export function alarmMinutes(alarm: Component): number | null {
  const trigger = prop(alarm, 'TRIGGER')
  if (!trigger) return null
  if (param(trigger, 'VALUE')?.toUpperCase() === 'DATE-TIME') return null
  if ((param(trigger, 'RELATED') ?? 'START').toUpperCase() !== 'START') return null
  const secs = parseDuration(trigger.value)
  if (secs === null || secs > 0) return null
  return Math.round(-secs / 60) + 0
}

function textOf(comp: Component, name: string): string {
  const line = prop(comp, name)
  return line ? unescapeText(line.value) : ''
}

const MS_ALL_DAY = ['X-MICROSOFT-CDO-ALLDAYEVENT', 'X-MICROSOFT-MSNCALENDAR-ALLDAYEVENT']

function compareTimes(a: EventTime, b: EventTime): number {
  if (a.kind === 'date' && b.kind === 'date') return a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  return toInstant(a).getTime() - toInstant(b).getTime()
}

function parseEvent(comp: Component, resolve: Resolver): VEvent {
  const dtstart = prop(comp, 'DTSTART')
  const recurrenceIdLine = prop(comp, 'RECURRENCE-ID')
  const recurrenceId = recurrenceIdLine ? parseTimeLine(recurrenceIdLine, resolve) : null
  let start = dtstart ? parseTimeLine(dtstart, resolve) : null
  const timeless = !start
  start ??= recurrenceId ?? { kind: 'date', date: '1970-01-01' }

  let end: EventTime | null = null
  let duration: string | undefined
  const dtend = prop(comp, 'DTEND')
  if (dtend) end = parseTimeLine(dtend, resolve)
  if (!dtend) {
    const durationLine = prop(comp, 'DURATION')
    if (durationLine) {
      duration = durationLine.value.trim()
      const secs = parseDuration(duration)
      if (secs !== null && secs >= 0) end = addSeconds(start, secs)
    }
  }

  // Outlook marks all-day events with a flag and writes midnight-to-midnight times
  const msAllDay = MS_ALL_DAY.some((n) => /^true$/i.test(prop(comp, n)?.value.trim() ?? ''))
  if (
    msAllDay &&
    start.kind === 'datetime' &&
    start.wall.hour === 0 &&
    start.wall.minute === 0 &&
    start.wall.second === 0
  ) {
    const endTime = end
    start = { kind: 'date', date: wallDate(start.wall) }
    if (endTime?.kind === 'datetime') {
      const midnight =
        endTime.wall.hour === 0 && endTime.wall.minute === 0 && endTime.wall.second === 0
      end = {
        kind: 'date',
        date: dateFromMs(dateMs(wallDate(endTime.wall)) + (midnight ? 0 : DAY_MS)),
      }
    }
  }

  // DTEND of the other value type than DTSTART: follow DTSTART
  if (end && start.kind === 'date' && end.kind === 'datetime') {
    const midnight = end.wall.hour === 0 && end.wall.minute === 0 && end.wall.second === 0
    end = { kind: 'date', date: dateFromMs(dateMs(wallDate(end.wall)) + (midnight ? 0 : DAY_MS)) }
  } else if (end && start.kind === 'datetime' && end.kind === 'date') {
    end = timeAt(dateMs(end.date), start)
  }
  if (
    !end ||
    compareTimes(end, start) < 0 ||
    (start.kind === 'date' && !(compareTimes(end, start) > 0))
  ) {
    end = start.kind === 'date' ? timeAt(dateMs(start.date) + DAY_MS, start) : start
  }

  const alarms: number[] = []
  for (const child of comp.children) {
    if (child.name !== 'VALARM') continue
    const minutes = alarmMinutes(child)
    if (minutes !== null && !alarms.includes(minutes)) alarms.push(minutes)
  }

  const organizerLine = prop(comp, 'ORGANIZER')
  const organizer = organizerLine ? personOf(organizerLine) : null
  const attendees: VAttendee[] = []
  for (const line of props(comp, 'ATTENDEE')) {
    const a = attendeeOf(line)
    if (a && !attendees.some((x) => x.email.toLowerCase() === a.email.toLowerCase()))
      attendees.push(a)
  }

  const sequence = Number.parseInt(prop(comp, 'SEQUENCE')?.value.trim() ?? '', 10)
  const status = prop(comp, 'STATUS')?.value.trim().toUpperCase()
  const url = prop(comp, 'URL')?.value.trim()
  const rrule = prop(comp, 'RRULE')?.value.trim()
  const dtstamp = prop(comp, 'DTSTAMP')?.value.trim()
  const lastModified = prop(comp, 'LAST-MODIFIED')?.value.trim()

  const fields: VEventFields = {
    uid: prop(comp, 'UID')?.value.trim() ?? '',
    summary: textOf(comp, 'SUMMARY').trim(),
    location: textOf(comp, 'LOCATION').trim(),
    description: textOf(comp, 'DESCRIPTION'),
    ...(status ? { status } : {}),
    ...(url ? { url } : {}),
    sequence: Number.isFinite(sequence) && sequence > 0 ? sequence : 0,
    ...(dtstamp ? { dtstamp } : {}),
    ...(lastModified ? { lastModified } : {}),
    start,
    end,
    ...(duration ? { duration } : {}),
    ...(rrule ? { rrule } : {}),
    exdates: parseTimeList(props(comp, 'EXDATE'), resolve),
    rdates: parseTimeList(props(comp, 'RDATE'), resolve),
    ...(recurrenceId ? { recurrenceId } : {}),
    ...(organizer ? { organizer } : {}),
    attendees,
    alarms,
    ...(timeless ? { timeless: true as const } : {}),
  }
  return { ...fields, raw: comp, origin: structuredClone(fields) }
}

/**
 * Every VEVENT of an iCalendar text (several VCALENDARs, or bare VEVENTs, are
 * accepted), with TZIDs resolved to IANA zones: known names directly, custom
 * ones through their VTIMEZONE's rules, unknown ones as floating time.
 */
export function parseIcs(text: string): ParsedIcs {
  const roots = parseComponents(text)
  let method: string | undefined
  const timezones: Record<string, string> = {}
  const vtimezones = new Map<string, Component>()
  const eventComps: Component[] = []
  const visit = (comp: Component): void => {
    if (comp.name === 'VEVENT') eventComps.push(comp)
    else if (comp.name === 'VTIMEZONE') {
      const tzid = prop(comp, 'TZID')?.value.trim()
      if (tzid && !vtimezones.has(tzid)) {
        vtimezones.set(tzid, comp)
        timezones[tzid] = serializeRaw(comp)
      }
    }
  }
  for (const root of roots) {
    if (root.name === 'VCALENDAR') {
      method ??= prop(root, 'METHOD')?.value.trim().toUpperCase() || undefined
      root.children.forEach(visit)
    } else visit(root)
  }

  const resolved = new Map<string, string | null>()
  const resolve: Resolver = (tzid) => {
    if (!tzid) return null
    const key = tzid.trim()
    const known = resolved.get(key)
    if (known !== undefined) return known
    let zone = resolveTimezone(key)
    if (!zone) {
      const comp = vtimezones.get(key)
      if (comp) {
        try {
          zone = ianaForVtimezone(comp)
        } catch {
          zone = null
        }
      }
    }
    resolved.set(key, zone)
    return zone
  }

  const events: VEvent[] = []
  for (const comp of eventComps) {
    try {
      events.push(parseEvent(comp, resolve))
    } catch {
      // one broken VEVENT must not hide the rest of the file
    }
  }
  return { ...(method ? { method } : {}), events, timezones }
}

export interface EventGroup {
  /** the UID, or a stable stand-in for events that have none */
  uid: string
  master?: VEvent
  overrides: VEvent[]
}

function syntheticUid(ev: VEvent): string {
  return `nouid-${createHash('sha1').update(serializeRaw(ev.raw)).digest('hex').slice(0, 24)}`
}

/**
 * Events grouped the way a calendar object holds them: the series (no
 * RECURRENCE-ID) and its changed occurrences. Copies of the same event keep
 * the highest SEQUENCE; unrelated events that reuse a UID (broken feeds) stay
 * separate groups rather than disappearing.
 */
export function groupByUid(events: VEvent[]): EventGroup[] {
  const groups: EventGroup[] = []
  const byUid = new Map<string, EventGroup>()
  for (const ev of events) {
    const uid = ev.uid || syntheticUid(ev)
    let group = byUid.get(uid)
    if (!ev.recurrenceId) {
      if (group?.master) {
        if (sameTime(group.master.start, ev.start)) {
          if (ev.sequence >= group.master.sequence) group.master = ev
        } else groups.push({ uid, master: ev, overrides: [] })
        continue
      }
      if (!group) {
        group = { uid, overrides: [] }
        byUid.set(uid, group)
        groups.push(group)
      }
      group.master = ev
      continue
    }
    if (!group) {
      group = { uid, overrides: [] }
      byUid.set(uid, group)
      groups.push(group)
    }
    const at = group.overrides.findIndex((o) => sameTime(o.recurrenceId, ev.recurrenceId))
    if (at < 0) group.overrides.push(ev)
    else if (ev.sequence >= group.overrides[at]!.sequence) group.overrides[at] = ev
  }
  return groups
}

// ---- writing ----

function lineName(line: ContentLine): string {
  return line.group ? `${line.group}.${line.name}` : line.name
}

function writeLine(line: ContentLine): string {
  return serializeLine(lineName(line), line.value, line.params)
}

/** a component written back as parsed */
export function serializeRaw(comp: Component): string {
  return serializeComponent(comp.name, comp.props.map(writeLine), comp.children.map(serializeRaw))
}

/** a new, empty event (no parsed component behind it) */
export function newEvent(uid: string, start: EventTime, end: EventTime): VEvent {
  return {
    uid,
    summary: '',
    location: '',
    description: '',
    sequence: 0,
    start,
    end,
    exdates: [],
    rdates: [],
    attendees: [],
    alarms: [],
    raw: { name: 'VEVENT', props: [], children: [] },
  }
}

const SERIES_ONLY = new Set([
  'RRULE',
  'RDATE',
  'EXDATE',
  'EXRULE',
  'RECURRENCE-ID',
  'DTSTART',
  'DTEND',
  'DURATION',
])

function fieldsOf(ev: VEventFields): VEventFields {
  const { raw: _raw, origin: _origin, ...fields } = ev as VEvent
  return structuredClone(fields)
}

/**
 * A RECURRENCE-ID override for one occurrence of `master`, carrying the
 * series' properties (unknown ones included) and that occurrence's times.
 */
export function deriveOccurrence(
  master: VEvent,
  recurrenceId: EventTime,
  start: EventTime,
  end: EventTime,
): VEvent {
  const base = fieldsOf(master)
  delete base.rrule
  delete base.duration
  delete base.timeless
  const fields: VEventFields = { ...base, exdates: [], rdates: [], recurrenceId, start, end }
  const raw: Component = {
    name: 'VEVENT',
    props: master.raw.props
      .filter((p) => !SERIES_ONLY.has(p.name))
      .map((p) => ({ ...p, params: structuredClone(p.params) })),
    children: structuredClone(master.raw.children),
  }
  return { ...fields, raw, ...(master.origin ? { origin: structuredClone(fields) } : {}) }
}

export interface BuildOptions {
  /** iTIP method (REQUEST, CANCEL, REPLY …): alarms and server scheduling hints are left out */
  method?: string
  /** VTIMEZONEs that came with the object (ParsedIcs.timezones), reused by TZID */
  timezones?: Record<string, string>
  /** CalDAV: we mail invitations ourselves, so the server must not (RFC 6638 SCHEDULE-AGENT) */
  scheduleAgentClient?: boolean
}

interface WriteContext {
  itip: boolean
  now: string
  scheduleAgentClient: boolean
  /** TZID → earliest year it is used in */
  zones: Map<string, number>
}

function useZone(ctx: WriteContext, tzid: string, year: number): void {
  const known = ctx.zones.get(tzid)
  if (known === undefined || year < known) ctx.zones.set(tzid, year)
}

function startYear(ev: VEventFields): number {
  return ev.start.kind === 'date' ? Number(ev.start.date.slice(0, 4)) : ev.start.wall.year
}

function timeValue(t: EventTime): string {
  if (t.kind === 'date') return t.date.replace(/-/g, '')
  return formatWallTime(t.wall) + (t.utc || t.tzid === 'UTC' ? 'Z' : '')
}

function timeParams(t: EventTime): Record<string, string | undefined> {
  if (t.kind === 'date') return { VALUE: 'DATE' }
  return t.tzid && !t.utc && t.tzid !== 'UTC' ? { TZID: t.tzid } : {}
}

function timeLines(name: string, times: EventTime[], ctx: WriteContext): string[] {
  // one line per value type/zone, values comma-joined
  const groups = new Map<string, EventTime[]>()
  for (const t of times) {
    const key = JSON.stringify(timeParams(t))
    groups.set(key, [...(groups.get(key) ?? []), t])
  }
  return [...groups.values()].map((list) => {
    const first = list[0]!
    const params = timeParams(first)
    if (params.TZID && first.kind === 'datetime') useZone(ctx, params.TZID, first.wall.year)
    return serializeLine(name, list.map(timeValue).join(','), params)
  })
}

function triggerValue(minutes: number): string {
  if (minutes === 0) return 'PT0S'
  if (minutes % 1440 === 0) return `-P${minutes / 1440}D`
  if (minutes % 60 === 0) return `-PT${minutes / 60}H`
  return `-PT${minutes}M`
}

function newAlarm(minutes: number, summary: string): string {
  return serializeComponent('VALARM', [
    'ACTION:DISPLAY',
    serializeLine('DESCRIPTION', escapeText(summary || 'Erinnerung')),
    `TRIGGER:${triggerValue(minutes)}`,
  ])
}

const SCHEDULE_PARAMS = ['SCHEDULE-AGENT', 'SCHEDULE-STATUS', 'SCHEDULE-FORCE-SEND']

function scheduleParams(
  params: Record<string, string[]>,
  ctx: WriteContext,
  attendee: boolean,
): Record<string, string[]> {
  const out = { ...params }
  if (ctx.itip) for (const p of SCHEDULE_PARAMS) delete out[p]
  else if (ctx.scheduleAgentClient && attendee) {
    out['SCHEDULE-AGENT'] = ['CLIENT']
    delete out['SCHEDULE-STATUS']
  }
  return out
}

/** SEQUENCE must grow when the time or the recurrence changes (RFC 5546) */
function sequenceOf(ev: VEvent): number {
  const o = ev.origin
  if (!o) return ev.sequence
  const timing =
    !sameTime(ev.start, o.start) ||
    !sameTime(ev.end, o.end) ||
    normalizeRrule(ev.rrule) !== normalizeRrule(o.rrule) ||
    !sameTimes(ev.exdates, o.exdates) ||
    !sameTimes(ev.rdates, o.rdates)
  return timing && ev.sequence <= o.sequence ? o.sequence + 1 : ev.sequence
}

/** properties the model owns; DTEND and DURATION form one group */
const GROUP_OF: Record<string, string> = {
  UID: 'UID',
  DTSTAMP: 'DTSTAMP',
  SEQUENCE: 'SEQUENCE',
  SUMMARY: 'SUMMARY',
  LOCATION: 'LOCATION',
  DESCRIPTION: 'DESCRIPTION',
  STATUS: 'STATUS',
  URL: 'URL',
  DTSTART: 'DTSTART',
  DTEND: 'END',
  DURATION: 'END',
  RRULE: 'RRULE',
  RDATE: 'RDATE',
  EXDATE: 'EXDATE',
  'RECURRENCE-ID': 'RECURRENCE-ID',
  ORGANIZER: 'ORGANIZER',
  ATTENDEE: 'ATTENDEE',
  'LAST-MODIFIED': 'LAST-MODIFIED',
  'X-MICROSOFT-CDO-ALLDAYEVENT': 'X-MICROSOFT-CDO-ALLDAYEVENT',
  'X-ALT-DESC': 'X-ALT-DESC',
}

/** where groups missing from the parsed component are added (new events use this order) */
const ORDER = [
  'UID',
  'DTSTAMP',
  'SEQUENCE',
  'SUMMARY',
  'LOCATION',
  'DESCRIPTION',
  'STATUS',
  'URL',
  'DTSTART',
  'END',
  'RRULE',
  'RDATE',
  'EXDATE',
  'RECURRENCE-ID',
  'ORGANIZER',
  'ATTENDEE',
  'LAST-MODIFIED',
  'X-MICROSOFT-CDO-ALLDAYEVENT',
  'X-ALT-DESC',
]

function samePerson(a: VPerson | undefined, b: VPerson | undefined): boolean {
  if (!a || !b) return a === b
  return a.email.toLowerCase() === b.email.toLowerCase() && (a.name ?? '') === (b.name ?? '')
}

function serializeEvent(ev: VEvent, ctx: WriteContext): string {
  const o = ev.origin
  const year = startYear(ev)
  const byGroup = new Map<string, ContentLine[]>()
  for (const p of ev.raw.props) {
    const g = GROUP_OF[p.name]
    if (g) byGroup.set(g, [...(byGroup.get(g) ?? []), p])
  }
  const verbatim = (lines: ContentLine[]): string[] =>
    lines.map((l) => {
      const tzid = param(l, 'TZID')
      if (tzid) useZone(ctx, tzid, year)
      return writeLine(l)
    })
  const kept = (lines: ContentLine[], unchanged: boolean): boolean =>
    lines.length > 0 && Boolean(o) && unchanged

  const text =
    (name: string, value: string, before: string | undefined, escape = true) =>
    (lines: ContentLine[]): string[] => {
      if (kept(lines, value === (before ?? ''))) return verbatim(lines)
      if (!value) return []
      const params = { ...(lines[0]?.params ?? {}) }
      delete params.ALTREP
      return [serializeLine(name, escape ? escapeText(value) : value, params)]
    }

  const timingUnchanged = Boolean(o) && sameTime(ev.start, o?.start) && sameTime(ev.end, o?.end)
  const sequence = sequenceOf(ev)

  const writers: Record<string, (lines: ContentLine[]) => string[]> = {
    UID: (lines) =>
      kept(lines, ev.uid === o?.uid) ? verbatim(lines) : [serializeLine('UID', ev.uid)],
    DTSTAMP: (lines) => {
      if (ctx.itip) return [`DTSTAMP:${ctx.now}`]
      const value = ev.dtstamp || ctx.now
      return kept(lines, value === o?.dtstamp) ? verbatim(lines) : [`DTSTAMP:${value}`]
    },
    SEQUENCE: (lines) =>
      kept(lines, sequence === o?.sequence) ? verbatim(lines) : [`SEQUENCE:${sequence}`],
    SUMMARY: text('SUMMARY', ev.summary, o?.summary),
    LOCATION: text('LOCATION', ev.location, o?.location),
    DESCRIPTION: text('DESCRIPTION', ev.description, o?.description),
    STATUS: text('STATUS', ev.status ?? '', o?.status, false),
    URL: text('URL', ev.url ?? '', o?.url, false),
    'LAST-MODIFIED': (lines) => {
      if (!ev.lastModified) return []
      return kept(lines, ev.lastModified === o?.lastModified)
        ? verbatim(lines)
        : [`LAST-MODIFIED:${ev.lastModified}`]
    },
    DTSTART: (lines) => {
      if (kept(lines, sameTime(ev.start, o?.start))) return verbatim(lines)
      if (ev.timeless && o && sameTime(ev.start, o.start)) return []
      return timeLines('DTSTART', [ev.start], ctx)
    },
    END: (lines) => {
      if (kept(lines, sameTime(ev.end, o?.end) && ev.duration === o?.duration))
        return verbatim(lines)
      if (ev.timeless) return []
      return timeLines('DTEND', [ev.end], ctx)
    },
    RRULE: (lines) => {
      if (kept(lines, normalizeRrule(ev.rrule) === normalizeRrule(o?.rrule))) return verbatim(lines)
      return ev.rrule ? [serializeLine('RRULE', ev.rrule.replace(/^RRULE:/i, '').trim())] : []
    },
    RDATE: (lines) =>
      kept(lines, sameTimes(ev.rdates, o?.rdates ?? []))
        ? verbatim(lines)
        : timeLines('RDATE', ev.rdates, ctx),
    EXDATE: (lines) =>
      kept(lines, sameTimes(ev.exdates, o?.exdates ?? []))
        ? verbatim(lines)
        : timeLines('EXDATE', ev.exdates, ctx),
    'RECURRENCE-ID': (lines) => {
      if (kept(lines, sameTime(ev.recurrenceId, o?.recurrenceId))) return verbatim(lines)
      return ev.recurrenceId ? timeLines('RECURRENCE-ID', [ev.recurrenceId], ctx) : []
    },
    ORGANIZER: (lines) => {
      if (!ev.organizer) return []
      const old = lines[0]
      if (old && o && samePerson(ev.organizer, o.organizer)) {
        return [serializeLine(lineName(old), old.value, scheduleParams(old.params, ctx, false))]
      }
      const params = scheduleParams({ ...(old?.params ?? {}) }, ctx, false)
      delete params.CN
      delete params.EMAIL
      const named = ev.organizer.name ? { CN: [ev.organizer.name] } : {}
      return [serializeLine('ORGANIZER', `mailto:${ev.organizer.email}`, { ...named, ...params })]
    },
    ATTENDEE: (lines) => {
      const out: string[] = []
      const byEmail = new Map<string, ContentLine>()
      for (const line of lines) {
        const email = addressOf(line)
        if (email) byEmail.set(email.toLowerCase(), line)
        // rooms and resources addressed by URN are not in the model: keep them
        else
          out.push(
            serializeLine(lineName(line), line.value, scheduleParams(line.params, ctx, true)),
          )
      }
      const seen = new Set<string>()
      for (const a of ev.attendees) {
        const key = a.email.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        const old = byEmail.get(key)
        const before = old ? attendeeOf(old) : null
        const params: Record<string, string[]> = old
          ? { ...old.params }
          : {
              CUTYPE: ['INDIVIDUAL'],
              ROLE: [a.role],
              PARTSTAT: [a.partstat],
              RSVP: [a.rsvp ? 'TRUE' : 'FALSE'],
            }
        // only touch what changed, so an unchanged attendee is written as it came
        if (before) {
          if (a.partstat !== before.partstat) params.PARTSTAT = [a.partstat]
          if (a.role !== before.role) params.ROLE = [a.role]
          if (a.rsvp !== before.rsvp) params.RSVP = [a.rsvp ? 'TRUE' : 'FALSE']
        }
        if ((a.name ?? '') !== (before?.name ?? '')) {
          if (a.name) params.CN = [a.name]
          else delete params.CN
        } else if (!old && a.name) params.CN = [a.name]
        const value = old ? old.value : `mailto:${a.email}`
        out.push(
          serializeLine(old ? lineName(old) : 'ATTENDEE', value, scheduleParams(params, ctx, true)),
        )
      }
      return out
    },
    'X-MICROSOFT-CDO-ALLDAYEVENT': (lines) => {
      if (!lines.length) return []
      if (timingUnchanged) return verbatim(lines)
      return [`X-MICROSOFT-CDO-ALLDAYEVENT:${isAllDay(ev) ? 'TRUE' : 'FALSE'}`]
    },
    // Outlook's HTML description: stale once the plain description changes
    'X-ALT-DESC': (lines) => (o && ev.description === o.description ? verbatim(lines) : []),
  }

  const out: string[] = []
  const done = new Set<string>()
  for (const p of ev.raw.props) {
    const g = GROUP_OF[p.name]
    if (!g) {
      out.push(...verbatim([p]))
      continue
    }
    if (done.has(g)) continue
    done.add(g)
    out.push(...writers[g]!(byGroup.get(g) ?? []))
  }
  for (const g of ORDER) {
    if (!done.has(g)) out.push(...writers[g]!([]))
  }

  const children: string[] = []
  const alarmsChanged = !o || [...ev.alarms].sort().join() !== [...o.alarms].sort().join()
  const covered = new Set<number>()
  for (const child of ev.raw.children) {
    if (child.name === 'VALARM') {
      // alarms are personal: invitations carry none
      if (ctx.itip) continue
      const minutes = alarmMinutes(child)
      if (minutes !== null) {
        if (alarmsChanged && !ev.alarms.includes(minutes)) continue
        covered.add(minutes)
      }
      // absolute or end-related alarms are not in the model; they stay
    }
    children.push(serializeRaw(child))
  }
  if (!ctx.itip) {
    for (const minutes of ev.alarms) {
      if (!covered.has(minutes)) {
        covered.add(minutes)
        children.push(newAlarm(minutes, ev.summary))
      }
    }
  }
  return serializeComponent('VEVENT', out, children)
}

function vtimezoneFor(tzid: string, year: number, known?: Record<string, string>): string | null {
  const given = known?.[tzid]
  if (given) return given
  const zone = resolveTimezone(tzid)
  if (!zone) return null
  try {
    return buildVtimezone(zone, year, tzid)
  } catch {
    return null
  }
}

/**
 * A complete calendar object (VCALENDAR) for one event: the series and its
 * overrides, with a VTIMEZONE for every TZID used (the object's own block
 * when it came with one, else generated) and DTSTAMP always present.
 * Unchanged lines are written as parsed; SEQUENCE grows when timing changed.
 */
export function buildCalendarObject(
  master: VEvent,
  overrides: VEvent[],
  opts: BuildOptions = {},
): string {
  const ctx: WriteContext = {
    itip: Boolean(opts.method),
    now: formatUtc(new Date()),
    scheduleAgentClient: Boolean(opts.scheduleAgentClient),
    zones: new Map(),
  }
  const events = [master, ...overrides].map((ev) => serializeEvent(ev, ctx))
  const timezones: string[] = []
  for (const [tzid, year] of ctx.zones) {
    const block = vtimezoneFor(tzid, year, opts.timezones)
    if (block) timezones.push(block)
  }
  const head = ['VERSION:2.0', 'PRODID:-//Suite Office//DE', 'CALSCALE:GREGORIAN']
  if (opts.method) head.push(`METHOD:${opts.method.toUpperCase()}`)
  return serializeComponent('VCALENDAR', head, [...timezones, ...events]) + '\r\n'
}
