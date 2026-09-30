import type { Attendee, CalendarEvent, EventInput } from '../../shared/pim'
import { clip, runAi, stripThinking, type MailContext } from '../ai'
import { languageName } from '../i18n'

/**
 * Suite AI for the calendar: natural-language event drafts, "create an event
 * from this email", free-time search and the prompts for agenda summaries and
 * meeting preparation.
 *
 * The models are small local ones, so the prompts spell everything out (today's
 * date, a table of the coming days, the exact JSON shape) and the answers are
 * parsed defensively: prose around the JSON, Markdown fences, single quotes,
 * trailing commas, German key names and half-formatted dates all still yield a
 * draft when the content is usable. Zone arithmetic is done here with Intl —
 * the renderer cannot reach the main process's timezone module.
 */

// ---- time zones ----

interface Ymd {
  year: number
  month: number
  day: number
}

interface Wall extends Ymd {
  hour: number
  minute: number
  second: number
}

const wallFormatters = new Map<string, Intl.DateTimeFormat>()

function systemZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** the zone itself when Intl knows it, else the computer's zone */
function usableZone(zone: string): string {
  if (!zone) return systemZone()
  if (wallFormatters.has(zone)) return zone
  try {
    wallFormatters.set(
      zone,
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      }),
    )
    return zone
  } catch {
    return zone === systemZone() ? 'UTC' : usableZone(systemZone())
  }
}

/** the wall clock in `zone` at an instant; `zone` must have passed usableZone */
function wallIn(date: Date, zone: string): Wall {
  const parts: Record<string, number> = {}
  for (const p of wallFormatters.get(usableZone(zone))!.formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value)
  }
  return {
    year: parts.year ?? 1970,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: parts.hour === 24 ? 0 : (parts.hour ?? 0),
    minute: parts.minute ?? 0,
    second: parts.second ?? 0,
  }
}

function offsetAt(ms: number, zone: string): number {
  const w = wallIn(new Date(ms), zone)
  return (
    Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000
  )
}

/**
 * The instant at which the wall clock in `zone` shows `wall`. The offsets a day
 * before and after bracket any DST transition; in an autumn overlap the earlier
 * instant wins, a spring-forward gap time is pushed forward (RFC 5545 rules).
 */
function zonedToUtc(wall: Wall, zone: string): number {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  if (zone === 'UTC') return naive
  const before = naive - offsetAt(naive - 86_400_000, zone)
  const after = naive - offsetAt(naive + 86_400_000, zone)
  const shows = (t: number): boolean => {
    const w = wallIn(new Date(t), zone)
    return (
      w.year === wall.year &&
      w.month === wall.month &&
      w.day === wall.day &&
      w.hour === wall.hour &&
      w.minute === wall.minute
    )
  }
  const valid = [before, after].filter(shows)
  return valid.length ? Math.min(...valid) : before
}

// ---- plain calendar dates ----

const WEEKDAYS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function addDays(d: Ymd, n: number): Ymd {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n))
  return { year: t.getUTCFullYear(), month: t.getUTCMonth() + 1, day: t.getUTCDate() }
}

function weekdayOf(d: Ymd): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay()
}

function dayNumber(d: Ymd): number {
  return Date.UTC(d.year, d.month - 1, d.day) / 86_400_000
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

function ymdString(d: Ymd): string {
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`
}

function validYmd(year: number, month: number, day: number): Ymd | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1) return null
  if (day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return null
  return { year, month, day }
}

function todayIn(nowIso: string, zone: string): { date: Ymd; wall: Wall } {
  const parsed = Date.parse(nowIso)
  const wall = wallIn(new Date(Number.isFinite(parsed) ? parsed : Date.now()), zone)
  return { date: { year: wall.year, month: wall.month, day: wall.day }, wall }
}

// ---- lenient JSON ----

const LOOSE_FAIL = new Error('loose json')

/** string delimiters small models use, and what may close each */
const QUOTES: Record<string, string> = {
  '"': '"',
  "'": "'",
  '“': '”“',
  '”': '”',
  '„': '“”',
  '‘': '’‘',
  '‚': '‘’',
  '«': '»',
  '»': '«',
}

function bareValue(word: string): unknown {
  if (!word) return null
  if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(word)) return Number(word)
  const lower = word.toLowerCase()
  if (lower === 'true') return true
  if (lower === 'false') return false
  if (lower === 'null' || lower === 'none' || lower === 'undefined' || lower === 'nil') return null
  return word
}

/**
 * A forgiving JSON reader starting at `start` (which must be '{' or '['):
 * accepts single and typographic quotes, unquoted keys and values, comments,
 * trailing or missing commas, Python literals, and an answer cut off at the end.
 * Objects have no prototype, so a "__proto__" key is just data.
 */
function parseLoose(src: string, start: number): { value: unknown; end: number } | null {
  let i = start
  let depth = 0
  const fail = (): never => {
    throw LOOSE_FAIL
  }
  const skip = (): void => {
    while (i < src.length) {
      const c = src[i]!
      if (/\s/.test(c)) i++
      else if (c === '/' && src[i + 1] === '/') {
        const nl = src.indexOf('\n', i)
        i = nl < 0 ? src.length : nl + 1
      } else if (c === '/' && src[i + 1] === '*') {
        const close = src.indexOf('*/', i + 2)
        i = close < 0 ? src.length : close + 2
      } else return
    }
  }
  const str = (): string => {
    const close = QUOTES[src[i]!]!
    i++
    let out = ''
    while (i < src.length) {
      const c = src[i]!
      if (c === '\\') {
        const n = src[i + 1]
        i += 2
        if (n === 'n') out += '\n'
        else if (n === 't') out += '\t'
        else if (n === 'r' || n === 'b' || n === 'f' || n === undefined) out += ''
        else if (n === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(i, i + 4))) {
          out += String.fromCharCode(parseInt(src.slice(i, i + 4), 16))
          i += 4
        } else out += n
        continue
      }
      i++
      if (close.includes(c)) return out
      out += c
    }
    return out
  }
  const bare = (stop: RegExp): string => {
    const from = i
    while (i < src.length && !stop.test(src[i]!)) i++
    return src.slice(from, i).trim()
  }
  const value = (): unknown => {
    skip()
    const c = src[i]
    if (c === undefined || c === '}' || c === ']' || c === ':') return fail()
    if (c === '{') return obj()
    if (c === '[') return arr()
    if (QUOTES[c]) return str()
    return bareValue(bare(/[,}\]\n]/))
  }
  const obj = (): Record<string, unknown> => {
    if (++depth > 32) fail()
    i++
    const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (;;) {
      skip()
      const c = src[i]
      if (c === undefined) break
      if (c === '}') {
        i++
        break
      }
      if (c === ',') {
        i++
        continue
      }
      let key: string
      if (QUOTES[c]) key = str()
      else if (/[\p{L}\p{N}_$]/u.test(c)) key = bare(/[:=\s,{}[\]]/)
      else return fail()
      skip()
      if (src[i] !== ':' && src[i] !== '=') return fail()
      i++
      out[key] = value()
    }
    depth--
    return out
  }
  const arr = (): unknown[] => {
    if (++depth > 32) fail()
    i++
    const out: unknown[] = []
    for (;;) {
      skip()
      const c = src[i]
      if (c === undefined) break
      if (c === ']') {
        i++
        break
      }
      if (c === ',') {
        i++
        continue
      }
      if (c === '}' || out.length >= 500) return fail()
      out.push(value())
    }
    depth--
    return out
  }
  try {
    const result = value()
    return { value: result, end: i }
  } catch {
    return null
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** JSON objects in a model answer, fenced ones first, in order of appearance */
function jsonObjects(text: string): Array<Record<string, unknown>> {
  const sources = [...text.matchAll(/```[\w-]*[ \t]*\n?([\s\S]*?)```/g)].map((m) => m[1] ?? '')
  sources.push(text)
  const found: Array<Record<string, unknown>> = []
  for (const src of sources) {
    let at = src.indexOf('{')
    for (let tries = 0; at >= 0 && tries < 40 && found.length < 12; tries++) {
      const parsed = parseLoose(src, at)
      if (parsed && isRecord(parsed.value)) {
        found.push(parsed.value)
        at = src.indexOf('{', Math.max(parsed.end, at + 1))
      } else {
        at = src.indexOf('{', at + 1)
      }
    }
  }
  return found
}

// ---- field readers ----

const normKey = (k: string): string => k.toLowerCase().replace(/[\s_-]/g, '')

const ALIASES = {
  title: ['title', 'titel', 'summary', 'subject', 'betreff', 'name', 'event', 'termin'],
  date: ['date', 'datum', 'day', 'tag', 'startdate', 'startdatum'],
  start: [
    'start',
    'starttime',
    'startzeit',
    'begin',
    'beginn',
    'from',
    'von',
    'time',
    'zeit',
    'uhrzeit',
  ],
  end: ['end', 'endtime', 'endzeit', 'ende', 'to', 'bis'],
  endDate: ['enddate', 'enddatum', 'lastday', 'dateend'],
  duration: ['durationminutes', 'duration', 'dauer', 'durationmin', 'minutes', 'minuten', 'length'],
  allDay: ['allday', 'ganztägig', 'ganztaegig', 'ganztags', 'wholeday', 'fullday', 'isallday'],
  location: ['location', 'ort', 'place', 'where', 'wo', 'address', 'adresse', 'venue'],
  description: ['description', 'beschreibung', 'notes', 'note', 'notizen', 'details', 'body'],
  attendees: ['attendees', 'teilnehmer', 'participants', 'invitees', 'guests', 'gäste', 'emails'],
  rrule: ['rrule', 'recurrence', 'repeat', 'repeats', 'rule', 'wiederholung'],
} as const

function pick(obj: Record<string, unknown>, aliases: readonly string[]): unknown {
  const wanted = new Set(aliases)
  for (const [k, v] of Object.entries(obj)) if (wanted.has(normKey(k))) return v
  return undefined
}

const EMPTY_WORDS =
  /^(null|none|nil|undefined|n\/a|na|-+|–|keine?|kein ort|unknown|unbekannt|tbd)$/i

function text(v: unknown, max: number, multiline = false): string {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v !== 'string') return ''
  let s = v.replace(/\r\n?/g, '\n')
  s = multiline
    ? s
        .split('\n')
        .map((l) => l.replace(/[ \t]+/g, ' ').trimEnd())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
    : s.replace(/\s+/g, ' ')
  s = s.trim().replace(/^["'„“”]+|["'“”]+$/g, '')
  if (EMPTY_WORDS.test(s)) return ''
  return s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s
}

function bool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null
  if (typeof v !== 'string') return null
  const s = v.trim().toLowerCase()
  if (['true', 'yes', 'ja', 'y', '1', 'wahr'].includes(s)) return true
  if (['false', 'no', 'nein', 'n', '0', 'falsch'].includes(s)) return false
  return null
}

/** minutes after midnight for "15:30", "15 Uhr", "3pm", "T15:30", 15, 15.3 … */
function clock(v: unknown, allowMidnightEnd = false): number | null {
  let h: number
  let m: number
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) return null
    const [whole = '', frac = ''] = String(v).split('.')
    h = Number(whole)
    m = frac ? Number(frac.padEnd(2, '0').slice(0, 2)) : 0
  } else if (typeof v === 'string') {
    const s = v.trim().toLowerCase()
    if (!s || EMPTY_WORDS.test(s)) return null
    const dated = s.match(/\d{4}-\d{1,2}-\d{1,2}(?:t|\s+)(\d{1,2}):(\d{2})/)
    if (dated) {
      h = Number(dated[1])
      m = Number(dated[2])
    } else {
      const t = s.match(
        /^(?:(?:um|at|ab|from|von|gegen|ca\.?)\s+)?t?(\d{1,2})(?:\s*[:.h]\s*(\d{2}))?(?::\d{2}(?:\.\d+)?)?\s*(uhr|h|am|a\.\s?m\.|pm|p\.\s?m\.)?$/,
      )
      if (!t) return null
      h = Number(t[1])
      m = t[2] ? Number(t[2]) : 0
      const suffix = t[3]?.replace(/[.\s]/g, '')
      if (suffix === 'am' || suffix === 'pm') {
        if (h < 1 || h > 12) return null
        h = (h % 12) + (suffix === 'pm' ? 12 : 0)
      }
    }
  } else return null
  if (!Number.isInteger(h) || !Number.isInteger(m) || m < 0 || m > 59) return null
  if (h === 24 && m === 0 && allowMidnightEnd) return 1440
  if (h < 0 || h > 23) return null
  return h * 60 + m
}

function durationMinutes(v: unknown): number | null {
  let minutes: number | null = null
  if (typeof v === 'number') minutes = v
  else if (typeof v === 'string') {
    const s = v.trim().toLowerCase().replace(',', '.')
    const hours = s.match(/(\d+(?:\.\d+)?)\s*(?:h\b|hrs?\b|hours?\b|std\.?|stunden?\b)/)
    const mins = s.match(/(\d+)\s*(?:m\b|min\.?|mins?\b|minutes?\b|minuten?\b)/)
    if (hours || mins) minutes = (hours ? Number(hours[1]) * 60 : 0) + (mins ? Number(mins[1]) : 0)
    else if (/^\d+(\.\d+)?$/.test(s)) minutes = Number(s)
  }
  if (minutes === null || !Number.isFinite(minutes)) return null
  minutes = Math.round(minutes)
  return minutes >= 1 && minutes <= 14 * 24 * 60 ? minutes : null
}

const WEEKDAY_WORDS: Record<string, number> = {
  sunday: 0,
  sonntag: 0,
  sun: 0,
  so: 0,
  monday: 1,
  montag: 1,
  mon: 1,
  mo: 1,
  tuesday: 2,
  dienstag: 2,
  tue: 2,
  tues: 2,
  di: 2,
  wednesday: 3,
  mittwoch: 3,
  wed: 3,
  mi: 3,
  thursday: 4,
  donnerstag: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  do: 4,
  friday: 5,
  freitag: 5,
  fri: 5,
  fr: 5,
  saturday: 6,
  samstag: 6,
  sonnabend: 6,
  sat: 6,
  sa: 6,
}

const MONTHS: Record<string, number> = {
  jan: 1,
  feb: 2,
  mär: 3,
  mar: 3,
  apr: 4,
  mai: 5,
  may: 5,
  jun: 6,
  jul: 7,
  aug: 8,
  sep: 9,
  okt: 10,
  oct: 10,
  nov: 11,
  dez: 12,
  dec: 12,
}

/**
 * A date from the model: "2026-10-01" as asked, but also "01.10.2026",
 * "1.10.", "1. Oktober", "Oct 1, 2026", "2026/10/01", "20261001", an ISO date-time (its clock part comes
 * back as `time`), or a word the model failed to resolve ("morgen",
 * "Donnerstag", "nächste Woche Dienstag") — resolved against today.
 * Zone designators on date-times are ignored: models that write "…T15:00Z"
 * mean 15:00 on the user's clock, not in London.
 */
function dateField(v: unknown, today: Ymd): { date: Ymd; time: number | null } | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v).trim().toLowerCase()
  if (!s || EMPTY_WORDS.test(s)) return null
  const withTime = (date: Ymd | null, rest: string): { date: Ymd; time: number | null } | null => {
    if (!date) return null
    const t = rest.match(/^(?:t|\s+|,\s*)(\d{1,2}:\d{2})/)
    return { date, time: t ? clock(t[1]) : null }
  }
  let m = s.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/)
  if (m) {
    return withTime(
      validYmd(Number(m[1]), Number(m[2]), Number(m[3])),
      s.slice((m.index ?? 0) + m[0].length),
    )
  }
  m = s.match(/^(\d{4})(\d{2})(\d{2})(?:t(\d{2})(\d{2}))?/)
  if (m) {
    const date = validYmd(Number(m[1]), Number(m[2]), Number(m[3]))
    if (!date) return null
    return { date, time: m[4] ? clock(`${m[4]}:${m[5]}`) : null }
  }
  const dayMonth = (day: number, month: number, yearText: string | undefined): Ymd | null => {
    let year = yearText ? Number(yearText) : today.year
    if (yearText && yearText.length === 2) year += 2000
    const date = validYmd(year, month, day)
    // no year given: the next such day, not one that has just passed
    return !yearText && date && dayNumber(date) < dayNumber(today)
      ? validYmd(year + 1, month, day)
      : date
  }
  m = s.match(/(\d{1,2})\.\s?(\d{1,2})\.(?:\s?(\d{4}|\d{2})\b)?/)
  if (m) {
    return withTime(
      dayMonth(Number(m[1]), Number(m[2]), m[3]),
      s.slice((m.index ?? 0) + m[0].length),
    )
  }
  // "Do, 1. Oktober 2026", "1 Oct" first, then "October 1st, 2026"; each pass on
  // its own so a weekday before the day cannot swallow it
  const named: Array<[RegExp, number, number, number]> = [
    [/(\d{1,2})(?!\d)(?:st|nd|rd|th|\.)?\s*(?:of\s+)?([a-zä]{3,})\.?,?(?:\s+(\d{4}))?/g, 1, 2, 3],
    [/([a-zä]{3,})\.?\s+(\d{1,2})(?!\d)(?:st|nd|rd|th|\.)?(?:,?\s+(\d{4}))?/g, 2, 1, 3],
  ]
  for (const [re, dayAt, monthAt, yearAt] of named) {
    for (const n of s.matchAll(re)) {
      const month = MONTHS[(n[monthAt] ?? '').slice(0, 3)]
      if (!month) continue
      const date = dayMonth(Number(n[dayAt]), month, n[yearAt])
      return withTime(date, s.slice((n.index ?? 0) + n[0].length))
    }
  }
  const words = s.split(/[^a-zäöüß]+/).filter(Boolean)
  const has = (...w: string[]): boolean => w.every((x) => words.includes(x))
  if (has('übermorgen') || has('day', 'after', 'tomorrow'))
    return { date: addDays(today, 2), time: null }
  if (has('morgen') || has('tomorrow')) return { date: addDays(today, 1), time: null }
  if (has('heute') || has('today')) return { date: today, time: null }
  const weekday = words.map((w) => WEEKDAY_WORDS[w]).find((n) => n !== undefined)
  const nextWeek = (has('nächste', 'woche') || has('next', 'week')) && !has('this')
  if (weekday !== undefined) {
    if (nextWeek) {
      const monday = addDays(today, 7 - ((weekdayOf(today) + 6) % 7))
      return { date: addDays(monday, (weekday + 6) % 7), time: null }
    }
    const ahead = (weekday - weekdayOf(today) + 7) % 7 || 7
    return { date: addDays(today, ahead), time: null }
  }
  if (nextWeek) return { date: addDays(today, 7 - ((weekdayOf(today) + 6) % 7)), time: null }
  return null
}

const EMAIL = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/

function attendeesField(v: unknown): Attendee[] {
  const items: unknown[] = Array.isArray(v)
    ? v
    : typeof v === 'string'
      ? v.split(/[,;\n]/)
      : isRecord(v)
        ? [v]
        : []
  const out: Attendee[] = []
  const seen = new Set<string>()
  for (const item of items) {
    let raw = ''
    let name = ''
    if (typeof item === 'string') raw = item
    else if (isRecord(item)) {
      raw = text(pick(item, ['email', 'mail', 'address', 'emailaddress', 'adresse']), 320)
      name = text(pick(item, ['name', 'displayname', 'fullname']), 120)
    }
    const found = raw.match(EMAIL)
    if (!found) continue
    const email = found[0].toLowerCase()
    if (seen.has(email)) continue
    seen.add(email)
    if (!name && typeof item === 'string') {
      name = text(item.slice(0, found.index).replace(/[<(["]+\s*$/, ''), 120)
    }
    out.push({ email, status: 'needs-action', ...(name ? { name } : {}) })
    if (out.length >= 50) break
  }
  return out
}

const RRULE_WORDS: Array<[RegExp, string]> = [
  [/^(daily|täglich|jeden tag|every day)$/, 'FREQ=DAILY'],
  [/^(weekly|wöchentlich|jede woche|every week)$/, 'FREQ=WEEKLY'],
  [
    /^(biweekly|fortnightly|alle (2|zwei) wochen|every (2|two|other) weeks?)$/,
    'FREQ=WEEKLY;INTERVAL=2',
  ],
  [/^(monthly|monatlich|jeden monat|every month)$/, 'FREQ=MONTHLY'],
  [/^(yearly|annually|jährlich|jedes jahr|every year)$/, 'FREQ=YEARLY'],
]

const RRULE_ORDER = [
  'FREQ',
  'INTERVAL',
  'COUNT',
  'UNTIL',
  'BYMONTH',
  'BYWEEKNO',
  'BYYEARDAY',
  'BYMONTHDAY',
  'BYDAY',
  'BYSETPOS',
  'WKST',
]

/** a comma list of (possibly negative) numbers whose size lies in [min, max] */
function intList(value: string, min: number, max: number): boolean {
  return value.split(',').every((p) => {
    if (!/^[-+]?\d{1,3}$/.test(p)) return false
    const n = Math.abs(Number(p))
    return n >= min && n <= max
  })
}

/**
 * An RRULE value the calendar backend can store, or undefined. Unknown parts
 * are dropped rather than failing the whole draft; UNTIL is rewritten to the
 * value type RFC 5545 requires (a date for all-day events, UTC otherwise).
 */
function rruleField(v: unknown, allDay: boolean, zone: string): string | undefined {
  if (typeof v !== 'string') return undefined
  const plain = v.trim().toLowerCase()
  for (const [re, rule] of RRULE_WORDS) if (re.test(plain)) return rule
  const s = v
    .trim()
    .replace(/^RRULE:/i, '')
    .replace(/\s+/g, '')
    .toUpperCase()
  if (!s || EMPTY_WORDS.test(s)) return undefined
  const parts = new Map<string, string>()
  for (const part of s.split(';')) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    const key = part.slice(0, eq)
    const value = part.slice(eq + 1)
    if (!value) continue
    let ok = false
    switch (key) {
      case 'FREQ':
        ok = /^(DAILY|WEEKLY|MONTHLY|YEARLY)$/.test(value)
        break
      case 'INTERVAL':
        ok = /^\d{1,3}$/.test(value) && Number(value) >= 1
        break
      case 'COUNT':
        ok = /^\d{1,4}$/.test(value) && Number(value) >= 1
        break
      case 'UNTIL':
        ok = /^\d{8}(T\d{6}Z?)?$/.test(value)
        break
      case 'BYDAY':
        ok = value.split(',').every((d) => /^([+-]?[1-5])?(MO|TU|WE|TH|FR|SA|SU)$/.test(d))
        break
      case 'BYMONTHDAY':
        ok = intList(value, 1, 31)
        break
      case 'BYMONTH':
        ok = intList(value, 1, 12) && !value.includes('-')
        break
      case 'BYSETPOS':
      case 'BYYEARDAY':
        ok = intList(value, 1, 366)
        break
      case 'BYWEEKNO':
        ok = intList(value, 1, 53)
        break
      case 'WKST':
        ok = /^(MO|TU|WE|TH|FR|SA|SU)$/.test(value)
        break
    }
    if (ok) parts.set(key, value)
  }
  if (!parts.has('FREQ')) return undefined
  if (parts.has('COUNT')) parts.delete('UNTIL')
  const until = parts.get('UNTIL')
  if (until) {
    const date = validYmd(
      Number(until.slice(0, 4)),
      Number(until.slice(4, 6)),
      Number(until.slice(6, 8)),
    )
    if (!date) parts.delete('UNTIL')
    else if (allDay) parts.set('UNTIL', until.slice(0, 8))
    else if (!until.endsWith('Z')) {
      // a bare date means "through that day": the last second of it on the user's clock
      const clockPart = until.length > 8 ? until.slice(9) : '235959'
      const utc = new Date(
        zonedToUtc(
          {
            ...date,
            hour: Number(clockPart.slice(0, 2)) % 24,
            minute: Number(clockPart.slice(2, 4)) % 60,
            second: Number(clockPart.slice(4, 6)) % 60,
          },
          zone,
        ),
      )
      parts.set(
        'UNTIL',
        `${pad(utc.getUTCFullYear(), 4)}${pad(utc.getUTCMonth() + 1)}${pad(utc.getUTCDate())}` +
          `T${pad(utc.getUTCHours())}${pad(utc.getUTCMinutes())}${pad(utc.getUTCSeconds())}Z`,
      )
    }
  }
  return RRULE_ORDER.filter((k) => parts.has(k))
    .map((k) => `${k}=${parts.get(k)}`)
    .join(';')
}

function draftFrom(
  raw: Record<string, unknown>,
  today: Ymd,
  zone: string,
  nested = false,
): Partial<EventInput> | null {
  const rawDate = pick(raw, ALIASES.date)
  const rawTitle = pick(raw, ALIASES.title)
  if (rawDate === undefined && !nested) {
    // {"event": {...}} or {"events": [{...}]}: look one level down
    for (const v of Object.values(raw)) {
      const inner = Array.isArray(v) ? v.find(isRecord) : v
      if (isRecord(inner)) {
        const draft = draftFrom(inner, today, zone, true)
        if (draft) return draft
      }
    }
  }
  const rawStart = pick(raw, ALIASES.start)
  let parsedDate = dateField(rawDate, today)
  // some models put the whole date-time into "start"
  if (!parsedDate && typeof rawStart === 'string') {
    const fromStart = dateField(rawStart, today)
    if (fromStart && /\d{4}-\d{1,2}-\d{1,2}/.test(rawStart)) parsedDate = fromStart
  }
  if (!parsedDate) return null
  const date = parsedDate.date

  const title = isRecord(rawTitle) ? '' : text(rawTitle, 200)
  const location = text(pick(raw, ALIASES.location), 300)
  const description = text(pick(raw, ALIASES.description), 4000, true)
  const attendees = attendeesField(pick(raw, ALIASES.attendees))
  const startMin = clock(rawStart) ?? parsedDate.time
  const rawEnd = pick(raw, ALIASES.end)
  const endParsed = typeof rawEnd === 'string' ? dateField(rawEnd, today) : null
  const endMin = clock(rawEnd, true) ?? endParsed?.time ?? null
  const endDate = dateField(pick(raw, ALIASES.endDate), today)?.date ?? null
  const duration = durationMinutes(pick(raw, ALIASES.duration))
  const allDayFlag = bool(pick(raw, ALIASES.allDay))
  // Small models contradict themselves: a real clock time beats "allDay": true,
  // but 00:00 (–23:59) is how they fill the time fields of an all-day event.
  const allDay =
    startMin === null ||
    (startMin === 0 && (allDayFlag === true || (endMin !== null && endMin >= 1439)))

  let start: string
  let end: string
  if (allDay) {
    let days = 1
    if (endDate && dayNumber(endDate) >= dayNumber(date)) {
      // the model names the last day; iCalendar wants the day after it
      days = dayNumber(endDate) - dayNumber(date) + 1
    } else if (duration && duration >= 1440) {
      days = Math.round(duration / 1440)
    }
    start = ymdString(date)
    end = ymdString(addDays(date, Math.min(Math.max(days, 1), 366)))
  } else {
    const at = (day: Ymd, minutes: number): number =>
      zonedToUtc({ ...day, hour: Math.floor(minutes / 60), minute: minutes % 60, second: 0 }, zone)
    const startMs = at(date, startMin)
    if (!Number.isFinite(startMs)) return null
    let endMs = NaN
    if (endMin !== null) {
      const explicitDay = endParsed?.time != null ? endParsed.date : endDate
      const endDay = explicitDay ?? date
      endMs = endMin === 1440 ? at(addDays(endDay, 1), 0) : at(endDay, endMin)
      // "22:00–01:00": without a day of its own the end is on the next day
      if (endMs <= startMs && !explicitDay && endMin !== 1440) endMs = at(addDays(date, 1), endMin)
      if (endMs <= startMs || endMs - startMs > 14 * 86_400_000) endMs = NaN
    }
    if (!Number.isFinite(endMs)) endMs = startMs + (duration ?? 60) * 60_000
    start = new Date(startMs).toISOString()
    end = new Date(endMs).toISOString()
  }

  const draft: Partial<EventInput> = { title, start, end, allDay, timezone: zone }
  if (location) draft.location = location
  if (description) draft.description = description
  if (attendees.length) draft.attendees = attendees
  const rrule = rruleField(pick(raw, ALIASES.rrule), allDay, zone)
  if (rrule) draft.rrule = rrule
  return draft
}

/**
 * Turns the model's answer to eventDraftPrompt / mailEventPrompt into event
 * fields: the first JSON object in the text that names a usable date wins.
 * Timed events come back as UTC instants computed from the wall times in
 * `timezone`; all-day events as dates with an exclusive end. Without an end or
 * duration a meeting lasts 60 minutes; without a time it is all-day. Returns
 * null when no object carries a valid date (including the model's
 * {"date": null} for "no appointment here").
 */
export function parseEventDraft(
  modelText: string,
  nowIso: string,
  timezone: string,
): Partial<EventInput> | null {
  if (typeof modelText !== 'string' || !modelText.trim()) return null
  const zone = usableZone(timezone)
  const { date: today } = todayIn(nowIso, zone)
  for (const obj of jsonObjects(stripThinking(modelText))) {
    const draft = draftFrom(obj, today, zone)
    if (draft) return draft
  }
  return null
}

// ---- prompts ----

const BASE = `You are Suite AI, the calendar assistant built into Suite Office. You run on the user's own computer.`

function localWeekday(d: Ymd, lang: string): string {
  try {
    return new Intl.DateTimeFormat(lang, { weekday: 'long', timeZone: 'UTC' }).format(
      new Date(Date.UTC(d.year, d.month - 1, d.day)),
    )
  } catch {
    return WEEKDAYS_EN[weekdayOf(d)]!
  }
}

/** today plus the next two weeks with weekday names, so a small model can look dates up */
function dateContext(nowIso: string, timezone: string, lang: string): string {
  const zone = usableZone(timezone)
  const { date: today, wall } = todayIn(nowIso, zone)
  const withLocal = !lang.startsWith('en')
  const mondayNext = addDays(today, 7 - ((weekdayOf(today) + 6) % 7))
  const lines: string[] = []
  for (let n = 0; n < 15; n++) {
    const d = addDays(today, n)
    const label = WEEKDAYS_EN[weekdayOf(d)]!
    const local = withLocal ? localWeekday(d, lang) : ''
    const note =
      n === 0
        ? ' (today)'
        : n === 1
          ? ' (tomorrow)'
          : n === 2
            ? ' (day after tomorrow)'
            : dayNumber(d) === dayNumber(mondayNext)
              ? ' (start of next week)'
              : ''
    lines.push(`${ymdString(d)} ${label}${local && local !== label ? ` / ${local}` : ''}${note}`)
  }
  return (
    `Today is ${WEEKDAYS_EN[weekdayOf(today)]}, ${ymdString(today)}; the time is ${pad(wall.hour)}:${pad(wall.minute)} in the time zone ${zone}. ` +
    `All times are wall-clock times in ${zone}.\n\nThe coming days (look dates up here, do not compute them):\n${lines.join('\n')}`
  )
}

function draftRules(nowIso: string, timezone: string, lang: string, fromMail: boolean): string {
  const zone = usableZone(timezone)
  const { date: today } = todayIn(nowIso, zone)
  const mondayNext = addDays(today, 7 - ((weekdayOf(today) + 6) % 7))
  const exampleDate = ymdString(addDays(mondayNext, 4))
  const language = languageName(lang)
  return `${dateContext(nowIso, timezone, lang)}

How to read dates and times:
- "today"/"heute", "tomorrow"/"morgen", "day after tomorrow"/"übermorgen" count from ${fromMail ? 'the day the email was sent' : 'today'}.
- A weekday alone ("Thursday", "Donnerstag", "am Freitag") is the next such day after ${fromMail ? 'the day the email was sent' : 'today'}.
- "next week" + weekday ("nächste Woche Dienstag") is that weekday in the week starting ${ymdString(mondayNext)}. "next week" alone is ${ymdString(mondayNext)}.
- "15 Uhr", "15h", "3 pm" are 15:00. "halb drei" is 14:30, "Viertel nach drei" is 15:15, "Viertel vor drei" is 14:45.
- No time at all: "allDay": true, "start": null, "end": null.
- An end time or duration mentioned ("bis 17 Uhr", "2 Stunden"): fill "end" or "durationMinutes". Otherwise "end": null and "durationMinutes": 60.

Fields:
- "title": a short name for the appointment (e.g. "Zahnarzt", "Team meeting"), without date or time, in the language of the ${fromMail ? 'email' : 'text'} (${language} if unclear).
- "location": the place or address; "" if none.
- "description": ${fromMail ? 'the useful details from the email in 1–3 short lines (booking number, dial-in link, what to bring)' : 'further details from the text'}; "" if none.
- "attendees": ${
    fromMail
      ? 'email addresses of people who will take part, only when the email arranges a meeting between the people in its From/To lines; never shops, companies, doctors or no-reply addresses; [] otherwise'
      : 'email addresses written in the text; [] if none'
  }. Never invent addresses.
- "rrule": only for a repeating appointment, as an iCalendar RRULE value such as "FREQ=WEEKLY;BYDAY=MO" or "FREQ=MONTHLY;BYMONTHDAY=1"; otherwise null.
${fromMail ? '- Several appointments in the email: take the one the email is mainly about.\n' : ''}- No appointment at all: answer {"title": null, "date": null}.

Answer with exactly one JSON object and nothing else: no explanation, no Markdown. The shape:
{"title": string, "date": "YYYY-MM-DD", "start": "HH:MM" or null, "end": "HH:MM" or null, "durationMinutes": number, "allDay": boolean, "location": string, "description": string, "attendees": [string], "rrule": string or null}

Example (only to show the format): "Lunch with Maria (maria@example.org) next week Friday 12:30 at Café Rossi" becomes
{"title": "Lunch with Maria", "date": "${exampleDate}", "start": "12:30", "end": null, "durationMinutes": 60, "allDay": false, "location": "Café Rossi", "description": "", "attendees": ["maria@example.org"], "rrule": null}`
}

/** ask the model to turn the user's own words ("Zahnarzt Donnerstag 15 Uhr") into event JSON */
export function eventDraftPrompt(
  text: string,
  nowIso: string,
  timezone: string,
  lang: string,
): { system: string; user: string } {
  return {
    system: `${BASE}\nYou turn a short description of an appointment into calendar data.\n\n${draftRules(nowIso, timezone, lang, false)}`,
    user: `Appointment: ${clip(text.trim())}`,
  }
}

/** ask the model for the appointment an email arranges, as event JSON */
export function mailEventPrompt(
  mail: MailContext,
  nowIso: string,
  timezone: string,
  lang: string,
): { system: string; user: string } {
  return {
    system: `${BASE}\nYou read an email and extract the appointment it arranges or announces as calendar data. The email may be older than today: relative dates in it count from the date it was sent.\n\n${draftRules(nowIso, timezone, lang, true)}`,
    user:
      `Sent: ${mail.date}\nFrom: ${mail.from}\nTo: ${mail.to}\nSubject: ${mail.subject}\n\n${clip(mail.body)}` +
      `\n\nAnswer with the JSON object only.`,
  }
}

function cleanSubject(subject: string): string {
  return subject
    .replace(/^\s*((re|aw|antw|fwd?|wg|tr|sv|vs)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .trim()
    .slice(0, 200)
}

/**
 * "Create event" in the mail AI panel: ask the model for the email's
 * appointment and parse it. Null when the email holds none. Throws
 * AiUnconfiguredError (from ../ai) when no model is set up.
 */
export async function draftEventFromMail(
  mail: MailContext,
  lang: string,
): Promise<Partial<EventInput> | null> {
  const nowIso = new Date().toISOString()
  const zone = systemZone()
  const p = mailEventPrompt(mail, nowIso, zone, lang)
  let answer = await runAi(p.system, p.user, () => undefined).done
  // a model that answered in prose without any JSON gets one more, sterner try
  if (!answer.includes('{')) {
    answer = await runAi(
      p.system,
      `${p.user}\nReply with a single JSON object as described, nothing else.`,
      () => undefined,
    ).done
  }
  const draft = parseEventDraft(answer, nowIso, zone)
  if (!draft) return null
  if (!draft.title) draft.title = cleanSubject(mail.subject)
  return draft
}

// ---- free time ----

/**
 * Free slots of `durationMin` minutes in [fromIso, toIso), deterministic and
 * without AI. Days and hours are the computer's local ones: only `weekdays`
 * (Date#getDay numbering, 0 = Sunday; default Monday–Friday), between
 * `dayStart` and `dayEnd` (hours, fractions allowed; default 8–18). Slot starts
 * sit on a `stepMin` grid (default 30) counted from dayStart and do not overlap
 * each other: after a free slot the next candidate starts where it ends.
 *
 * Busy time is every timed event that is not cancelled (tentative ones count as
 * busy); overlapping and touching events are merged first. All-day events do
 * NOT block time — like Outlook and Google, which show them as "free" by
 * default, since most are birthdays, holidays of other regions or reminders.
 * Callers that care (the panel) show them next to each day instead.
 */
export function findFreeSlots(
  events: CalendarEvent[],
  fromIso: string,
  toIso: string,
  durationMin: number,
  opts: { dayStart?: number; dayEnd?: number; weekdays?: number[]; stepMin?: number } = {},
): Array<{ start: string; end: string }> {
  const from = Date.parse(fromIso)
  const to = Date.parse(toIso)
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return []
  if (!Number.isFinite(durationMin) || durationMin <= 0) return []
  const clampHour = (h: number | undefined, fallback: number): number =>
    typeof h === 'number' && Number.isFinite(h) ? Math.min(Math.max(h, 0), 24) : fallback
  const dayStart = clampHour(opts.dayStart, 8)
  const dayEnd = clampHour(opts.dayEnd, 18)
  if (dayEnd <= dayStart) return []
  const weekdays = new Set(opts.weekdays ?? [1, 2, 3, 4, 5])
  const step =
    Math.max(5, Math.round(opts.stepMin && opts.stepMin > 0 ? opts.stepMin : 30)) * 60_000
  const length = Math.round(durationMin * 60_000)

  const busy: Array<[number, number]> = []
  for (const e of events) {
    if (!e || e.allDay || e.status === 'cancelled') continue
    const s = Date.parse(e.start)
    const t = Date.parse(e.end)
    if (Number.isFinite(s) && Number.isFinite(t) && t > s && t > from && s < to) busy.push([s, t])
  }
  busy.sort((a, b) => a[0] - b[0])
  const merged: Array<[number, number]> = []
  for (const b of busy) {
    const last = merged[merged.length - 1]
    if (last && b[0] <= last[1]) last[1] = Math.max(last[1], b[1])
    else merged.push([b[0], b[1]])
  }

  const at = (day: Date, hours: number): number => {
    const whole = Math.floor(hours)
    return new Date(
      day.getFullYear(),
      day.getMonth(),
      day.getDate(),
      whole,
      Math.round((hours - whole) * 60),
    ).getTime()
  }
  const slots: Array<{ start: string; end: string }> = []
  const first = new Date(from)
  let day = new Date(first.getFullYear(), first.getMonth(), first.getDate())
  let cursor = 0
  for (let n = 0; n < 400 && day.getTime() < to && slots.length < 1000; n++) {
    if (weekdays.has(day.getDay())) {
      const windowStart = at(day, dayStart)
      const limit = Math.min(at(day, dayEnd), to)
      const onGrid = (t: number): number =>
        t <= windowStart ? windowStart : windowStart + Math.ceil((t - windowStart) / step) * step
      let t = onGrid(from)
      while (t + length <= limit) {
        while (cursor < merged.length && merged[cursor]![1] <= t) cursor++
        const block = merged[cursor]
        if (block && block[0] < t + length) {
          t = onGrid(block[1])
          continue
        }
        slots.push({ start: new Date(t).toISOString(), end: new Date(t + length).toISOString() })
        t = onGrid(t + length)
      }
    }
    day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1)
  }
  return slots
}

// ---- agenda and meeting preparation ----

function isDateOnly(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
}

/** local start of an occurrence, for sorting: all-day dates count from local midnight */
function startMs(e: CalendarEvent): number {
  if (isDateOnly(e.start)) {
    const [y, m, d] = e.start.split('-').map(Number)
    return new Date(y!, m! - 1, d!).getTime()
  }
  const t = Date.parse(e.start)
  return Number.isFinite(t) ? t : 0
}

/** "Mon 2026-10-05" in the computer's zone — unambiguous for the model */
function dayLabel(date: Date): string {
  return `${WEEKDAYS_EN[date.getDay()]!.slice(0, 3)} ${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function clockLabel(date: Date): string {
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function whenLabel(e: CalendarEvent): string {
  if (e.allDay || isDateOnly(e.start)) {
    const first = new Date(startMs(e))
    const endDay = isDateOnly(e.end) ? e.end.split('-').map(Number) : null
    const last = endDay ? new Date(endDay[0]!, endDay[1]! - 1, endDay[2]! - 1) : first
    return last.getTime() > first.getTime()
      ? `${dayLabel(first)} – ${dayLabel(last)}, all day`
      : `${dayLabel(first)}, all day`
  }
  const s = new Date(e.start)
  const t = new Date(e.end)
  if (!Number.isFinite(s.getTime())) return e.start
  if (!Number.isFinite(t.getTime())) return `${dayLabel(s)} ${clockLabel(s)}`
  const sameDay = dayLabel(s) === dayLabel(t) || t.getTime() - s.getTime() <= 0
  return sameDay
    ? `${dayLabel(s)} ${clockLabel(s)}–${clockLabel(t)}`
    : `${dayLabel(s)} ${clockLabel(s)} – ${dayLabel(t)} ${clockLabel(t)}`
}

/** occurrences arrive over IPC from sources of every quality: never trust a field's type */
const field = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const titleOf = (e: CalendarEvent): string => field(e.title) || '(untitled)'
const attendeesOf = (e: CalendarEvent): Attendee[] =>
  Array.isArray(e.attendees) ? e.attendees : []

function person(p: { name?: string; email: string }): string {
  return p.name ? `${p.name} <${p.email}>` : p.email
}

function eventLine(e: CalendarEvent): string {
  const bits = [`${whenLabel(e)}: ${titleOf(e)}`]
  if (field(e.location)) bits.push(`at ${field(e.location)}`)
  if (e.status === 'cancelled') bits.push('[CANCELLED]')
  else if (e.status === 'tentative') bits.push('[tentative]')
  if (attendeesOf(e).length) bits.push(`with ${attendeesOf(e).length} attendee(s)`)
  if (e.recurring) bits.push('(recurring)')
  return `- ${bits.join(' ')}`
}

function nowLine(): string {
  const now = new Date()
  return `Now: ${dayLabel(now)} ${clockLabel(now)} (time zone ${systemZone()}).`
}

const MAX_AGENDA_EVENTS = 150

/** summarize the occurrences of a period; overlaps are computed here, not left to the model */
export function agendaPrompt(
  events: CalendarEvent[],
  range: { from: string; to: string },
  lang: string,
): { system: string; user: string } {
  const language = languageName(lang)
  const sorted = (Array.isArray(events) ? events : [])
    .filter((e) => e && typeof e.start === 'string')
    .sort((a, b) => startMs(a) - startMs(b))
  const shown = sorted.slice(0, MAX_AGENDA_EVENTS)
  const timed = shown.filter((e) => !e.allDay && e.status !== 'cancelled' && !isDateOnly(e.start))
  const overlaps: string[] = []
  for (let i = 0; i < timed.length && overlaps.length < 10; i++) {
    for (let j = i + 1; j < timed.length && overlaps.length < 10; j++) {
      const a = timed[i]!
      const b = timed[j]!
      if (Date.parse(b.start) >= Date.parse(a.end)) break
      overlaps.push(`- "${titleOf(a)}" and "${titleOf(b)}" (${whenLabel(b)})`)
    }
  }
  const from = new Date(range.from)
  const last = new Date(Date.parse(range.to) - 1)
  const period =
    Number.isFinite(from.getTime()) && Number.isFinite(last.getTime())
      ? dayLabel(from) === dayLabel(last)
        ? dayLabel(from)
        : `${dayLabel(from)} – ${dayLabel(last)}`
      : 'the visible period'
  return {
    system:
      `${BASE}\nWrite plain text only: no Markdown headings, no bold markers, no tables.\n` +
      `Summarize the user's schedule in ${language}. Start with one sentence on how busy the period is. ` +
      `Then one line per day that has appointments, starting with the day, followed by the times and titles in order; start each of these lines with "• ". ` +
      `Point out overlapping appointments and cancelled ones. Mention only appointments from the list and never invent any. ` +
      `If the list is empty, say that the period is free.`,
    user:
      `${nowLine()}\nPeriod: ${period}\n\nAppointments:\n` +
      (shown.length ? shown.map(eventLine).join('\n') : '(none)') +
      (sorted.length > shown.length ? `\n(and ${sorted.length - shown.length} more)` : '') +
      (overlaps.length ? `\n\nOverlapping appointments:\n${overlaps.join('\n')}` : ''),
  }
}

const STATUS_WORDS: Record<Attendee['status'], string> = {
  accepted: 'accepted',
  declined: 'declined',
  tentative: 'tentative',
  'needs-action': 'no answer yet',
}

/** an agenda and preparation notes for one meeting */
export function meetingPrepPrompt(
  event: CalendarEvent,
  lang: string,
): { system: string; user: string } {
  const language = languageName(lang)
  const lines = [`Title: ${titleOf(event)}`, `When: ${whenLabel(event)}`]
  if (field(event.location)) lines.push(`Where: ${field(event.location)}`)
  if (event.recurring) lines.push(`Repeats: ${event.rrule ?? 'yes'}`)
  if (event.status !== 'confirmed') lines.push(`Status: ${event.status}`)
  if (event.organizer) lines.push(`Organizer: ${person(event.organizer)}`)
  const attendees = attendeesOf(event)
  if (attendees.length) {
    const list = attendees
      .slice(0, 40)
      .map(
        (a) =>
          `- ${person(a)} (${STATUS_WORDS[a.status] ?? a.status}${a.optional ? ', optional' : ''})`,
      )
    if (attendees.length > 40) list.push(`- and ${attendees.length - 40} more`)
    lines.push(`Attendees:\n${list.join('\n')}`)
  }
  if (event.url) lines.push(`Link: ${event.url}`)
  if (field(event.description)) lines.push(`Description:\n${clip(field(event.description))}`)
  return {
    system:
      `${BASE}\nWrite plain text only: no Markdown headings, no bold markers, no tables.\n` +
      `Help the user prepare for a meeting, in ${language}. Write three short sections, each introduced by its own line ending with a colon: ` +
      `a suggested agenda (3–6 points), what to prepare or bring, and open questions worth clarifying. Start every point with "• ". ` +
      `Build on the meeting details; where they say little, give sensible general suggestions and call them suggestions. ` +
      `Never invent facts, names, numbers or decisions.`,
    user: `${nowLine()}\n\nMeeting:\n${lines.join('\n')}`,
  }
}
