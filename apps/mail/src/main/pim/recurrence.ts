import { RRule, type Options } from 'rrule'
import {
  alignTime,
  fromInstant,
  isRecurring,
  timeAt,
  timeMs,
  toInstant,
  wallIn,
  wallMs,
  type EventTime,
  type VEvent,
} from './ics'

/**
 * Recurring events expanded into the occurrences a calendar view draws.
 *
 * The rrule package is used on "floating" dates: DTSTART's wall-clock fields
 * go in as if they were UTC, the rule steps through wall-clock values, and
 * each result is turned into an instant in the event's own zone afterwards.
 * That is what keeps a weekly 09:00 Europe/Berlin meeting at 09:00 on both
 * sides of a DST change.
 */

export const MAX_OCCURRENCES = 5000

const DAY_MS = 86_400_000
/** zone offsets reach ±14 h; floating values are compared with this much slack */
const SLACK_MS = 2 * DAY_MS

export interface Occurrence {
  /** the VEVENT describing this occurrence: the series, or its RECURRENCE-ID override */
  event: VEvent
  override: boolean
  start: EventTime
  end: EventTime
  /** instants; all-day occurrences use this computer's midnight */
  startAt: Date
  endAt: Date
  /** the start the series gives this occurrence (its RECURRENCE-ID); unset for single events */
  recurrenceId?: EventTime
}

/**
 * The IPC form of an occurrence start (CalendarEvent.occurrenceStart):
 * "YYYY-MM-DD" for all-day series, an ISO instant otherwise.
 */
export function occurrenceKey(t: EventTime): string {
  return t.kind === 'date' ? t.date : toInstant(t).toISOString()
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

function localDate(instant: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${instant.getFullYear()}-${p(instant.getMonth() + 1)}-${p(instant.getDate())}`
}

/** whether an occurrence start sent over IPC names `t` */
export function matchesOccurrence(t: EventTime, key: string): boolean {
  const keyIsDate = DATE_KEY.test(key)
  if (t.kind === 'date' || keyIsDate) {
    const tDate =
      t.kind === 'date'
        ? t.date
        : `${String(t.wall.year).padStart(4, '0')}-${String(t.wall.month).padStart(2, '0')}-${String(t.wall.day).padStart(2, '0')}`
    const at = Date.parse(key)
    if (Number.isNaN(at)) return false
    return tDate === (keyIsDate ? key : localDate(new Date(at)))
  }
  const at = Date.parse(key)
  return !Number.isNaN(at) && Math.abs(toInstant(t).getTime() - at) < 1000
}

const FREQS = new Set(['SECONDLY', 'MINUTELY', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'])
const WEEKDAY = /^[+-]?\d{0,2}(MO|TU|WE|TH|FR|SA|SU)$/
const NUMERIC_PARTS = new Set([
  'BYSECOND',
  'BYMINUTE',
  'BYHOUR',
  'BYMONTHDAY',
  'BYYEARDAY',
  'BYWEEKNO',
  'BYMONTH',
  'BYSETPOS',
])
/** these may be 0; the other BY* lists may not */
const ZERO_OK = new Set(['BYSECOND', 'BYMINUTE', 'BYHOUR'])

/** UNTIL as a floating value on the series' wall clock */
function untilValue(value: string, start: EventTime): Date | null {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(
    value.replace(/[-:]/g, ''),
  )
  if (!m) return null
  const [y, mo, d] = [+m[1]!, +m[2]!, +m[3]!]
  if (m[4] === undefined) {
    // a date: the whole day counts
    return new Date(
      start.kind === 'date' ? Date.UTC(y, mo - 1, d) : Date.UTC(y, mo - 1, d, 23, 59, 59),
    )
  }
  const wall = { year: y, month: mo, day: d, hour: +m[4], minute: +m[5]!, second: +(m[6] ?? 0) }
  if (!m[7]) return new Date(wallMs(wall))
  return new Date(wallMs(wallIn(new Date(wallMs(wall)), start)))
}

/**
 * RRULE options rrule accepts: unknown parts (RSCALE, SKIP, X-…) and invalid
 * values are dropped instead of failing the whole event. Null without FREQ.
 */
export function parseRule(
  value: string,
  start: EventTime,
): { options: Partial<Options>; until?: Date } | null {
  const kept: string[] = []
  let until: Date | undefined
  let freq = false
  for (const part of value
    .toUpperCase()
    .replace(/^RRULE:/, '')
    .split(';')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.slice(0, eq).trim()
    const v = part.slice(eq + 1).trim()
    if (key === 'FREQ') {
      if (FREQS.has(v)) {
        freq = true
        kept.push(`FREQ=${v}`)
      }
    } else if (key === 'INTERVAL') {
      if (/^\d+$/.test(v) && Number(v) >= 1) kept.push(`INTERVAL=${Number(v)}`)
    } else if (key === 'COUNT') {
      if (/^\d+$/.test(v) && Number(v) >= 1) kept.push(`COUNT=${Number(v)}`)
    } else if (key === 'UNTIL') {
      until = untilValue(v, start) ?? undefined
    } else if (NUMERIC_PARTS.has(key)) {
      const nums = v
        .split(',')
        .map((n) => n.trim())
        .filter((n) => /^[+-]?\d{1,3}$/.test(n) && (ZERO_OK.has(key) || Number(n) !== 0))
      if (nums.length) kept.push(`${key}=${nums.map(Number).join(',')}`)
    } else if (key === 'BYDAY') {
      const days = v
        .split(',')
        .map((d) => d.trim())
        .filter((d) => WEEKDAY.test(d))
      if (days.length) kept.push(`BYDAY=${days.join(',')}`)
    } else if (key === 'WKST') {
      if (/^(MO|TU|WE|TH|FR|SA|SU)$/.test(v)) kept.push(`WKST=${v}`)
    }
  }
  if (!freq) return null
  try {
    const options = RRule.parseString(kept.join(';'))
    return impossible(options) ? null : { options, ...(until ? { until } : {}) }
  } catch {
    return null
  }
}

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * BYMONTH/BYMONTHDAY combinations no year can satisfy (February 30th):
 * rrule would search every year up to 9999 for them.
 */
function impossible(o: Partial<Options>): boolean {
  if (o.bymonthday === undefined || o.bymonthday === null) return false
  const days = ([] as number[]).concat(o.bymonthday)
  const months =
    o.bymonth === undefined || o.bymonth === null ? [] : ([] as number[]).concat(o.bymonth)
  const inMonths = months.length ? months : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  return !inMonths.some((m) => days.some((d) => Math.abs(d) <= (MONTH_DAYS[m - 1] ?? 0)))
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b]
  return a
}

const SUB_DAILY: Record<number, number> = {
  [RRule.HOURLY]: 3600,
  [RRule.MINUTELY]: 60,
  [RRule.SECONDLY]: 1,
}

function buildRule(value: string, start: EventTime, windowStart: number): RRule | null {
  const parsed = parseRule(value, start)
  if (!parsed) return null
  const o = parsed.options
  let dtstart = timeMs(start)
  // rrule walks every instance from DTSTART; an old open-ended hourly (or
  // finer) rule would take millions of steps to reach today. Without COUNT
  // and without month/year-based parts, moving DTSTART forward by whole
  // multiples of both the period and a week changes nothing but the speed.
  const unit = o.freq !== undefined ? SUB_DAILY[o.freq] : undefined
  if (
    unit &&
    !o.count &&
    !o.bymonth &&
    !o.bymonthday &&
    !o.byyearday &&
    !o.byweekno &&
    !o.bysetpos
  ) {
    const period = (o.interval ?? 1) * unit
    const week = 7 * 86400
    const stepMs = (period / gcd(period, week)) * week * 1000
    if (stepMs <= 400 * DAY_MS && windowStart - dtstart > 2 * stepMs) {
      dtstart += (Math.floor((windowStart - dtstart) / stepMs) - 1) * stepMs
    }
  }
  try {
    return new RRule({ ...o, dtstart: new Date(dtstart), until: parsed.until ?? null, tzid: null })
  } catch {
    return null
  }
}

function overlaps(occ: Occurrence, from: number, to: number): boolean {
  const s = occ.startAt.getTime()
  const e = occ.endAt.getTime()
  return e > s ? s < to && e > from : s >= from && s < to
}

function single(ev: VEvent, override: boolean, recurrenceId?: EventTime): Occurrence {
  return {
    event: ev,
    override,
    start: ev.start,
    end: ev.end,
    startAt: toInstant(ev.start),
    endAt: toInstant(ev.end),
    ...(recurrenceId ? { recurrenceId } : {}),
  }
}

/**
 * The occurrences of an event overlapping [from, to), sorted by start: the
 * series' instances (RRULE + RDATE − EXDATE, DTSTART always included) with
 * RECURRENCE-ID overrides in place of the instances they replace. An
 * override stays visible even when its own start moved out of the rule, and
 * one whose RECURRENCE-ID is excluded counts as deleted. At most
 * MAX_OCCURRENCES are returned.
 */
export function expandOccurrences(
  master: VEvent,
  overrides: VEvent[],
  from: Date,
  to: Date,
): Occurrence[] {
  const fromMs = from.getTime()
  const toMs = to.getTime()
  if (!(fromMs < toMs)) return []
  const out: Occurrence[] = []

  if (master.timeless || !isRecurring(master)) {
    if (!master.timeless) {
      const occ = single(master, false)
      if (overlaps(occ, fromMs, toMs)) out.push(occ)
    }
    return out
  }

  const series = master.start
  const allDay = series.kind === 'date'
  const key = (t: EventTime): number => timeMs(alignTime(t, series))
  const excluded = new Set(master.exdates.map(key))
  const overridden = new Set<number>()
  for (const o of overrides) if (o.recurrenceId) overridden.add(key(o.recurrenceId))

  const startFake = timeMs(series)
  const durationMs = allDay
    ? timeMs(master.end) - startFake
    : toInstant(master.end).getTime() - toInstant(series).getTime()
  const lo = fromMs - Math.max(durationMs, 0) - SLACK_MS
  const hi = toMs + SLACK_MS

  const candidates = new Set<number>()
  // DTSTART is the first instance even when the rule would not produce it
  if (startFake >= lo && startFake <= hi) candidates.add(startFake)
  const rule = master.rrule ? buildRule(master.rrule, series, lo) : null
  if (rule) {
    try {
      rule.between(new Date(lo), new Date(hi), true, (d, n) => {
        if (n >= MAX_OCCURRENCES) return false
        candidates.add(d.getTime())
        return true
      })
    } catch {
      // a rule rrule chokes on: the series shows its DTSTART and RDATEs only
    }
  }
  for (const r of master.rdates) {
    const ms = key(r)
    if (ms >= lo && ms <= hi) candidates.add(ms)
  }

  for (const ms of [...candidates].sort((a, b) => a - b)) {
    if (excluded.has(ms) || overridden.has(ms)) continue
    const start = timeAt(ms, series)
    let occ: Occurrence
    if (allDay) {
      const end = timeAt(ms + durationMs, series)
      occ = {
        event: master,
        override: false,
        start,
        end,
        startAt: toInstant(start),
        endAt: toInstant(end),
      }
    } else {
      const startAt = toInstant(start)
      const endAt = new Date(startAt.getTime() + durationMs)
      occ = {
        event: master,
        override: false,
        start,
        end: fromInstant(endAt, series),
        startAt,
        endAt,
      }
    }
    occ.recurrenceId = start
    if (overlaps(occ, fromMs, toMs)) out.push(occ)
    if (out.length >= MAX_OCCURRENCES) break
  }

  for (const o of overrides) {
    if (o.timeless) continue
    if (o.recurrenceId && excluded.has(key(o.recurrenceId))) continue
    const occ = single(o, true, o.recurrenceId ?? o.start)
    if (overlaps(occ, fromMs, toMs)) out.push(occ)
  }

  out.sort((a, b) => a.startAt.getTime() - b.startAt.getTime())
  return out.length > MAX_OCCURRENCES ? out.slice(0, MAX_OCCURRENCES) : out
}

/** the occurrence of a series named by an IPC occurrence start, or null */
export function findOccurrence(
  master: VEvent,
  overrides: VEvent[],
  occurrenceStart: string,
): Occurrence | null {
  const at = DATE_KEY.test(occurrenceStart)
    ? new Date(
        Number(occurrenceStart.slice(0, 4)),
        Number(occurrenceStart.slice(5, 7)) - 1,
        Number(occurrenceStart.slice(8, 10)),
      ).getTime()
    : Date.parse(occurrenceStart)
  if (Number.isNaN(at)) return null
  const span = Math.max(timeMs(master.end) - timeMs(master.start), 0)
  const list = expandOccurrences(
    master,
    overrides,
    new Date(at - span - SLACK_MS),
    new Date(at + SLACK_MS),
  )
  return (
    list.find((o) => o.recurrenceId && matchesOccurrence(o.recurrenceId, occurrenceStart)) ?? null
  )
}

/** whether the series (ignoring its EXDATEs) produces an instance at `recurrenceId` */
export function generates(master: VEvent, recurrenceId: EventTime): boolean {
  const target = timeMs(alignTime(recurrenceId, master.start))
  const bare: VEvent = { ...master, exdates: [] }
  const at = toInstant(alignTime(recurrenceId, master.start)).getTime()
  return expandOccurrences(bare, [], new Date(at - SLACK_MS), new Date(at + SLACK_MS)).some(
    (o) => o.recurrenceId !== undefined && timeMs(o.recurrenceId) === target,
  )
}
