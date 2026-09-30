import { prop, props, serializeComponent, serializeLine, type Component } from './contentline'
import { resolveTimezone, wallTimeIn } from './timezone'

/**
 * VTIMEZONE blocks without a zone database of our own. Writing: the platform's
 * Intl data tells us a zone's UTC offset at any instant, so scanning one year
 * finds its DST transitions, and the transition dates give the yearly rule
 * (last Sunday of March …) that calendar programs expect. Reading: a TZID that
 * names no zone we know (Outlook's "Customized Time Zone", localized Windows
 * names) is identified by comparing its rules against every IANA zone.
 */

const DAY_MS = 86_400_000
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

/** UTC offset of `zone` at instant `ms`, in seconds */
function offsetSeconds(ms: number, zone: string): number {
  const t = Math.floor(ms / 1000) * 1000
  const w = wallTimeIn(new Date(t), zone)
  return Math.round((Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - t) / 1000)
}

export interface ZoneTransition {
  /** the first instant (ms) with the new offset */
  at: number
  /** offsets in seconds east of UTC */
  from: number
  to: number
}

const transitionCache = new Map<string, ZoneTransition[]>()

/** the offset changes of `zone` during `year` (UTC calendar year) */
export function zoneTransitions(zone: string, year: number): ZoneTransition[] {
  const key = `${zone}\n${year}`
  const cached = transitionCache.get(key)
  if (cached) return cached
  const start = Date.UTC(year, 0, 1)
  const end = Date.UTC(year + 1, 0, 1)
  const out: ZoneTransition[] = []
  let prevAt = start
  let prev = offsetSeconds(start, zone)
  // no zone changes its offset twice within a day, so daily samples find
  // every transition; bisection then pins it to the second
  for (let t = start + DAY_MS; t <= end; t += DAY_MS) {
    const off = offsetSeconds(t, zone)
    if (off !== prev) {
      let lo = prevAt
      let hi = t
      while (hi - lo > 1000) {
        const mid = lo + Math.floor((hi - lo) / 2000) * 1000
        if (offsetSeconds(mid, zone) === prev) lo = mid
        else hi = mid
      }
      out.push({ at: hi, from: prev, to: off })
    }
    prevAt = t
    prev = off
  }
  transitionCache.set(key, out)
  return out
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

function formatOffset(seconds: number): string {
  const sign = seconds < 0 ? '-' : '+'
  const abs = Math.abs(seconds)
  const h = Math.floor(abs / 3600)
  const m = Math.floor((abs % 3600) / 60)
  const s = abs % 60
  return `${sign}${pad(h)}${pad(m)}${s ? pad(s) : ''}`
}

function parseOffset(value: string | undefined): number | null {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(value?.trim() ?? '')
  if (!m) return null
  const secs = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4] ?? 0)
  return m[1] === '-' ? -secs : secs
}

/** "CET", "EDT", "AEST" … — the first locale that knows a letter abbreviation wins */
function abbreviation(zone: string, at: number, offset: number): string {
  for (const locale of ['en-US', 'en-GB', 'en-AU', 'en-IN', 'ja-JP']) {
    try {
      const name = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: 'short' })
        .formatToParts(new Date(at))
        .find((p) => p.type === 'timeZoneName')?.value
      if (name && /^[A-Z]{2,6}$/.test(name)) return name
    } catch {
      break
    }
  }
  return formatOffset(offset)
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

/** day of month of the n-th (1…5, or -1 = last) weekday `wd` (0 = Sunday) */
function nthWeekday(year: number, month: number, n: number, wd: number): number | null {
  const last = daysInMonth(year, month)
  if (n < 0) {
    const lastWd = new Date(Date.UTC(year, month - 1, last)).getUTCDay()
    return last - ((lastWd - wd + 7) % 7) + (n + 1) * 7
  }
  const firstWd = new Date(Date.UTC(year, month - 1, 1)).getUTCDay()
  const day = 1 + ((wd - firstWd + 7) % 7) + (n - 1) * 7
  return day <= last ? day : null
}

interface Onset {
  year: number
  month: number
  day: number
  weekday: number
  hour: number
  minute: number
  second: number
}

/** the wall-clock moment a transition happens, read on the clock that is about to change */
function onsetOf(tr: ZoneTransition): Onset {
  const d = new Date(tr.at + tr.from * 1000)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    weekday: d.getUTCDay(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
  }
}

type YearlyRule =
  { month: number; n: number; weekday: number } | { month: number; monthday: number }

function ruleDay(rule: YearlyRule, year: number): number | null {
  if ('monthday' in rule)
    return rule.monthday <= daysInMonth(year, rule.month) ? rule.monthday : null
  return nthWeekday(year, rule.month, rule.n, rule.weekday)
}

/** the matching transition (same direction) in another year */
function counterpart(zone: string, year: number, tr: ZoneTransition): Onset | null {
  const other = zoneTransitions(zone, year).find(
    (t) => Math.sign(t.to - t.from) === Math.sign(tr.to - tr.from) && t.to === tr.to,
  )
  return other ? onsetOf(other) : null
}

/**
 * The yearly rule behind a transition: "n-th weekday" or "last weekday" of its
 * month, checked against the neighbouring years (a day 22–28 could be either
 * the 4th or the last Sunday); a fixed date as the last resort.
 */
function inferRule(zone: string, year: number, tr: ZoneTransition): YearlyRule | null {
  const o = onsetOf(tr)
  const candidates: YearlyRule[] = []
  if (o.day + 7 > daysInMonth(o.year, o.month))
    candidates.push({ month: o.month, n: -1, weekday: o.weekday })
  candidates.push({ month: o.month, n: Math.ceil(o.day / 7), weekday: o.weekday })
  candidates.push({ month: o.month, monthday: o.day })
  const checks = [year - 1, year + 1]
    .map((y) => counterpart(zone, y, tr))
    .filter((x): x is Onset => x !== null)
  for (const rule of candidates) {
    const fits = checks.every(
      (c) => c.month === rule.month && ruleDay(rule, c.year) === c.day && c.hour === o.hour,
    )
    if (fits) return rule
  }
  return null
}

function wallValue(year: number, month: number, day: number, o: Onset): string {
  return `${pad(year, 4)}${pad(month)}${pad(day)}T${pad(o.hour)}${pad(o.minute)}${pad(o.second)}`
}

function observance(
  kind: 'STANDARD' | 'DAYLIGHT',
  dtstart: string,
  from: number,
  to: number,
  name: string,
  rrule?: string,
): string {
  return serializeComponent(kind, [
    `DTSTART:${dtstart}`,
    ...(rrule ? [`RRULE:${rrule}`] : []),
    `TZOFFSETFROM:${formatOffset(from)}`,
    `TZOFFSETTO:${formatOffset(to)}`,
    serializeLine('TZNAME', name),
  ])
}

const vtimezoneCache = new Map<string, string>()

/**
 * A VTIMEZONE for an IANA zone with the rules in force in `year`: STANDARD
 * (and DAYLIGHT for zones with DST) starting 1970 with a yearly RRULE, so the
 * block also covers the neighbouring years. `tzid` names the block when an
 * object refers to the zone by another name (a Windows name, say).
 */
export function buildVtimezone(zone: string, year: number, tzid: string = zone): string {
  const key = `${zone}\n${year}\n${tzid}`
  const cached = vtimezoneCache.get(key)
  if (cached) return cached
  const head = [serializeLine('TZID', tzid)]
  if (zone !== tzid || zone.includes('/')) head.push(serializeLine('X-LIC-LOCATION', zone))
  const trs = zoneTransitions(zone, year)
  const blocks: string[] = []
  const isDst =
    trs.length === 2 &&
    Math.sign(trs[0]!.to - trs[0]!.from) !== Math.sign(trs[1]!.to - trs[1]!.from)
  const rules = isDst ? trs.map((tr) => inferRule(zone, year, tr)) : []

  if (trs.length === 0) {
    const at = Date.UTC(year, 0, 1)
    const off = offsetSeconds(at, zone)
    blocks.push(observance('STANDARD', '19700101T000000', off, off, abbreviation(zone, at, off)))
  } else if (isDst && rules.every((r) => r !== null)) {
    trs.forEach((tr, i) => {
      const rule = rules[i]!
      const o = onsetOf(tr)
      const day1970 = ruleDay(rule, 1970) ?? o.day
      const byday =
        'monthday' in rule
          ? `BYMONTHDAY=${rule.monthday}`
          : `BYDAY=${rule.n}${WEEKDAYS[rule.weekday]}`
      blocks.push(
        observance(
          tr.to > tr.from ? 'DAYLIGHT' : 'STANDARD',
          wallValue(1970, o.month, day1970, o),
          tr.from,
          tr.to,
          abbreviation(zone, tr.at + 1000, tr.to),
          `FREQ=YEARLY;BYMONTH=${rule.month};${byday}`,
        ),
      )
    })
  } else {
    // irregular zones (rules without a weekday pattern, a permanent change of
    // the standard offset): list the actual transitions around the year
    const all = [year - 1, year, year + 1].flatMap((y) => zoneTransitions(zone, y))
    const first = all[0]!
    const base = first ? first.from : offsetSeconds(Date.UTC(year, 0, 1), zone)
    blocks.push(
      observance(
        'STANDARD',
        '19700101T000000',
        base,
        base,
        abbreviation(zone, Date.UTC(year - 1, 0, 1), base),
      ),
    )
    const lone = all.length === 1
    for (const tr of all) {
      const o = onsetOf(tr)
      blocks.push(
        observance(
          !lone && tr.to > tr.from ? 'DAYLIGHT' : 'STANDARD',
          wallValue(o.year, o.month, o.day, o),
          tr.from,
          tr.to,
          abbreviation(zone, tr.at + 1000, tr.to),
        ),
      )
    }
  }
  const text = serializeComponent('VTIMEZONE', head, blocks)
  vtimezoneCache.set(key, text)
  return text
}

// ---- reading foreign VTIMEZONEs ----

interface Observance {
  from: number
  to: number
  /** DTSTART as a floating wall time (ms) */
  start: number
  rrule?: string
  rdates: number[]
}

function wallMsOf(value: string | undefined): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?/.exec(value?.trim() ?? '')
  if (!m) return null
  return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0))
}

function observancesOf(comp: Component): Observance[] {
  const out: Observance[] = []
  for (const child of comp.children) {
    if (child.name !== 'STANDARD' && child.name !== 'DAYLIGHT') continue
    const to = parseOffset(prop(child, 'TZOFFSETTO')?.value)
    const from = parseOffset(prop(child, 'TZOFFSETFROM')?.value) ?? to
    const start = wallMsOf(prop(child, 'DTSTART')?.value)
    if (to === null || from === null || start === null) continue
    const rdates = props(child, 'RDATE')
      .flatMap((p) => p.value.split(','))
      .map((v) => wallMsOf(v))
      .filter((v): v is number => v !== null)
    out.push({ from, to, start, rrule: prop(child, 'RRULE')?.value, rdates })
  }
  return out
}

/**
 * Onsets (floating wall ms) of a yearly observance rule in `year`. VTIMEZONE
 * rules in the wild are all of the form FREQ=YEARLY;BYMONTH=m;BYDAY=nWD (or
 * BYMONTHDAY), including the old "BYDAY=SU;BYMONTHDAY=8,9,…,14" spelling.
 */
function ruleOnset(obs: Observance, year: number): number | null {
  const parts: Record<string, string> = {}
  for (const part of (obs.rrule ?? '').toUpperCase().split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) parts[part.slice(0, eq).trim()] = part.slice(eq + 1).trim()
  }
  if (parts.FREQ !== 'YEARLY') return null
  const start = new Date(obs.start)
  if (year < start.getUTCFullYear()) return null
  const month = Number(parts.BYMONTH ?? start.getUTCMonth() + 1)
  if (!(month >= 1 && month <= 12)) return null
  const monthdays = (parts.BYMONTHDAY ?? '')
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n !== 0)
  let day: number | null = null
  const byday = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec((parts.BYDAY ?? '').split(',')[0] ?? '')
  if (byday) {
    const wd = WEEKDAYS.indexOf(byday[2] as (typeof WEEKDAYS)[number])
    if (byday[1]) day = nthWeekday(year, month, Number(byday[1]), wd)
    else {
      const last = daysInMonth(year, month)
      day =
        monthdays
          .map((d) => (d < 0 ? last + d + 1 : d))
          .find(
            (d) => d >= 1 && d <= last && new Date(Date.UTC(year, month - 1, d)).getUTCDay() === wd,
          ) ?? null
    }
  } else if (monthdays.length === 1) {
    day = monthdays[0]! > 0 ? monthdays[0]! : daysInMonth(year, month) + monthdays[0]! + 1
  }
  if (day === null) return null
  const onset = Date.UTC(
    year,
    month - 1,
    day,
    start.getUTCHours(),
    start.getUTCMinutes(),
    start.getUTCSeconds(),
  )
  const until = /^(\d{8}T\d{6})Z?$/.exec(parts.UNTIL ?? '')?.[1]
  if (until) {
    const u = wallMsOf(until)
    // UNTIL is UTC; the onset is on the clock before the change
    if (u !== null && onset - obs.from * 1000 > u) return null
  }
  return onset
}

/** every onset of the VTIMEZONE's observances between two years, as instants */
function onsetsBetween(obs: Observance[], fromYear: number, toYear: number) {
  const out: Array<{ at: number; to: number; from: number }> = []
  for (const o of obs) {
    const walls = new Set<number>([o.start, ...o.rdates])
    if (o.rrule) {
      for (let y = fromYear; y <= toYear; y++) {
        const w = ruleOnset(o, y)
        if (w !== null) walls.add(w)
      }
    }
    for (const w of walls) out.push({ at: w - o.from * 1000, to: o.to, from: o.from })
  }
  return out.sort((a, b) => a.at - b.at)
}

const PREFERRED_ZONES = [
  'Europe/Berlin',
  'Europe/London',
  'Europe/Paris',
  'Europe/Zurich',
  'Europe/Vienna',
  'Europe/Amsterdam',
  'Europe/Helsinki',
  'Europe/Moscow',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Sao_Paulo',
  'Asia/Tokyo',
  'Asia/Shanghai',
  'Asia/Kolkata',
  'Asia/Dubai',
  'Asia/Singapore',
  'Australia/Sydney',
  'Pacific/Auckland',
  'UTC',
]

let allZones: string[] | null = null

function candidateZones(tzid: string): string[] {
  allZones ??= (() => {
    try {
      return Intl.supportedValuesOf('timeZone')
    } catch {
      return []
    }
  })()
  // Outlook's localized names list cities: "(UTC+01:00) Amsterdam, Berlin, Bern …"
  const text = tzid.toLowerCase()
  const hinted = allZones.filter((z) => {
    const city = z.split('/').pop()!.replace(/_/g, ' ').toLowerCase()
    return city.length > 3 && text.includes(city)
  })
  return [...new Set([...hinted, ...PREFERRED_ZONES, ...allZones])]
}

const matchCache = new Map<string, string | null>()

/**
 * The IANA zone a VTIMEZONE describes: its X-LIC-LOCATION or TZID when those
 * name one, else the first zone whose offsets agree with the block's rules
 * all through `year` (monthly probes plus both sides of every transition).
 * Null when nothing matches — the times are then floating.
 */
export function ianaForVtimezone(
  comp: Component,
  year: number = new Date().getUTCFullYear(),
): string | null {
  const location = resolveTimezone(prop(comp, 'X-LIC-LOCATION')?.value)
  if (location) return location
  const tzid = prop(comp, 'TZID')?.value.trim() ?? ''
  const named = resolveTimezone(tzid)
  if (named) return named

  const obs = observancesOf(comp)
  if (obs.length === 0) return null
  const key = `${year}\n${JSON.stringify(obs)}\n${tzid}`
  const cached = matchCache.get(key)
  if (cached !== undefined) return cached

  const onsets = onsetsBetween(obs, year - 2, year + 1)
  const expected = (t: number): number => {
    let offset = onsets[0]!.from
    for (const o of onsets) {
      if (o.at <= t) offset = o.to
      else break
    }
    return offset
  }
  const probes: number[] = []
  for (let m = 0; m < 12; m++) probes.push(Date.UTC(year, m, 15, 12))
  for (const o of onsets) {
    if (new Date(o.at).getUTCFullYear() !== year) continue
    probes.push(o.at - 2 * 3600_000, o.at + 2 * 3600_000)
  }
  const wanted = probes.map((t) => ({ t, offset: expected(t) }))

  let found: string | null = null
  for (const zone of candidateZones(tzid)) {
    try {
      if (wanted.every((p) => offsetSeconds(p.t, zone) === p.offset)) {
        found = zone
        break
      }
    } catch {
      // a zone name this ICU build rejects
    }
  }
  matchCache.set(key, found)
  return found
}
