/**
 * Date math and formatting for the calendar views. Everything here works on
 * the viewer's local wall clock: days are built from year/month/day
 * components (never by adding 24 h), so a 23- or 25-hour DST day is still one
 * day. Formatting goes through Intl with the UI language.
 */

export type CalendarView = 'day' | 'workweek' | 'week' | 'month' | 'agenda'

export const CALENDAR_VIEWS: CalendarView[] = ['day', 'workweek', 'week', 'month', 'agenda']

/** how far the agenda looks ahead */
export const AGENDA_DAYS = 60

const DAY_MS = 86_400_000

// ---- week start ----

/** regions whose week starts on Sunday / Saturday (CLDR); everything else starts on Monday */
const SUNDAY_REGIONS = new Set([
  'US',
  'CA',
  'MX',
  'BR',
  'JP',
  'KR',
  'IL',
  'IN',
  'PH',
  'TW',
  'HK',
  'ZA',
  'SG',
  'TH',
  'PE',
  'CO',
  'VE',
  'GT',
  'DO',
  'PR',
  'SA',
  'ID',
])
const SATURDAY_REGIONS = new Set(['AE', 'EG', 'IQ', 'IR', 'JO', 'KW', 'LY', 'OM', 'QA', 'SY', 'DZ'])
/** a bare language tag stands for its main region: "en" is en-US, "pt" is pt-BR */
const SUNDAY_LANGUAGES = new Set(['en', 'pt', 'ja', 'ko', 'he', 'hi', 'th', 'id'])
const SATURDAY_LANGUAGES = new Set(['ar', 'fa'])

/** 0 = Sunday, 1 = Monday, 6 = Saturday */
export function weekStartsOn(lang: string): number {
  const [language = '', region = ''] = lang.replace('_', '-').split('-')
  const r = region.toUpperCase()
  if (r.length === 2) {
    if (SUNDAY_REGIONS.has(r)) return 0
    if (SATURDAY_REGIONS.has(r)) return 6
    return 1
  }
  const l = language.toLowerCase()
  if (SUNDAY_LANGUAGES.has(l)) return 0
  if (SATURDAY_LANGUAGES.has(l)) return 6
  return 1
}

// ---- local-day math ----

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** the same wall-clock time n calendar days later */
export function addDays(d: Date, n: number): Date {
  return new Date(
    d.getFullYear(),
    d.getMonth(),
    d.getDate() + n,
    d.getHours(),
    d.getMinutes(),
    d.getSeconds(),
    d.getMilliseconds(),
  )
}

/** n months later, clamped to the last day of a shorter month (31 Jan + 1 → 28/29 Feb) */
export function addMonths(d: Date, n: number): Date {
  const first = new Date(d.getFullYear(), d.getMonth() + n, 1)
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate()
  return new Date(
    first.getFullYear(),
    first.getMonth(),
    Math.min(d.getDate(), last),
    d.getHours(),
    d.getMinutes(),
  )
}

export function startOfMonth(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1)
}

export function startOfWeek(d: Date, weekStart: number): Date {
  const back = (d.getDay() - weekStart + 7) % 7
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - back)
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** whole calendar days from a to b (negative when b is earlier) */
export function daysBetween(a: Date, b: Date): number {
  // the two midnights differ by a multiple of 24 h ± the DST shift, so rounding is exact
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / DAY_MS)
}

/** minutes since local midnight, measured on the wall clock */
export function minutesOfDay(d: Date): number {
  return d.getHours() * 60 + d.getMinutes() + d.getSeconds() / 60
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0')

/** "2026-09-30", local */
export function dayKey(d: Date): string {
  return `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** "09:30", local, for <input type="time"> */
export function timeKey(d: Date): string {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

const DAY_KEY = /^(\d{4})-(\d{2})-(\d{2})$/

/** local midnight of "YYYY-MM-DD"; Invalid Date for anything else */
export function parseDayKey(key: string): Date {
  const m = DAY_KEY.exec(key.trim())
  if (!m) return new Date(NaN)
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  // reject 2026-02-31 instead of rolling it into March
  return d.getDate() === Number(m[3]) ? d : new Date(NaN)
}

/** a date field plus a time field as a local instant (a skipped DST hour moves forward) */
export function combineLocal(date: string, time: string): Date {
  const day = parseDayKey(date)
  const m = /^(\d{1,2}):(\d{2})/.exec(time.trim())
  if (Number.isNaN(day.getTime()) || !m) return new Date(NaN)
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), Number(m[1]), Number(m[2]))
}

export function isValidDate(d: Date): boolean {
  return !Number.isNaN(d.getTime())
}

// ---- IPC representation ----

/** what EventInput.start/end expect: a date for all-day events, an instant otherwise */
export function toIso(d: Date, allDay: boolean): string {
  return allDay ? dayKey(d) : d.toISOString()
}

/** the inverse of toIso: dates become local midnight, instants stay instants */
export function fromIso(value: string | undefined | null): Date {
  if (!value) return new Date(NaN)
  if (DAY_KEY.test(value.trim())) return parseDayKey(value)
  return new Date(value)
}

export interface EventSpan {
  start: Date
  /** exclusive; never before start */
  end: Date
  allDay: boolean
}

/**
 * Where an event sits on the local timeline. Robust against what real
 * servers send: a missing or inverted end becomes a zero-length timed event
 * or a one-day all-day event.
 */
export function eventSpan(ev: { start: string; end: string; allDay: boolean }): EventSpan {
  const start = fromIso(ev.start)
  let end = fromIso(ev.end)
  if (ev.allDay) {
    const s = startOfDay(start)
    const e = isValidDate(end) ? startOfDay(end) : s
    return { start: s, end: e > s ? e : addDays(s, 1), allDay: true }
  }
  if (!isValidDate(end) || end < start) end = start
  return { start, end, allDay: false }
}

/** does [start, end) touch the local day? zero-length events count on the day they sit on */
export function overlapsDay(span: EventSpan, day: Date): boolean {
  const from = startOfDay(day)
  const to = addDays(from, 1)
  if (span.start.getTime() === span.end.getTime()) return span.start >= from && span.start < to
  return span.start < to && span.end > from
}

export interface DayCells {
  /** first covered cell, clamped to the row */
  start: number
  /** cell after the last covered one, clamped */
  end: number
  /** the event goes on before / after the cells shown */
  clippedStart: boolean
  clippedEnd: boolean
}

/** which of `count` day cells starting at `first` an event covers; null when none */
export function dayCells(span: EventSpan, first: Date, count: number): DayCells | null {
  const s = daysBetween(first, span.start)
  const endsAtMidnight =
    span.end > span.start && span.end.getTime() === startOfDay(span.end).getTime()
  const e = daysBetween(first, span.end) + (endsAtMidnight ? 0 : 1)
  if (e <= 0 || s >= count) return null
  return {
    start: Math.max(0, s),
    end: Math.min(count, e),
    clippedStart: s < 0,
    clippedEnd: e > count,
  }
}

/** timed events of a day or more are drawn with the all-day ones, like Outlook does */
export function isLongEvent(span: EventSpan): boolean {
  return span.allDay || span.end.getTime() - span.start.getTime() >= DAY_MS
}

// ---- view ranges ----

export interface ViewRange {
  /** local midnight of the first day shown */
  start: Date
  /** local midnight after the last day shown (exclusive) */
  end: Date
  days: Date[]
}

function daysFrom(start: Date, count: number): Date[] {
  return Array.from({ length: count }, (_, i) => addDays(start, i))
}

export function viewRange(view: CalendarView, anchor: Date, weekStart: number): ViewRange {
  const day = startOfDay(anchor)
  let start: Date
  let count: number
  switch (view) {
    case 'day':
      start = day
      count = 1
      break
    case 'workweek': {
      // Monday to Friday of the week the anchor is in, whatever day the locale starts on
      const week = startOfWeek(day, weekStart)
      start = addDays(week, (1 - weekStart + 7) % 7)
      count = 5
      break
    }
    case 'week':
      start = startOfWeek(day, weekStart)
      count = 7
      break
    case 'month': {
      const first = startOfMonth(day)
      start = startOfWeek(first, weekStart)
      const last = new Date(first.getFullYear(), first.getMonth() + 1, 0)
      count = (Math.floor(daysBetween(start, last) / 7) + 1) * 7
      break
    }
    case 'agenda':
      start = day
      count = AGENDA_DAYS
      break
  }
  const days = daysFrom(start, count)
  return { start, end: addDays(start, count), days }
}

/** six full weeks around a month, for the sidebar's mini calendar */
export function monthGrid(month: Date, weekStart: number): Date[] {
  return daysFrom(startOfWeek(startOfMonth(month), weekStart), 42)
}

/** the anchor one period earlier or later */
export function shiftAnchor(view: CalendarView, anchor: Date, dir: 1 | -1): Date {
  switch (view) {
    case 'day':
      return addDays(anchor, dir)
    case 'workweek':
    case 'week':
      return addDays(anchor, 7 * dir)
    case 'month':
      return addMonths(startOfMonth(anchor), dir)
    case 'agenda':
      return addDays(anchor, AGENDA_DAYS * dir)
  }
}

// ---- formatting ----

const formatters = new Map<string, Intl.DateTimeFormat>()

function dtf(lang: string, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${lang}\n${JSON.stringify(options)}`
  let f = formatters.get(key)
  if (!f) {
    try {
      f = new Intl.DateTimeFormat(lang, options)
    } catch {
      // an unknown language tag must not take the calendar down
      f = new Intl.DateTimeFormat('en', options)
    }
    formatters.set(key, f)
  }
  return f
}

function formatRange(f: Intl.DateTimeFormat, a: Date, b: Date): string {
  try {
    if (typeof f.formatRange === 'function') return f.formatRange(a, b)
  } catch {
    // older engines throw for some option sets
  }
  return `${f.format(a)} – ${f.format(b)}`
}

/** 24-hour locales get "09:00" like Outlook; 12-hour ones "9:00 AM" */
function uses24h(lang: string): boolean {
  const cycle = dtf(lang, { hour: 'numeric' }).resolvedOptions().hourCycle
  return cycle === 'h23' || cycle === 'h24'
}

function timeOptions(lang: string): Intl.DateTimeFormatOptions {
  return uses24h(lang)
    ? { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
    : { hour: 'numeric', minute: '2-digit' }
}

export function formatTime(d: Date, lang: string): string {
  return dtf(lang, timeOptions(lang)).format(d)
}

/** the label next to an hour row: "09:00" or "9 AM" */
export function formatHour(hour: number, lang: string): string {
  const d = new Date(2026, 0, 5, hour)
  return uses24h(lang) ? formatTime(d, lang) : dtf(lang, { hour: 'numeric' }).format(d)
}

export function formatTimeRange(start: Date, end: Date, lang: string): string {
  return `${formatTime(start, lang)} – ${formatTime(end, lang)}`
}

export function formatDay(d: Date, lang: string, style: 'long' | 'medium' | 'short'): string {
  const options: Intl.DateTimeFormatOptions =
    style === 'long'
      ? { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }
      : style === 'medium'
        ? { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }
        : { day: 'numeric', month: 'short' }
  return dtf(lang, options).format(d)
}

export function formatMonth(d: Date, lang: string): string {
  return dtf(lang, { month: 'long', year: 'numeric' }).format(d)
}

/** weekday names indexed by Date#getDay (0 = Sunday) */
export function weekdayNames(lang: string, width: 'long' | 'short' | 'narrow'): string[] {
  // 4 Jan 2026 is a Sunday
  return Array.from({ length: 7 }, (_, i) =>
    dtf(lang, { weekday: width }).format(new Date(2026, 0, 4 + i)),
  )
}

/** the weekday indexes 0–6 in the order the locale's week runs */
export function weekOrder(weekStart: number): number[] {
  return Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7)
}

/** the toolbar's period: "29. Sept. – 5. Okt. 2026", "Oktober 2026", "Mittwoch, 30. September 2026" */
export function periodTitle(
  view: CalendarView,
  anchor: Date,
  weekStart: number,
  lang: string,
): string {
  if (view === 'month') return formatMonth(anchor, lang)
  const range = viewRange(view, anchor, weekStart)
  if (view === 'day') return formatDay(range.start, lang, 'long')
  const last = addDays(range.end, -1)
  return formatRange(
    dtf(lang, { day: 'numeric', month: 'short', year: 'numeric' }),
    range.start,
    last,
  )
}

/** "Mi., 30. Sept. 2026, 09:00–10:00 Uhr", or the day(s) of an all-day event */
export function formatEventWhen(span: EventSpan, lang: string): string {
  if (span.allDay) {
    const last = addDays(span.end, -1)
    if (daysBetween(span.start, last) <= 0) return formatDay(span.start, lang, 'long')
    return formatRange(
      dtf(lang, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }),
      span.start,
      last,
    )
  }
  if (span.start.getTime() === span.end.getTime()) {
    return `${formatDay(span.start, lang, 'medium')}, ${formatTime(span.start, lang)}`
  }
  return formatRange(
    dtf(lang, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      ...timeOptions(lang),
    }),
    span.start,
    span.end,
  )
}

// ---- recurrence presets ----

export type RepeatKind = 'none' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'custom'

export interface RepeatRule {
  kind: RepeatKind
  /** weekly: the days it repeats on, 0 = Sunday … 6 = Saturday */
  weekdays: number[]
  ends: 'never' | 'on' | 'after'
  /** ends 'on': the last day an occurrence may fall on, "YYYY-MM-DD" (local) */
  until: string
  /** ends 'after': number of occurrences */
  count: number
  /** the RRULE as received; the only source of truth for 'custom' */
  raw?: string
}

export const BYDAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

export function noRepeat(): RepeatRule {
  return { kind: 'none', weekdays: [], ends: 'never', until: '', count: 10 }
}

function customRule(raw: string): RepeatRule {
  return { ...noRepeat(), kind: 'custom', raw }
}

/** UNTIL (date or date-time, UTC or floating) as the local day it ends on */
function untilDay(value: string): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z?))?$/i.exec(value)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])]
  if (!m[4]) {
    const date = new Date(y, mo, d)
    return date.getDate() === d ? dayKey(date) : null
  }
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6])]
  const date = m[7] ? new Date(Date.UTC(y, mo, d, h, mi, s)) : new Date(y, mo, d, h, mi, s)
  return isValidDate(date) ? dayKey(date) : null
}

const ALLOWED_PARTS = new Set([
  'FREQ',
  'INTERVAL',
  'COUNT',
  'UNTIL',
  'BYDAY',
  'BYMONTHDAY',
  'BYMONTH',
  'WKST',
])

/**
 * The editor's presets for an RRULE. Anything the presets cannot express
 * exactly (intervals, "second Tuesday", BYSETPOS …) comes back as 'custom'
 * with the rule kept verbatim, so opening and saving an event never rewrites
 * a series the user did not touch.
 */
export function parseRrule(rrule: string | null | undefined, start: Date): RepeatRule {
  const raw = (rrule ?? '').trim().replace(/^RRULE:/i, '')
  if (!raw) return noRepeat()
  const parts = new Map<string, string>()
  for (const piece of raw.split(';')) {
    if (!piece) continue
    const eq = piece.indexOf('=')
    if (eq <= 0) return customRule(raw)
    const key = piece.slice(0, eq).trim().toUpperCase()
    if (!ALLOWED_PARTS.has(key) || parts.has(key)) return customRule(raw)
    parts.set(
      key,
      piece
        .slice(eq + 1)
        .trim()
        .toUpperCase(),
    )
  }
  const interval = parts.get('INTERVAL')
  if (interval !== undefined && Number(interval) !== 1) return customRule(raw)

  const rule = noRepeat()
  const count = parts.get('COUNT')
  const until = parts.get('UNTIL')
  if (count !== undefined && until !== undefined) return customRule(raw)
  if (count !== undefined) {
    const n = Number(count)
    if (!Number.isInteger(n) || n < 1) return customRule(raw)
    rule.ends = 'after'
    rule.count = n
  } else if (until !== undefined) {
    const day = untilDay(until)
    if (!day) return customRule(raw)
    rule.ends = 'on'
    rule.until = day
  }

  const byDay = parts.get('BYDAY')
  const byMonthDay = parts.get('BYMONTHDAY')
  const byMonth = parts.get('BYMONTH')
  const plainDays = (): number[] | null => {
    if (byDay === undefined) return null
    const days = byDay.split(',').map((code) => BYDAY_CODES.indexOf(code as never))
    return days.every((d) => d >= 0) ? [...new Set(days)].sort((a, b) => a - b) : null
  }

  switch (parts.get('FREQ')) {
    case 'DAILY': {
      if (byMonthDay !== undefined || byMonth !== undefined) return customRule(raw)
      if (byDay === undefined) return { ...rule, kind: 'daily', raw }
      // "every weekday" is often written as a daily rule with BYDAY: the same set of days
      const days = plainDays()
      return days ? { ...rule, kind: 'weekly', weekdays: days, raw } : customRule(raw)
    }
    case 'WEEKLY': {
      if (byMonthDay !== undefined || byMonth !== undefined) return customRule(raw)
      const days = byDay === undefined ? [start.getDay()] : plainDays()
      return days ? { ...rule, kind: 'weekly', weekdays: days, raw } : customRule(raw)
    }
    case 'MONTHLY':
      if (byDay !== undefined || byMonth !== undefined) return customRule(raw)
      if (byMonthDay !== undefined && Number(byMonthDay) !== start.getDate()) return customRule(raw)
      return { ...rule, kind: 'monthly', raw }
    case 'YEARLY':
      if (byDay !== undefined) return customRule(raw)
      if (byMonth !== undefined && Number(byMonth) !== start.getMonth() + 1) return customRule(raw)
      if (byMonthDay !== undefined && Number(byMonthDay) !== start.getDate()) return customRule(raw)
      return { ...rule, kind: 'yearly', raw }
    default:
      return customRule(raw)
  }
}

function utcStamp(d: Date): string {
  return (
    `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`
  )
}

/**
 * The RRULE value for a preset, or null for "does not repeat". UNTIL follows
 * RFC 5545: a DATE for all-day series, the UTC end of the chosen local day
 * for timed ones (so an occurrence on that day is still included).
 */
export function buildRrule(rule: RepeatRule, start: Date, allDay: boolean): string | null {
  let value: string
  switch (rule.kind) {
    case 'none':
      return null
    case 'custom':
      return rule.raw?.trim() || null
    case 'daily':
      value = 'FREQ=DAILY'
      break
    case 'weekly': {
      const days = rule.weekdays.length ? rule.weekdays : [start.getDay()]
      // Monday-first, the order Outlook and most servers write
      const ordered = [...new Set(days)].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7))
      value = `FREQ=WEEKLY;BYDAY=${ordered.map((d) => BYDAY_CODES[d]).join(',')}`
      break
    }
    case 'monthly':
      value = 'FREQ=MONTHLY'
      break
    case 'yearly':
      value = 'FREQ=YEARLY'
      break
  }
  if (rule.ends === 'after') {
    const n = Math.min(999, Math.max(1, Math.round(rule.count) || 1))
    value += `;COUNT=${n}`
  } else if (rule.ends === 'on') {
    const day = parseDayKey(rule.until)
    if (isValidDate(day)) {
      value += allDay
        ? `;UNTIL=${rule.until.replace(/-/g, '')}`
        : `;UNTIL=${utcStamp(new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59, 59))}`
    }
  }
  return value
}

/** a problem with the series' end the editor should point out, or null */
export function repeatProblem(rule: RepeatRule, start: Date): 'until-before-start' | null {
  if (rule.kind === 'none' || rule.kind === 'custom' || rule.ends !== 'on') return null
  const until = parseDayKey(rule.until)
  if (!isValidDate(until) || until < startOfDay(start)) return 'until-before-start'
  return null
}
