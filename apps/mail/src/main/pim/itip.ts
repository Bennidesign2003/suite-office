import type { Attachment, ParsedMail } from 'mailparser'
import type { Attendee, AttendeeStatus, Invitation, ItipMethod } from '../../shared/pim'
import { escapeText, param, parseContentLine, serializeLine, type ContentLine } from './contentline'
import {
  addressOf,
  attendeeStatus,
  groupByUid,
  parseIcs,
  partstatOf,
  toInstant,
  type EventTime,
  type VEvent,
} from './ics'
import { formatUtc, resolveTimezone } from './timezone'
import { buildVtimezone } from './vtimezone'

/**
 * Meeting messages in mail (iTIP, RFC 5546): reading the text/calendar part
 * of an invitation, answering it, and filing answers to meetings the user
 * organized. Stored objects are edited line by line — only the lines that
 * must change are rewritten, so everything the organizer's client put in
 * (X-MICROSOFT-*, ATTACH, alarms, unknown components) survives byte for byte.
 */

// ---- line-level editing ----

interface Line {
  /** the physical lines as they came, folding kept */
  text: string
  /** null for lines that are not content lines (garbage survives untouched) */
  parsed: ContentLine | null
  /** the components this line sits in, outermost first: ['VCALENDAR', 'VEVENT'] */
  path: string[]
}

function splitLines(ics: string): Line[] {
  const out: Array<{ physical: string[]; logical: string }> = []
  for (const physical of ics.replace(/^\uFEFF/, '').split(/\r\n|\n|\r/)) {
    const last = out[out.length - 1]
    if ((physical.startsWith(' ') || physical.startsWith('\t')) && last) {
      last.physical.push(physical)
      last.logical += physical.slice(1)
    } else if (physical.length > 0) {
      out.push({ physical: [physical], logical: physical })
    }
  }
  const stack: string[] = []
  return out.map(({ physical, logical }) => {
    const parsed = parseContentLine(logical)
    const line: Line = { text: physical.join('\r\n'), parsed, path: [...stack] }
    if (parsed?.name === 'BEGIN') stack.push(parsed.value.trim().toUpperCase())
    else if (parsed?.name === 'END') {
      const at = stack.lastIndexOf(parsed.value.trim().toUpperCase())
      if (at >= 0) stack.length = at
    }
    return line
  })
}

function joinLines(lines: Line[]): string {
  return lines.map((l) => l.text).join('\r\n') + '\r\n'
}

function lineOf(parsed: ContentLine): string {
  const name = parsed.group ? `${parsed.group}.${parsed.name}` : parsed.name
  return serializeLine(name, parsed.value, parsed.params)
}

interface Span {
  name: string
  /** index of the BEGIN line */
  begin: number
  /** index of the END line (or of the last line of an unterminated component) */
  end: number
}

/** every component of the given name, at any depth */
function spans(lines: Line[], name: string): Span[] {
  const out: Span[] = []
  for (let i = 0; i < lines.length; i++) {
    const p = lines[i]!.parsed
    if (p?.name !== 'BEGIN' || p.value.trim().toUpperCase() !== name) continue
    const depth = lines[i]!.path.length
    let end = lines.length - 1
    for (let j = i + 1; j < lines.length; j++) {
      const q = lines[j]!.parsed
      if (
        q?.name === 'END' &&
        lines[j]!.path.length === depth + 1 &&
        q.value.trim().toUpperCase() === name
      ) {
        end = j
        break
      }
    }
    out.push({ name, begin: i, end })
  }
  return out
}

/** property lines that belong to the component itself, not to a nested VALARM */
function ownProps(lines: Line[], span: Span): number[] {
  const depth = lines[span.begin]!.path.length + 1
  const out: number[] = []
  for (let i = span.begin + 1; i < span.end; i++) {
    const l = lines[i]!
    if (l.path.length === depth && l.parsed && l.parsed.name !== 'BEGIN' && l.parsed.name !== 'END')
      out.push(i)
  }
  return out
}

function ownProp(lines: Line[], span: Span, name: string): ContentLine | undefined {
  for (const i of ownProps(lines, span)) {
    if (lines[i]!.parsed!.name === name) return lines[i]!.parsed!
  }
  return undefined
}

/** where a new property goes: before the first sub-component (VALARM), as RFC 5545's grammar wants */
function propsEnd(lines: Line[], span: Span): number {
  const depth = lines[span.begin]!.path.length + 1
  for (let i = span.begin + 1; i < span.end; i++) {
    if (lines[i]!.parsed?.name === 'BEGIN' && lines[i]!.path.length === depth) return i
  }
  return span.end
}

const sameAddress = (line: ContentLine, email: string): boolean =>
  addressOf(line)?.toLowerCase() === email.trim().toLowerCase()

const SCHEDULE_PARAMS = ['SCHEDULE-AGENT', 'SCHEDULE-STATUS', 'SCHEDULE-FORCE-SEND']

function withoutParams(
  params: Record<string, string[]>,
  names: string[],
): Record<string, string[]> {
  const out = { ...params }
  for (const n of names) delete out[n]
  return out
}

/** "where a meeting (instance) is": RECURRENCE-ID as a comparable key, '' for the series */
function recurrenceKeys(lines: Line[], events: Span[]): string[] {
  const timezones = spans(lines, 'VTIMEZONE')
    .map((s) => joinLines(lines.slice(s.begin, s.end + 1)))
    .join('')
  return events.map((span) => {
    const rid = ownProp(lines, span, 'RECURRENCE-ID')
    if (!rid) return ''
    // let the calendar engine resolve the TZID (Windows names, custom VTIMEZONEs)
    const mini =
      `BEGIN:VCALENDAR\r\n${timezones}BEGIN:VEVENT\r\nUID:x\r\n` +
      `${lineOf(rid)}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`
    const id = parseIcs(mini).events[0]?.recurrenceId
    return id ? instantKey(id) : `raw:${rid.value.trim()}`
  })
}

function instantKey(t: EventTime): string {
  if (t.kind === 'date') return t.date
  const at = toInstant(t)
  return Number.isFinite(at.getTime()) ? at.toISOString() : ''
}

// ---- reading an invitation out of a mail ----

const CALENDAR_TYPES = /^(text\/calendar|application\/ics|text\/x-vcalendar|application\/x-ics)$/i
const MAX_PART_BYTES = 10 * 1024 * 1024
const METHODS: ReadonlySet<string> = new Set([
  'REQUEST',
  'CANCEL',
  'REPLY',
  'PUBLISH',
  'COUNTER',
  'REFRESH',
])

function contentTypeParams(part: Attachment): Record<string, string> {
  const header = part.headers?.get?.('content-type') as
    { params?: Record<string, unknown> } | string | undefined
  const out: Record<string, string> = {}
  if (header && typeof header === 'object' && header.params) {
    for (const [k, v] of Object.entries(header.params)) {
      if (typeof v === 'string') out[k.toLowerCase()] = v
    }
  }
  return out
}

function isCalendarPart(part: Attachment): boolean {
  if (CALENDAR_TYPES.test(part.contentType ?? '')) return true
  // some mailers send invite.ics as application/octet-stream
  return /\.(ics|ical|ifb|icalendar|vcs)$/i.test(part.filename ?? '')
}

/** the part's text: its declared charset, else UTF-8, else Windows-1252 (old Outlook) */
function decodePart(content: Uint8Array, charset: string | undefined): string {
  const attempts = [charset, 'utf-8'].filter((c): c is string => Boolean(c))
  for (const label of attempts) {
    try {
      return new TextDecoder(label, { fatal: true }).decode(content).replace(/^\uFEFF/, '')
    } catch {
      // unknown label or invalid bytes: try the next
    }
  }
  return new TextDecoder('windows-1252').decode(content).replace(/^\uFEFF/, '')
}

function timeString(t: EventTime): string {
  if (t.kind === 'date') return t.date
  const at = toInstant(t)
  return Number.isFinite(at.getTime()) ? at.toISOString() : ''
}

function attendeeOf(a: VEvent['attendees'][number]): Attendee {
  return {
    ...(a.name ? { name: a.name } : {}),
    email: a.email,
    status: attendeeStatus(a.partstat),
    ...(a.role === 'OPT-PARTICIPANT' ? { optional: true } : {}),
  }
}

function senderOf(parsed: ParsedMail): string | undefined {
  const from = parsed.from?.value?.[0]?.address
  return typeof from === 'string' ? from.toLowerCase() : undefined
}

function invitationFrom(
  ics: string,
  partMethod: string | undefined,
  sender: string | undefined,
  lookupExisting?: (uid: string) => string | undefined,
): Invitation | undefined {
  const parsed = parseIcs(ics)
  const method = (parsed.method ?? partMethod?.trim().toUpperCase() ?? 'PUBLISH') as ItipMethod
  if (!METHODS.has(method)) return undefined
  const uids = new Set(parsed.events.map((e) => e.uid))
  // one meeting per message (RFC 5546); a calendar export with many events is just an attachment
  if (uids.size !== 1) return undefined
  const uid = [...uids][0]!
  if (!uid) return undefined
  const group = groupByUid(parsed.events)[0]
  const ev =
    group?.master ??
    [...(group?.overrides ?? [])].sort(
      (a, b) => toInstant(a.start).getTime() - toInstant(b.start).getTime(),
    )[0]
  if (!ev) return undefined

  const attendees = ev.attendees.map(attendeeOf)
  let replyStatus: AttendeeStatus | undefined
  if (method === 'REPLY') {
    const who =
      ev.attendees.find((a) => sender && a.email.toLowerCase() === sender) ??
      (ev.attendees.length === 1 ? ev.attendees[0] : undefined) ??
      ev.attendees.find((a) => a.partstat !== 'NEEDS-ACTION') ??
      ev.attendees[0]
    if (who) replyStatus = attendeeStatus(who.partstat)
  }

  let existing: string | undefined
  try {
    existing = lookupExisting?.(uid)
  } catch {
    existing = undefined
  }

  // a REPLY may carry no DTSTART at all; the card then shows no time
  const start = ev.timeless ? '' : timeString(ev.start)
  const end = ev.timeless ? '' : timeString(ev.end)
  return {
    method,
    uid,
    sequence: ev.sequence,
    title: ev.summary,
    location: ev.location,
    description: ev.description,
    start,
    end,
    allDay: !ev.timeless && ev.start.kind === 'date',
    ...(ev.rrule ? { rrule: ev.rrule } : {}),
    ...(ev.organizer ? { organizer: { ...ev.organizer } } : {}),
    attendees,
    ...(replyStatus ? { replyStatus } : {}),
    ics,
    ...(existing ? { existingEventId: existing } : {}),
  }
}

/**
 * The meeting a mail carries, if any. Outlook and Google send the same
 * iCalendar twice (a text/calendar alternative and an invite.ics
 * attachment); the part that names its METHOD wins.
 */
export function extractInvitation(
  parsed: ParsedMail,
  lookupExisting?: (uid: string) => string | undefined,
): Invitation | undefined {
  const parts = (parsed.attachments ?? []).filter(
    (a) => isCalendarPart(a) && a.content && a.content.length <= MAX_PART_BYTES,
  )
  const rank = (a: Attachment): number =>
    (contentTypeParams(a).method ? 0 : 2) + (/^text\/calendar$/i.test(a.contentType) ? 0 : 1)
  parts.sort((a, b) => rank(a) - rank(b))
  const sender = senderOf(parsed)
  for (const part of parts) {
    try {
      const params = contentTypeParams(part)
      const ics = decodePart(part.content, params.charset)
      if (!/BEGIN:VCALENDAR/i.test(ics) && !/BEGIN:VEVENT/i.test(ics)) continue
      const invitation = invitationFrom(ics, params.method, sender, lookupExisting)
      if (invitation) return invitation
    } catch {
      // a broken part: try the next one
    }
  }
  return undefined
}

// ---- answering ----

type Answer = 'accepted' | 'tentative' | 'declined'

const SUBJECT: Record<'de' | 'en', Record<Answer, string>> = {
  de: { accepted: 'Zugesagt', tentative: 'Mit Vorbehalt', declined: 'Abgelehnt' },
  en: { accepted: 'Accepted', tentative: 'Tentative', declined: 'Declined' },
}

const BODY: Record<'de' | 'en', Record<Answer, string>> = {
  de: {
    accepted: '{name} hat die Einladung angenommen.',
    tentative: '{name} hat die Einladung mit Vorbehalt angenommen.',
    declined: '{name} hat die Einladung abgelehnt.',
  },
  en: {
    accepted: '{name} has accepted the invitation.',
    tentative: '{name} has tentatively accepted the invitation.',
    declined: '{name} has declined the invitation.',
  },
}

const LABELS = {
  de: { untitled: 'Termin', when: 'Wann', where: 'Ort', allDay: 'ganztägig' },
  en: { untitled: 'Event', when: 'When', where: 'Where', allDay: 'all day' },
}

function describeWhen(invitation: Invitation, lang: 'de' | 'en'): string {
  const locale = lang === 'de' ? 'de-DE' : 'en-US'
  try {
    if (invitation.allDay) {
      const day = new Date(`${invitation.start}T00:00:00Z`)
      if (!Number.isFinite(day.getTime())) return ''
      const text = new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeZone: 'UTC' }).format(
        day,
      )
      return `${text} (${LABELS[lang].allDay})`
    }
    const start = new Date(invitation.start)
    if (!Number.isFinite(start.getTime())) return ''
    return new Intl.DateTimeFormat(locale, { dateStyle: 'full', timeStyle: 'short' }).format(start)
  } catch {
    return ''
  }
}

const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ').trim()

/** the VEVENT an answer is about: the series, or the single instance the invitation changed */
function answeredEvent(lines: Line[], uid: string): Span | undefined {
  const events = spans(lines, 'VEVENT').filter(
    (s) => ownProp(lines, s, 'UID')?.value.trim() === uid,
  )
  return events.find((s) => !ownProp(lines, s, 'RECURRENCE-ID')) ?? events[0]
}

function vtimezoneBlocks(lines: Line[], tzids: Set<string>, year: number): string[] {
  const out: string[] = []
  const given = new Map<string, string>()
  for (const s of spans(lines, 'VTIMEZONE')) {
    const tzid = ownProp(lines, s, 'TZID')?.value.trim()
    if (tzid && !given.has(tzid)) {
      const block = lines.slice(s.begin, s.end + 1)
      given.set(tzid, block.map((l) => (l.parsed ? lineOf(l.parsed) : l.text)).join('\r\n'))
    }
  }
  for (const tzid of tzids) {
    const block = given.get(tzid)
    if (block) {
      out.push(block)
      continue
    }
    const zone = resolveTimezone(tzid)
    if (!zone || zone === 'UTC') continue
    try {
      out.push(buildVtimezone(zone, year, tzid))
    } catch {
      // the organizer's client knows its own zone; the reply stays valid without it
    }
  }
  return out
}

function myAttendeeLine(
  original: ContentLine | undefined,
  me: { name: string; email: string },
  partstat: string,
): string {
  if (original) {
    const params = withoutParams(original.params, [...SCHEDULE_PARAMS, 'RSVP', 'PARTSTAT'])
    if (!params.CN && oneLine(me.name)) params.CN = [oneLine(me.name)]
    return serializeLine('ATTENDEE', original.value, { ...params, PARTSTAT: [partstat] })
  }
  const name = oneLine(me.name)
  return serializeLine('ATTENDEE', `mailto:${me.email.trim()}`, {
    ...(name ? { CN: name } : {}),
    PARTSTAT: partstat,
  })
}

/**
 * The iTIP REPLY to an invitation: one VEVENT naming the meeting (UID,
 * SEQUENCE, RECURRENCE-ID, times as received) and only the user as attendee.
 * Someone invited through a mailing list is not on the attendee list; the
 * answer then introduces them by their own address, as Outlook does.
 */
export function buildReply(
  invitation: Invitation,
  me: { name: string; email: string },
  answer: Answer,
  lang: 'de' | 'en' = 'de',
): { ics: string; subject: string; text: string } {
  const partstat = partstatOf(answer)
  const lines = splitLines(invitation.ics ?? '')
  const span = answeredEvent(lines, invitation.uid)
  const vevent: string[] = []
  const tzids = new Set<string>()
  let year = new Date().getUTCFullYear()

  if (span) {
    const own = ownProps(lines, span).map((i) => lines[i]!)
    const first = (name: string): Line | undefined => own.find((l) => l.parsed!.name === name)
    const uid = first('UID')
    vevent.push(uid ? lineOf(uid.parsed!) : serializeLine('UID', invitation.uid))
    vevent.push(`SEQUENCE:${invitation.sequence}`)
    vevent.push(`DTSTAMP:${formatUtc(new Date())}`)
    for (const name of ['DTSTART', 'DTEND', 'DURATION', 'RECURRENCE-ID']) {
      const l = first(name)
      if (!l) continue
      vevent.push(lineOf(l.parsed!))
      const tzid = param(l.parsed!, 'TZID')?.trim()
      if (tzid) tzids.add(tzid)
      const y = Number(/^(\d{4})/.exec(l.parsed!.value.trim())?.[1])
      if (name === 'DTSTART' && y) year = y
    }
    const organizer = first('ORGANIZER')?.parsed
    if (organizer) {
      vevent.push(
        serializeLine(
          'ORGANIZER',
          organizer.value,
          withoutParams(organizer.params, SCHEDULE_PARAMS),
        ),
      )
    }
    const mine = own
      .map((l) => l.parsed!)
      .find((p) => p.name === 'ATTENDEE' && sameAddress(p, me.email))
    vevent.push(myAttendeeLine(mine, me, partstat))
    const summary = first('SUMMARY')
    if (summary) vevent.push(lineOf(summary.parsed!))
  } else {
    // the stored text no longer parses: answer from what the card showed
    vevent.push(serializeLine('UID', invitation.uid))
    vevent.push(`SEQUENCE:${invitation.sequence}`)
    vevent.push(`DTSTAMP:${formatUtc(new Date())}`)
    if (invitation.allDay && /^\d{4}-\d{2}-\d{2}$/.test(invitation.start)) {
      vevent.push(`DTSTART;VALUE=DATE:${invitation.start.replace(/-/g, '')}`)
    } else if (Number.isFinite(new Date(invitation.start).getTime())) {
      vevent.push(`DTSTART:${formatUtc(new Date(invitation.start))}`)
    }
    if (invitation.organizer) {
      const name = oneLine(invitation.organizer.name ?? '')
      vevent.push(
        serializeLine(
          'ORGANIZER',
          `mailto:${invitation.organizer.email}`,
          name ? { CN: name } : {},
        ),
      )
    }
    vevent.push(myAttendeeLine(undefined, me, partstat))
    if (invitation.title) vevent.push(serializeLine('SUMMARY', escapeText(invitation.title)))
  }

  const ics =
    [
      'BEGIN:VCALENDAR',
      'PRODID:-//Suite Office//DE',
      'VERSION:2.0',
      'CALSCALE:GREGORIAN',
      'METHOD:REPLY',
      ...vtimezoneBlocks(lines, tzids, year),
      'BEGIN:VEVENT',
      ...vevent,
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n') + '\r\n'

  const title = oneLine(invitation.title ?? '') || LABELS[lang].untitled
  const who = oneLine(me.name) || me.email.trim()
  const body = [BODY[lang][answer].replace('{name}', who), '', title]
  const when = describeWhen(invitation, lang)
  if (when) body.push(`${LABELS[lang].when}: ${when}`)
  if (invitation.location?.trim())
    body.push(`${LABELS[lang].where}: ${oneLine(invitation.location)}`)
  return { ics, subject: `${SUBJECT[lang][answer]}: ${title}`, text: body.join('\n') + '\n' }
}

// ---- storing ----

function dropMethod(lines: Line[]): Line[] {
  return lines.filter(
    (l) => !(l.parsed?.name === 'METHOD' && l.path.length === 1 && l.path[0] === 'VCALENDAR'),
  )
}

/** a calendar object without its iTIP METHOD — CalDAV servers refuse stored objects that have one */
export function stripMethod(ics: string): string {
  const lines = splitLines(ics)
  const kept = dropMethod(lines)
  return kept.length === lines.length ? ics : joinLines(kept)
}

/**
 * The user's own answer written into a received meeting before it is stored:
 * PARTSTAT on the user's ATTENDEE line in every VEVENT (series and changed
 * instances), everything else as it came. When the user was invited through a
 * list and has no line, one is added, so the calendar shows the answer.
 */
export function applyPartstat(ics: string, email: string, status: AttendeeStatus): string {
  const lines = dropMethod(splitLines(ics))
  const address = email.trim()
  if (!address) return joinLines(lines)
  const partstat = partstatOf(status)
  const inserts: Array<{ at: number; text: string }> = []
  for (const span of spans(lines, 'VEVENT')) {
    let found = false
    for (const i of ownProps(lines, span)) {
      const p = lines[i]!.parsed!
      if (p.name !== 'ATTENDEE' || !sameAddress(p, address)) continue
      found = true
      if ((param(p, 'PARTSTAT') ?? '').toUpperCase() === partstat) continue
      lines[i] = {
        ...lines[i]!,
        text: lineOf({ ...p, params: { ...p.params, PARTSTAT: [partstat] } }),
      }
    }
    const meeting = Boolean(ownProp(lines, span, 'ORGANIZER'))
    if (!found && meeting && status !== 'needs-action') {
      inserts.push({
        at: propsEnd(lines, span),
        text: serializeLine('ATTENDEE', `mailto:${address}`, { PARTSTAT: partstat }),
      })
    }
  }
  // back to front, so earlier insert positions stay valid
  for (const { at, text } of inserts.sort((a, b) => b.at - a.at)) {
    lines.splice(at, 0, { text, parsed: null, path: [] })
  }
  return joinLines(lines)
}

/**
 * Organizer side: an attendee's REPLY filed into the stored meeting. Returns
 * null when the answer is for another meeting (UIDs differ), is older than
 * the stored version (lower SEQUENCE), or would change nothing — so opening
 * the same answer mail twice does not rewrite the event on the server.
 */
export function applyReply(storedIcs: string, replyIcs: string): string | null {
  const stored = splitLines(storedIcs)
  const reply = splitLines(replyIcs)
  const replyEvents = spans(reply, 'VEVENT')
  const storedEvents = spans(stored, 'VEVENT')
  if (!replyEvents.length || !storedEvents.length) return null
  const uidOf = (lines: Line[], s: Span): string => ownProp(lines, s, 'UID')?.value.trim() ?? ''
  const seqOf = (lines: Line[], s: Span): number | null => {
    const v = ownProp(lines, s, 'SEQUENCE')?.value.trim()
    const n = v === undefined ? NaN : Number.parseInt(v, 10)
    return Number.isFinite(n) ? n : null
  }
  const uid = uidOf(reply, replyEvents[0]!)
  if (!uid || replyEvents.some((s) => uidOf(reply, s) !== uid)) return null
  const targets = storedEvents.filter((s) => uidOf(stored, s) === uid)
  if (!targets.length) return null

  const storedSeq = Math.max(0, ...targets.map((s) => seqOf(stored, s) ?? 0))
  const replyKeys = recurrenceKeys(reply, replyEvents)
  const storedKeys = recurrenceKeys(stored, targets)

  const inserts: Array<{ at: number; text: string }> = []
  let changed = false
  replyEvents.forEach((rs, r) => {
    // clients that leave SEQUENCE out are trusted; an explicit older one is outdated
    const seq = seqOf(reply, rs)
    if (seq !== null && seq < storedSeq) return
    const key = replyKeys[r]!
    const into = targets.filter((_s, t) => key === '' || storedKeys[t] === key)
    for (const ri of ownProps(reply, rs)) {
      const answer = reply[ri]!.parsed!
      if (answer.name !== 'ATTENDEE') continue
      const email = addressOf(answer)
      if (!email) continue
      const partstat = (param(answer, 'PARTSTAT') ?? 'NEEDS-ACTION').trim().toUpperCase()
      const delegatedTo = answer.params['DELEGATED-TO']
      for (const span of into) {
        let found = false
        for (const i of ownProps(stored, span)) {
          const p = stored[i]!.parsed!
          if (p.name !== 'ATTENDEE' || !sameAddress(p, email)) continue
          found = true
          const params: Record<string, string[]> = { ...p.params, PARTSTAT: [partstat] }
          if (delegatedTo) params['DELEGATED-TO'] = delegatedTo
          const same =
            (param(p, 'PARTSTAT') ?? '').toUpperCase() === partstat &&
            (!delegatedTo || (p.params['DELEGATED-TO'] ?? []).join() === delegatedTo.join())
          if (same) continue
          stored[i] = { ...stored[i]!, text: lineOf({ ...p, params }) }
          changed = true
        }
        // someone who got the invitation through a list answered: they join the meeting
        if (!found) {
          const params = withoutParams(answer.params, [...SCHEDULE_PARAMS, 'RSVP'])
          inserts.push({
            at: propsEnd(stored, span),
            text: serializeLine('ATTENDEE', answer.value, { ...params, PARTSTAT: [partstat] }),
          })
          changed = true
        }
      }
    }
  })
  if (!changed) return null
  for (const { at, text } of inserts.sort((a, b) => b.at - a.at)) {
    stored.splice(at, 0, { text, parsed: null, path: [] })
  }
  return joinLines(stored)
}
