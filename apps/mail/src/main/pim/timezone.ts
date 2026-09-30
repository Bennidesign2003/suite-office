/**
 * Time-zone arithmetic without a zone database of our own: the platform's
 * Intl data answers "what is the UTC offset of zone Z at instant T", which is
 * enough to turn an iCalendar wall time (DTSTART;TZID=Europe/Berlin:…) into
 * an instant and back.
 */

/** Outlook / Exchange write Windows zone names; the common ones mapped to IANA */
const WINDOWS_ZONES: Record<string, string> = {
  'W. Europe Standard Time': 'Europe/Berlin',
  'Central Europe Standard Time': 'Europe/Budapest',
  'Central European Standard Time': 'Europe/Warsaw',
  'Romance Standard Time': 'Europe/Paris',
  'GMT Standard Time': 'Europe/London',
  'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'E. Europe Standard Time': 'Europe/Chisinau',
  'FLE Standard Time': 'Europe/Kiev',
  'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow',
  'Turkey Standard Time': 'Europe/Istanbul',
  'Israel Standard Time': 'Asia/Jerusalem',
  'Arab Standard Time': 'Asia/Riyadh',
  'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Kolkata',
  'China Standard Time': 'Asia/Shanghai',
  'Tokyo Standard Time': 'Asia/Tokyo',
  'Korea Standard Time': 'Asia/Seoul',
  'Singapore Standard Time': 'Asia/Singapore',
  'AUS Eastern Standard Time': 'Australia/Sydney',
  'New Zealand Standard Time': 'Pacific/Auckland',
  'Eastern Standard Time': 'America/New_York',
  'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver',
  'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles',
  'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu',
  'Atlantic Standard Time': 'America/Halifax',
  'SA Eastern Standard Time': 'America/Cayenne',
  'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Argentina/Buenos_Aires',
  'Mexico Standard Time': 'America/Mexico_City',
  'Central America Standard Time': 'America/Guatemala',
  'South Africa Standard Time': 'Africa/Johannesburg',
  'Egypt Standard Time': 'Africa/Cairo',
  UTC: 'UTC',
  'Coordinated Universal Time': 'UTC',
}

const validZones = new Map<string, boolean>()

function isIanaZone(zone: string): boolean {
  const known = validZones.get(zone)
  if (known !== undefined) return known
  let ok = false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone })
    ok = true
  } catch {
    ok = false
  }
  validZones.set(zone, ok)
  return ok
}

/**
 * The IANA zone a TZID names, or null when it names none we know (the event is
 * then treated as floating: local wall time). Handles Windows names and the
 * "/mozilla.org/20050126_1/Europe/Berlin"-style prefixes some clients write.
 */
export function resolveTimezone(tzid: string | undefined): string | null {
  if (!tzid) return null
  const trimmed = tzid.trim().replace(/^"|"$/g, '')
  if (WINDOWS_ZONES[trimmed]) return WINDOWS_ZONES[trimmed]!
  if (isIanaZone(trimmed)) return trimmed
  const tail = trimmed.match(/([A-Za-z]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/)?.[1]
  if (tail && isIanaZone(tail)) return tail
  if (/^(utc|gmt|z)$/i.test(trimmed)) return 'UTC'
  return null
}

export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export interface WallTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    formatters.set(zone, f)
  }
  return f
}

/** the wall-clock time in `zone` at instant `date` */
export function wallTimeIn(date: Date, zone: string): WallTime {
  const parts: Record<string, number> = {}
  for (const p of formatter(zone).formatToParts(date)) {
    if (p.type !== 'literal') parts[p.type] = Number(p.value)
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour === 24 ? 0 : parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  }
}

function offsetMs(date: Date, zone: string): number {
  const w = wallTimeIn(date, zone)
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

/**
 * The instant at which the wall clock in `zone` shows `wall`. In a DST gap the
 * time is pushed forward; in an overlap the earlier instant wins — the
 * behavior RFC 5545 prescribes.
 */
export function zonedToUtc(wall: WallTime, zone: string | null): Date {
  const naive = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  if (!zone) {
    // floating: the computer's own wall clock
    return new Date(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)
  }
  if (zone === 'UTC') return new Date(naive)
  // the offsets in force a day before and a day after bracket any transition
  const before = naive - offsetMs(new Date(naive - 86_400_000), zone)
  const after = naive - offsetMs(new Date(naive + 86_400_000), zone)
  const shows = (t: number): boolean => {
    const w = wallTimeIn(new Date(t), zone)
    return (
      w.year === wall.year &&
      w.month === wall.month &&
      w.day === wall.day &&
      w.hour === wall.hour &&
      w.minute === wall.minute
    )
  }
  const valid = [before, after].filter(shows)
  if (valid.length > 0) return new Date(Math.min(...valid))
  // a wall time inside a spring-forward gap: keep the offset from before it
  return new Date(before)
}

const pad = (n: number, w = 2): string => String(n).padStart(w, '0')

/** "20261001T140000" for a wall time */
export function formatWallTime(w: WallTime): string {
  return `${pad(w.year, 4)}${pad(w.month)}${pad(w.day)}T${pad(w.hour)}${pad(w.minute)}${pad(w.second)}`
}

/** "20261001T120000Z" for an instant */
export function formatUtc(date: Date): string {
  return (
    `${pad(date.getUTCFullYear(), 4)}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  )
}

/** "2026-10-01" → "20261001" */
export function formatDateValue(isoDate: string): string {
  return isoDate.slice(0, 10).replace(/-/g, '')
}
