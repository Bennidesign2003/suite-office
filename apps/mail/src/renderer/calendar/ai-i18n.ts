import type { Translate } from './types'

/**
 * Strings of the calendar's Suite AI panel and of the invitation card in a
 * mail, plus the localized date and recurrence phrases both show. German and
 * English are complete; every other UI language falls back to English (`de`
 * defines the key set), like the mail strings.
 */

const de = {
  // panel
  panelTitle: 'Suite AI',
  close: 'Schließen',
  hint: 'Beschreibe einen Termin in eigenen Worten oder wähle eine Aktion.',
  example: 'Zum Beispiel: „Zahnarzt Donnerstag 15 Uhr in der Hauptstraße“',
  chipAgenda: 'Was steht an?',
  chipFreeTime: 'Freie Zeit finden',
  chipPrep: 'Meeting vorbereiten',
  prepNeedsEvent: 'Wähle zuerst einen Termin im Kalender aus.',
  promptPlaceholder: 'Termin beschreiben …',
  promptSubmit: 'Termin erkennen',
  reading: 'Suite AI liest den Termin …',
  thinking: 'Suite AI schreibt …',
  draftCreate: 'Termin anlegen',
  draftDiscard: 'Verwerfen',
  draftFailed:
    'Daraus ließ sich kein Termin ablesen. Nenne mindestens den Tag, z. B. „morgen 10 Uhr Friseur“.',
  agendaEmpty: 'Im angezeigten Zeitraum stehen keine Termine an.',
  freeDuration: 'Dauer',
  dur30: '30 Minuten',
  dur60: '1 Stunde',
  dur90: '1,5 Stunden',
  dur120: '2 Stunden',
  freeHint:
    'Freie Zeiten der nächsten 7 Tage, Mo–Fr 8–18 Uhr. Klicke eine Zeit an, um dort einen Termin anzulegen.',
  freeLoading: 'Suche freie Zeiten …',
  freeNone: 'In den nächsten 7 Tagen ist Mo–Fr zwischen 8 und 18 Uhr kein Platz für {duration}.',
  freeAllDay: 'Ganztägig: {titles}',
  freeLoadFailed: 'Die Termine konnten nicht geladen werden: {error}',
  copy: 'Kopieren',
  stop: 'Stopp',
  noModel:
    'Kein KI-Modell ausgewählt. Wähle in den Einstellungen unter „KI-Modell“ ein Ollama-Modell.',
  // shared by the draft summary and the invitation card
  when: 'Wann',
  where: 'Wo',
  who: 'Wer',
  repeats: 'Wiederholung',
  allDay: 'ganztägig',
  untitled: '(ohne Titel)',
  // invitation card
  kindRequest: 'Einladung',
  kindCancel: 'Absage',
  kindReply: 'Antwort auf deine Einladung',
  kindPublish: 'Termin',
  kindCounter: 'Gegenvorschlag',
  kindRefresh: 'Aktualisierungsanfrage',
  organizer: 'Organisator',
  attendees: 'Teilnehmer ({n})',
  optional: 'optional',
  statusAccepted: 'Zugesagt',
  statusDeclined: 'Abgelehnt',
  statusTentative: 'Mit Vorbehalt',
  statusNeedsAction: 'Keine Antwort',
  tallyAccepted: '{n} zugesagt',
  tallyDeclined: '{n} abgelehnt',
  tallyTentative: '{n} mit Vorbehalt',
  tallyPending: '{n} ohne Antwort',
  showAll: 'Alle {n} anzeigen',
  showLess: 'Weniger anzeigen',
  accept: 'Zusagen',
  tentative: 'Mit Vorbehalt',
  decline: 'Ablehnen',
  calendar: 'Kalender',
  alreadyIn: 'Bereits im Kalender „{name}“.',
  alreadyInSome: 'Bereits in deinem Kalender.',
  noWritableCalendar: 'Es gibt keinen Kalender, in den Suite Office schreiben darf.',
  openCalendar: 'Kalender öffnen',
  cancelled: 'Dieser Termin wurde abgesagt.',
  removeFromCalendar: 'Aus Kalender entfernen',
  cancelledNotInCalendar: 'Der Termin ist nicht in deinem Kalender.',
  replyAccepted: '{name} hat zugesagt.',
  replyDeclined: '{name} hat abgelehnt.',
  replyTentative: '{name} hat mit Vorbehalt zugesagt.',
  replyNeedsAction: '{name} hat noch nicht geantwortet.',
  replyRecorded: 'Die Antwort ist in deinem Kalender vermerkt.',
  someone: 'Ein Teilnehmer',
  publishAdd: 'Zum Kalender hinzufügen',
  counterInfo: '{name} schlägt eine andere Zeit vor.',
  refreshInfo: '{name} bittet um die aktuelle Fassung dieses Termins.',
  // recurrence in words
  rrDaily: 'täglich',
  rrEveryNDays: 'alle {n} Tage',
  rrWeekly: 'wöchentlich',
  rrEveryNWeeks: 'alle {n} Wochen',
  rrWeeklyOn: 'jeden {days}',
  rrEveryNWeeksOn: 'alle {n} Wochen am {days}',
  rrWorkdays: 'jeden Werktag (Mo–Fr)',
  rrMonthly: 'monatlich',
  rrEveryNMonths: 'alle {n} Monate',
  rrOnMonthDay: 'am {day}.',
  rrOnNth: 'am {nth} {day}',
  rrYearly: 'jährlich',
  rrEveryNYears: 'alle {n} Jahre',
  rrOnDate: 'am {date}',
  rrCount: '{n}-mal',
  rrUntil: 'bis {date}',
  rrCustom: 'wiederkehrend',
  nth1: 'ersten',
  nth2: 'zweiten',
  nth3: 'dritten',
  nth4: 'vierten',
  nth5: 'fünften',
  nthLast: 'letzten',
  nthSecondLast: 'vorletzten',
} as const

export type CalendarAiKey = keyof typeof de

const en: Record<CalendarAiKey, string> = {
  panelTitle: 'Suite AI',
  close: 'Close',
  hint: 'Describe an appointment in your own words or pick an action.',
  example: 'For example: “Dentist Thursday 3 pm on Main Street”',
  chipAgenda: 'What’s coming up?',
  chipFreeTime: 'Find free time',
  chipPrep: 'Prepare meeting',
  prepNeedsEvent: 'Select an event in the calendar first.',
  promptPlaceholder: 'Describe an appointment…',
  promptSubmit: 'Recognize appointment',
  reading: 'Suite AI is reading the appointment…',
  thinking: 'Suite AI is writing…',
  draftCreate: 'Create event',
  draftDiscard: 'Discard',
  draftFailed:
    'No appointment could be read from that. Name at least the day, e.g. “tomorrow 10 am haircut”.',
  agendaEmpty: 'Nothing is scheduled in the period shown.',
  freeDuration: 'Duration',
  dur30: '30 minutes',
  dur60: '1 hour',
  dur90: '1.5 hours',
  dur120: '2 hours',
  freeHint:
    'Free times in the next 7 days, Mon–Fri 8 am–6 pm. Click a time to create an event there.',
  freeLoading: 'Looking for free time…',
  freeNone: 'There is no room for {duration} Mon–Fri between 8 am and 6 pm in the next 7 days.',
  freeAllDay: 'All day: {titles}',
  freeLoadFailed: 'The events could not be loaded: {error}',
  copy: 'Copy',
  stop: 'Stop',
  noModel: 'No AI model selected. Pick an Ollama model under Settings → AI model.',
  when: 'When',
  where: 'Where',
  who: 'Who',
  repeats: 'Repeats',
  allDay: 'all day',
  untitled: '(no title)',
  kindRequest: 'Invitation',
  kindCancel: 'Cancellation',
  kindReply: 'Reply to your invitation',
  kindPublish: 'Event',
  kindCounter: 'New time proposed',
  kindRefresh: 'Update request',
  organizer: 'Organizer',
  attendees: 'Attendees ({n})',
  optional: 'optional',
  statusAccepted: 'Accepted',
  statusDeclined: 'Declined',
  statusTentative: 'Tentative',
  statusNeedsAction: 'No response',
  tallyAccepted: '{n} accepted',
  tallyDeclined: '{n} declined',
  tallyTentative: '{n} tentative',
  tallyPending: '{n} no response',
  showAll: 'Show all {n}',
  showLess: 'Show less',
  accept: 'Accept',
  tentative: 'Tentative',
  decline: 'Decline',
  calendar: 'Calendar',
  alreadyIn: 'Already in the calendar “{name}”.',
  alreadyInSome: 'Already in your calendar.',
  noWritableCalendar: 'There is no calendar Suite Office may write to.',
  openCalendar: 'Open calendar',
  cancelled: 'This event has been canceled.',
  removeFromCalendar: 'Remove from calendar',
  cancelledNotInCalendar: 'The event is not in your calendar.',
  replyAccepted: '{name} accepted.',
  replyDeclined: '{name} declined.',
  replyTentative: '{name} tentatively accepted.',
  replyNeedsAction: '{name} has not responded yet.',
  replyRecorded: 'The response has been recorded in your calendar.',
  someone: 'An attendee',
  publishAdd: 'Add to calendar',
  counterInfo: '{name} proposes a different time.',
  refreshInfo: '{name} asks for the current version of this event.',
  rrDaily: 'daily',
  rrEveryNDays: 'every {n} days',
  rrWeekly: 'weekly',
  rrEveryNWeeks: 'every {n} weeks',
  rrWeeklyOn: 'every {days}',
  rrEveryNWeeksOn: 'every {n} weeks on {days}',
  rrWorkdays: 'every weekday (Mon–Fri)',
  rrMonthly: 'monthly',
  rrEveryNMonths: 'every {n} months',
  rrOnMonthDay: 'on day {day}',
  rrOnNth: 'on the {nth} {day}',
  rrYearly: 'yearly',
  rrEveryNYears: 'every {n} years',
  rrOnDate: 'on {date}',
  rrCount: '{n} times',
  rrUntil: 'until {date}',
  rrCustom: 'repeats',
  nth1: 'first',
  nth2: 'second',
  nth3: 'third',
  nth4: 'fourth',
  nth5: 'fifth',
  nthLast: 'last',
  nthSecondLast: 'second-to-last',
}

const tables: Record<string, Record<CalendarAiKey, string>> = { de, en }

/** the table language: German or English (everything else reads English for now) */
function tableLang(lang: string): 'de' | 'en' {
  return (lang || '').slice(0, 2).toLowerCase() === 'de' ? 'de' : 'en'
}

export function aiTranslator(lang: string): Translate<CalendarAiKey> {
  const table = tables[tableLang(lang)] ?? en
  return (key, vars) => {
    let text = table[key] ?? en[key]
    if (vars) for (const [k, v] of Object.entries(vars)) text = text.split(`{${k}}`).join(v)
    return text
  }
}

// ---- dates ----

/** a locale Intl accepts: the UI language, else English */
function locale(lang: string): string {
  try {
    return Intl.getCanonicalLocales(lang)[0] ?? 'en'
  } catch {
    return 'en'
  }
}

function dateOnly(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value ?? '')
  if (!m) return null
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  return Number.isFinite(d.getTime()) ? d : null
}

function range(fmt: Intl.DateTimeFormat, a: Date, b: Date): string {
  try {
    return fmt.formatRange(a, b)
  } catch {
    return `${fmt.format(a)} – ${fmt.format(b)}`
  }
}

/**
 * "Donnerstag, 1. Oktober 2026, 15:00–16:00 Uhr", "Do., 1. – So., 4. Okt. 2026
 * · ganztägig" … Timed events show on the computer's clock; all-day dates are
 * calendar dates and never shift with the zone (end exclusive, as stored).
 * Unreadable values give an empty string instead of throwing.
 */
export function formatWhen(start: string, end: string, allDay: boolean, lang: string): string {
  const loc = locale(lang)
  const t = aiTranslator(lang)
  if (allDay) {
    const first = dateOnly(start)
    if (!first) return ''
    const after = dateOnly(end)
    const last =
      after && after.getTime() - first.getTime() > 86_400_000
        ? new Date(after.getTime() - 86_400_000)
        : first
    const text =
      last === first
        ? new Intl.DateTimeFormat(loc, {
            weekday: 'long',
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            timeZone: 'UTC',
          }).format(first)
        : range(
            new Intl.DateTimeFormat(loc, {
              weekday: 'short',
              day: 'numeric',
              month: 'short',
              year: 'numeric',
              timeZone: 'UTC',
            }),
            first,
            last,
          )
    return `${text} · ${t('allDay')}`
  }
  const s = new Date(start)
  if (!Number.isFinite(s.getTime())) return ''
  const e = new Date(end)
  const long = new Intl.DateTimeFormat(loc, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  if (!Number.isFinite(e.getTime()) || e.getTime() <= s.getTime()) return long.format(s)
  const sameDay = s.toDateString() === e.toDateString()
  return sameDay
    ? range(long, s, e)
    : range(
        new Intl.DateTimeFormat(loc, {
          weekday: 'short',
          day: 'numeric',
          month: 'short',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        }),
        s,
        e,
      )
}

/** "09:00–10:00" (or "9:00 – 10:00 AM") on the computer's clock */
export function formatTimeRange(start: string, end: string, lang: string): string {
  const s = new Date(start)
  const e = new Date(end)
  if (!Number.isFinite(s.getTime()) || !Number.isFinite(e.getTime())) return ''
  return range(new Intl.DateTimeFormat(locale(lang), { hour: '2-digit', minute: '2-digit' }), s, e)
}

/** "Donnerstag, 1. Oktober" for a local day */
export function formatDayLabel(date: Date, lang: string): string {
  return new Intl.DateTimeFormat(locale(lang), {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(date)
}

// ---- recurrence ----

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA']

function weekdayName(code: string, lang: string): string {
  const index = DAY_CODES.indexOf(code)
  // 2024-01-07 was a Sunday
  return new Intl.DateTimeFormat(lang, { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(2024, 0, 7 + Math.max(index, 0))),
  )
}

function list(items: string[], lang: string): string {
  try {
    return new Intl.ListFormat(lang, { type: 'conjunction' }).format(items)
  } catch {
    return items.join(', ')
  }
}

const NTH: Record<string, CalendarAiKey> = {
  '1': 'nth1',
  '2': 'nth2',
  '3': 'nth3',
  '4': 'nth4',
  '5': 'nth5',
  '-1': 'nthLast',
  '-2': 'nthSecondLast',
}

function untilDate(value: string, lang: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})(T(\d{2})(\d{2})(\d{2})(Z?))?$/.exec(value)
  if (!m) return ''
  const [, y, mo, d, time, h, mi, s, z] = m
  // a UTC end instant belongs to the local day it falls on; a date is just a date
  const date =
    time && z
      ? new Date(Date.UTC(+y!, +mo! - 1, +d!, +h!, +mi!, +s!))
      : new Date(Date.UTC(+y!, +mo! - 1, +d!))
  if (!Number.isFinite(date.getTime())) return ''
  return new Intl.DateTimeFormat(lang, {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    ...(time && z ? {} : { timeZone: 'UTC' }),
  }).format(date)
}

/**
 * The common RRULEs in words: "jeden Montag und Mittwoch", "every 2 weeks on
 * Friday, 10 times", "monatlich am ersten Montag", "yearly on October 1".
 * Anything unusual reads "wiederkehrend" / "repeats"; no rule gives "".
 */
export function describeRrule(rrule: string | null | undefined, lang: string): string {
  if (!rrule || typeof rrule !== 'string') return ''
  const words = tableLang(lang)
  const t = aiTranslator(words)
  const parts: Record<string, string> = {}
  for (const part of rrule
    .trim()
    .replace(/^RRULE:/i, '')
    .toUpperCase()
    .split(';')) {
    const eq = part.indexOf('=')
    if (eq > 0) parts[part.slice(0, eq)] = part.slice(eq + 1)
  }
  const n = Math.max(1, parseInt(parts.INTERVAL ?? '1', 10) || 1)
  const byDay = (parts.BYDAY ?? '').split(',').filter(Boolean)
  const plainDays = byDay.filter((d) => DAY_CODES.includes(d))
  const nthDay = byDay.length === 1 ? /^([+-]?\d)([A-Z]{2})$/.exec(byDay[0]!) : null
  const setPos = parts.BYSETPOS && /^-?\d$/.test(parts.BYSETPOS) ? parts.BYSETPOS : null
  const dayList = (codes: string[]): string =>
    list(
      codes.map((c) => weekdayName(c, words)),
      words,
    )
  const nthPhrase = (): string => {
    const pos = nthDay ? String(Number(nthDay[1])) : plainDays.length === 1 ? setPos : null
    const code = nthDay ? nthDay[2]! : plainDays[0]
    const key = pos ? NTH[pos] : undefined
    return key && code && DAY_CODES.includes(code)
      ? t('rrOnNth', { nth: t(key), day: weekdayName(code, words) })
      : ''
  }

  let text: string
  switch (parts.FREQ) {
    case 'DAILY':
      text = n > 1 ? t('rrEveryNDays', { n: String(n) }) : t('rrDaily')
      if (plainDays.length) text = t('rrWeeklyOn', { days: dayList(plainDays) })
      break
    case 'WEEKLY': {
      const workdays =
        plainDays.length === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every((d) => plainDays.includes(d))
      if (workdays && n === 1) text = t('rrWorkdays')
      else if (plainDays.length)
        text =
          n > 1
            ? t('rrEveryNWeeksOn', { n: String(n), days: dayList(plainDays) })
            : t('rrWeeklyOn', { days: dayList(plainDays) })
      else text = n > 1 ? t('rrEveryNWeeks', { n: String(n) }) : t('rrWeekly')
      break
    }
    case 'MONTHLY': {
      text = n > 1 ? t('rrEveryNMonths', { n: String(n) }) : t('rrMonthly')
      const monthDay =
        parts.BYMONTHDAY && /^\d{1,2}$/.test(parts.BYMONTHDAY) ? parts.BYMONTHDAY : null
      const detail = monthDay ? t('rrOnMonthDay', { day: String(Number(monthDay)) }) : nthPhrase()
      if (detail) text = `${text} ${detail}`
      break
    }
    case 'YEARLY': {
      text = n > 1 ? t('rrEveryNYears', { n: String(n) }) : t('rrYearly')
      const month = Number(parts.BYMONTH)
      const day = Number(parts.BYMONTHDAY)
      if (
        month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <= 31 &&
        /^\d+$/.test(parts.BYMONTHDAY ?? '')
      ) {
        const date = new Intl.DateTimeFormat(words, {
          day: 'numeric',
          month: 'long',
          timeZone: 'UTC',
        }).format(new Date(Date.UTC(2024, month - 1, day)))
        text = `${text} ${t('rrOnDate', { date })}`
      }
      break
    }
    default:
      return t('rrCustom')
  }
  const count = parts.COUNT && /^\d+$/.test(parts.COUNT) ? parts.COUNT : null
  if (count) text += `, ${t('rrCount', { n: count })}`
  else if (parts.UNTIL) {
    const date = untilDate(parts.UNTIL, words)
    if (date) text += `, ${t('rrUntil', { date })}`
  }
  return text
}
