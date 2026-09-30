import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react'
import type { MailAccountInfo } from '../../shared/ipc'
import type {
  AddressSuggestion,
  Attendee,
  CalendarEvent,
  CalendarInfo,
  EventInput,
  Organizer,
} from '../../shared/pim'
import { IconCalendar, IconClose } from '../components/icons'
import {
  addDays,
  addMonths,
  buildRrule,
  combineLocal,
  dayKey,
  daysBetween,
  eventSpan,
  formatDay,
  fromIso,
  isValidDate,
  parseDayKey,
  parseRrule,
  repeatProblem,
  startOfDay,
  timeKey,
  toIso,
  weekdayNames,
  weekOrder,
  type RepeatKind,
  type RepeatRule,
} from './dates'
import {
  AttendeeStatusMark,
  IconAttendees,
  IconBell,
  IconClock,
  IconNotes,
  IconPin,
  IconRepeat,
  reminderLabel,
} from './EventDetails'
import type { CalT } from './i18n'

/**
 * Create or edit an event, Outlook-style: title, calendar, times, repeat,
 * reminder, location, attendees (with invitations sent from a mail account)
 * and notes. Esc closes, Ctrl/⌘+Enter saves. A failed save keeps the dialog
 * open with everything typed so far.
 */

export type EditorState =
  | { mode: 'create'; draft: Partial<EventInput> }
  | { mode: 'edit'; event: CalendarEvent; scope?: 'occurrence' | 'series' }

interface EventDialogProps {
  t: CalT
  lang: string
  weekStart: number
  state: EditorState
  calendars: CalendarInfo[]
  accounts: MailAccountInfo[]
  defaultCalendarId: string | null
  onDirtyChange?(dirty: boolean): void
  onClose(): void
  onSaved(event: CalendarEvent, invited: boolean): void
}

const REMINDER_PRESETS = [5, 15, 30, 60, 1440]
const DEFAULT_REMINDER = 15

export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function nextHalfHour(base: Date): Date {
  const d = new Date(base)
  d.setSeconds(0, 0)
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60)
  return d
}

// ---- attendee parsing ----

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:".][^\s@<>(),;:"]*$/

/** "Anna <anna@x.de>, bob@y.de; …" into addresses, plus whatever is not one */
export function parseAddressList(text: string): {
  valid: Array<{ name?: string; email: string }>
  invalid: string[]
} {
  const tokens: string[] = []
  let current = ''
  let quoted = false
  let angle = false
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    else if (ch === '<') angle = true
    else if (ch === '>') angle = false
    if ((ch === ',' || ch === ';' || ch === '\n') && !quoted && !angle) {
      tokens.push(current)
      current = ''
    } else current += ch
  }
  tokens.push(current)

  const valid: Array<{ name?: string; email: string }> = []
  const invalid: string[] = []
  for (const raw of tokens) {
    const token = raw.trim()
    if (!token) continue
    const named = /^(.*?)<\s*([^<>\s]+)\s*>$/.exec(token)
    if (named) {
      const email = named[2]!.replace(/^mailto:/i, '')
      const name = named[1]!
        .trim()
        .replace(/^"(.*)"$/, '$1')
        .trim()
      if (EMAIL.test(email)) valid.push(name ? { name, email } : { email })
      else invalid.push(token)
      continue
    }
    // "a@x.de b@y.de" pasted with spaces only
    for (const word of token.split(/\s+/)) {
      const email = word.replace(/^mailto:/i, '')
      if (EMAIL.test(email)) valid.push({ email })
      else invalid.push(word)
    }
  }
  return { valid, invalid }
}

// ---- initial values ----

interface Initial {
  title: string
  calendarId: string
  allDay: boolean
  start: Date
  /** exclusive */
  end: Date
  rrule?: string
  reminders: number[]
  location: string
  description: string
  attendees: Attendee[]
  organizer?: Organizer
  timezone?: string
}

function initialOf(state: EditorState, now: Date): Initial {
  if (state.mode === 'edit') {
    const ev = state.event
    const span = eventSpan(ev)
    return {
      title: ev.title,
      calendarId: ev.calendarId,
      allDay: ev.allDay,
      start: span.start,
      end: span.end,
      rrule: ev.rrule,
      reminders: ev.reminders,
      location: ev.location,
      description: ev.description,
      attendees: ev.attendees.map((a) => ({ ...a })),
      organizer: ev.organizer,
      timezone: ev.timezone,
    }
  }
  const d = state.draft
  const allDay = !!d.allDay
  let start = fromIso(d.start)
  if (!isValidDate(start)) start = allDay ? startOfDay(now) : nextHalfHour(now)
  if (allDay) start = startOfDay(start)
  let end = fromIso(d.end)
  if (allDay) {
    end = isValidDate(end) ? startOfDay(end) : end
    if (!isValidDate(end) || end <= start) end = addDays(start, 1)
  } else if (!isValidDate(end) || end < start) {
    end = new Date(start.getTime() + 60 * 60_000)
  }
  return {
    title: d.title ?? '',
    calendarId: d.calendarId ?? '',
    allDay,
    start,
    end,
    rrule: d.rrule ?? undefined,
    reminders: d.reminders ?? (allDay ? [] : [DEFAULT_REMINDER]),
    location: d.location ?? '',
    description: d.description ?? '',
    attendees: (d.attendees ?? []).map((a) => ({ ...a })),
    timezone: d.timezone,
  }
}

const REPEAT_KINDS: RepeatKind[] = ['none', 'daily', 'weekly', 'monthly', 'yearly']

export function EventDialog(props: EventDialogProps): ReactElement {
  const { t, lang, weekStart, state, calendars, accounts } = props
  const titleId = useId()
  const initial = useMemo(() => initialOf(state, new Date()), [state])
  const editing = state.mode === 'edit'
  const scope = state.mode === 'edit' ? state.scope : undefined
  const showRepeat = scope !== 'occurrence'
  const writable = calendars.filter((c) => !c.readOnly)

  const [title, setTitle] = useState(initial.title)
  const [calendarId, setCalendarId] = useState(initial.calendarId)
  const [allDay, setAllDay] = useState(initial.allDay)
  const [startDate, setStartDate] = useState(dayKey(initial.start))
  const [startTime, setStartTime] = useState(initial.allDay ? '09:00' : timeKey(initial.start))
  const [endDate, setEndDate] = useState(
    dayKey(initial.allDay ? addDays(initial.end, -1) : initial.end),
  )
  const [endTime, setEndTime] = useState(initial.allDay ? '10:00' : timeKey(initial.end))
  const [repeat, setRepeat] = useState<RepeatRule>(() => parseRrule(initial.rrule, initial.start))
  const [repeatTouched, setRepeatTouched] = useState(false)
  const [reminder, setReminder] = useState<number | null>(
    initial.reminders.length ? Math.min(...initial.reminders) : null,
  )
  const [remindersTouched, setRemindersTouched] = useState(false)
  const [location, setLocation] = useState(initial.location)
  const [description, setDescription] = useState(initial.description)
  const [attendees, setAttendees] = useState<Attendee[]>(initial.attendees)
  const [attendeeText, setAttendeeText] = useState('')
  const [suggestions, setSuggestions] = useState<AddressSuggestion[]>([])
  const [activeSuggestion, setActiveSuggestion] = useState(0)
  const [invite, setInvite] = useState(!editing)
  const inviteManual = useRef(false)
  const [inviteFrom, setInviteFrom] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const calendarTouched = useRef(false)
  const originalRepeat = useRef(repeat)

  const mine = useMemo(() => new Set(accounts.map((a) => a.email.toLowerCase())), [accounts])
  const organizer = initial.organizer
  const organizerIsMe = !organizer || mine.has(organizer.email.toLowerCase())
  const canEditAttendees = !editing || organizerIsMe || initial.attendees.length === 0

  // the calendar list may arrive after the dialog; new events go to the default one
  useEffect(() => {
    if (editing || calendarTouched.current) return
    if (writable.some((c) => c.id === calendarId)) return
    const fallback = writable.find((c) => c.id === props.defaultCalendarId) ?? writable[0]
    if (fallback) setCalendarId(fallback.id)
  }, [editing, writable, calendarId, props.defaultCalendarId])

  // invitations go out from the organizer's account when it is one of ours
  useEffect(() => {
    if (inviteFrom && accounts.some((a) => a.id === inviteFrom)) return
    const own =
      organizer && accounts.find((a) => a.email.toLowerCase() === organizer.email.toLowerCase())
    const pick = own ?? accounts[0]
    if (pick) setInviteFrom(pick.id)
  }, [accounts, organizer, inviteFrom])

  // ---- derived values ----

  const start = allDay ? parseDayKey(startDate) : combineLocal(startDate, startTime)
  const endExclusive = allDay ? addDays(parseDayKey(endDate), 1) : combineLocal(endDate, endTime)
  const problem = ((): string | null => {
    if (!isValidDate(start) || !isValidDate(endExclusive)) return t('invalidDate')
    if (endExclusive < start || (allDay && endExclusive <= start)) return t('endBeforeStart')
    if (showRepeat && repeatProblem(repeat, start)) return t('untilBeforeStart')
    if (!calendarId) return t('noWritableCalendar')
    return null
  })()

  const snapshot = JSON.stringify([
    title,
    calendarTouched.current ? calendarId : '',
    allDay,
    startDate,
    allDay ? '' : startTime,
    endDate,
    allDay ? '' : endTime,
    repeatTouched ? repeat : null,
    remindersTouched ? reminder : null,
    location,
    description,
    attendees,
    attendeeText.trim(),
  ])
  const initialSnapshot = useRef(snapshot)
  const dirty = snapshot !== initialSnapshot.current
  const onDirtyChange = props.onDirtyChange
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])

  // ---- field handlers ----

  /** moving the start keeps the length of the event, like Outlook */
  const moveStart = (date: string, time: string): void => {
    const oldStart = allDay ? parseDayKey(startDate) : combineLocal(startDate, startTime)
    const newStart = allDay ? parseDayKey(date) : combineLocal(date, time)
    setStartDate(date)
    setStartTime(time)
    if (!isValidDate(oldStart) || !isValidDate(newStart)) return
    if (allDay) {
      const oldEnd = parseDayKey(endDate)
      if (isValidDate(oldEnd) && oldEnd >= oldStart)
        setEndDate(dayKey(addDays(newStart, daysBetween(oldStart, oldEnd))))
    } else {
      const oldEnd = combineLocal(endDate, endTime)
      if (isValidDate(oldEnd) && oldEnd >= oldStart) {
        const end = new Date(newStart.getTime() + (oldEnd.getTime() - oldStart.getTime()))
        setEndDate(dayKey(end))
        setEndTime(timeKey(end))
      }
    }
    // a weekly series on the start's weekday follows the start to its new day
    if (
      repeat.kind === 'weekly' &&
      repeat.weekdays.length === 1 &&
      repeat.weekdays[0] === oldStart.getDay() &&
      newStart.getDay() !== oldStart.getDay()
    ) {
      setRepeat({ ...repeat, weekdays: [newStart.getDay()] })
      setRepeatTouched(true)
    }
  }

  const toggleAllDay = (on: boolean): void => {
    setAllDay(on)
    if (on) {
      // a timed event ending at midnight ends on the day before, as a whole day
      const s = parseDayKey(startDate)
      const e = parseDayKey(endDate)
      if (endTime === '00:00' && isValidDate(s) && isValidDate(e) && e > s)
        setEndDate(dayKey(addDays(e, -1)))
    }
  }

  const changeRepeat = (kind: RepeatKind): void => {
    setRepeatTouched(true)
    if (kind === 'custom') {
      setRepeat(originalRepeat.current)
      return
    }
    const weekdays =
      kind === 'weekly' && isValidDate(start)
        ? repeat.weekdays.length
          ? repeat.weekdays
          : [start.getDay()]
        : repeat.weekdays
    setRepeat({ ...repeat, kind, weekdays, raw: undefined })
  }

  const patchRepeat = (patch: Partial<RepeatRule>): void => {
    setRepeatTouched(true)
    setRepeat({ ...repeat, ...patch })
  }

  const addAttendees = (list: Array<{ name?: string; email: string }>): Attendee[] => {
    const known = new Set(attendees.map((a) => a.email.toLowerCase()))
    const added: Attendee[] = []
    for (const a of list) {
      const key = a.email.toLowerCase()
      if (known.has(key)) continue
      known.add(key)
      added.push({ ...(a.name ? { name: a.name } : {}), email: a.email, status: 'needs-action' })
    }
    if (!added.length) return attendees
    const next = [...attendees, ...added]
    setAttendees(next)
    if (!inviteManual.current) setInvite(true)
    return next
  }

  /** turn typed text into attendees; returns the full list and what could not be read */
  const commitText = (text: string): { list: Attendee[]; invalid: string[] } => {
    const parsed = parseAddressList(text)
    const list = addAttendees(parsed.valid)
    if (parsed.invalid.length) {
      setAttendeeText(parsed.invalid.join(', '))
      setError(t('invalidAttendee', { value: parsed.invalid[0]! }))
    } else {
      setAttendeeText('')
      if (text.trim()) setError('')
    }
    return { list, invalid: parsed.invalid }
  }

  // address suggestions from contacts and recent recipients
  useEffect(() => {
    const query = attendeeText.trim()
    if (query.length < 2 || !canEditAttendees) {
      setSuggestions([])
      return
    }
    let live = true
    const timer = setTimeout(() => {
      window.pimApi
        .suggestAddresses(query, 6)
        .then((list) => {
          if (!live) return
          const known = new Set(attendees.map((a) => a.email.toLowerCase()))
          setSuggestions(list.filter((s) => !known.has(s.email.toLowerCase())))
          setActiveSuggestion(0)
        })
        .catch(() => undefined)
    }, 150)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [attendeeText, attendees, canEditAttendees])

  const pickSuggestion = (s: AddressSuggestion): void => {
    addAttendees([{ ...(s.name ? { name: s.name } : {}), email: s.email }])
    setAttendeeText('')
    setSuggestions([])
  }

  // ---- saving ----

  const close = (): void => {
    if (dirty && !window.confirm(t('discardChanges'))) return
    props.onClose()
  }

  const save = async (): Promise<void> => {
    if (saving) return
    const committed = canEditAttendees ? commitText(attendeeText) : { list: attendees, invalid: [] }
    if (committed.invalid.length) return
    if (problem) {
      setError(problem)
      return
    }
    const list = canEditAttendees ? committed.list : initial.attendees
    const input: EventInput = {
      calendarId,
      title: title.trim(),
      location: location.trim(),
      description,
      start: toIso(start, allDay),
      end: toIso(endExclusive, allDay),
      allDay,
      reminders:
        editing && !remindersTouched ? initial.reminders : reminder === null ? [] : [reminder],
      attendees: list,
      // an existing event keeps the zone it was written in, so its series keeps
      // following that zone's DST rules; new events use this computer's zone
      timezone: (editing && initial.timezone) || browserTimeZone(),
    }
    if (state.mode === 'edit') {
      input.uid = state.event.uid
      if (scope === 'occurrence') {
        input.scope = 'occurrence'
        input.occurrenceStart = state.event.occurrenceStart ?? state.event.start
      } else if (scope === 'series') {
        input.scope = 'series'
      }
    }
    if (showRepeat) {
      // an untouched rule is passed on verbatim unless its UNTIL must change type
      const untilType = allDay !== initial.allDay && /UNTIL=/i.test(initial.rrule ?? '')
      if (repeatTouched || (untilType && repeat.kind !== 'custom')) {
        const rrule = buildRrule(repeat, start, allDay)
        if (rrule || editing) input.rrule = rrule
      } else if (initial.rrule) {
        input.rrule = initial.rrule
      }
    }
    const invited = invite && canEditAttendees && list.length > 0 && !!inviteFrom
    if (invited) input.inviteFromAccountId = inviteFrom

    setSaving(true)
    setError('')
    try {
      const r = await window.pimApi.saveEvent(input)
      if (!r.ok || !r.value) {
        setError(r.error || t('saveFailed'))
        setSaving(false)
        return
      }
      props.onSaved(r.value, invited)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  // ---- render ----

  const heading =
    state.mode === 'create'
      ? t('newEventLong')
      : scope === 'occurrence'
        ? t('editOccurrence')
        : scope === 'series'
          ? t('editSeries')
          : t('editEvent')
  const calendarOptions = editing ? calendars.filter((c) => c.id === calendarId) : writable
  const currentColor = calendars.find((c) => c.id === calendarId)?.color
  const shortNames = weekdayNames(lang, 'short')
  const longNames = weekdayNames(lang, 'long')
  const startForLabels = isValidDate(start) ? start : initial.start
  const reminderOptions = [...REMINDER_PRESETS]
  if (reminder !== null && !reminderOptions.includes(reminder)) reminderOptions.push(reminder)
  reminderOptions.sort((a, b) => a - b)
  const zone = browserTimeZone()
  // a missing calendar is explained next to the calendar field instead
  const shownProblem = problem && calendarId ? problem : null
  const mod = navigator.platform.startsWith('Mac') ? '⌘' : lang.startsWith('de') ? 'Strg' : 'Ctrl'

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <form
        className="modal cal-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            close()
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            e.stopPropagation()
            void save()
          }
        }}
      >
        <header className="cal-editor-head">
          <h2 id={titleId}>{heading}</h2>
          <button
            type="button"
            className="icon-btn"
            title={t('cancel')}
            aria-label={t('cancel')}
            onClick={close}
          >
            <IconClose />
          </button>
        </header>

        <div className="cal-editor-body">
          <input
            className="cal-editor-title"
            value={title}
            placeholder={t('titlePlaceholder')}
            aria-label={t('title')}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              // Enter in the title saves, like Outlook's quick create
              if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
                e.preventDefault()
                void save()
              }
            }}
          />

          <div className="cal-field">
            <span className="cal-field-icon" style={{ color: currentColor }}>
              <IconCalendar size={16} />
            </span>
            {writable.length === 0 && !editing ? (
              <p className="cal-field-note">{t('noWritableCalendar')}</p>
            ) : (
              <select
                aria-label={t('calendar')}
                value={calendarId}
                disabled={editing}
                onChange={(e) => {
                  calendarTouched.current = true
                  setCalendarId(e.target.value)
                }}
              >
                {calendarOptions.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="cal-field cal-field-top">
            <span className="cal-field-icon">
              <IconClock />
            </span>
            <div className="cal-when">
              <div className="cal-when-row">
                <span className="cal-when-label">{t('start')}</span>
                <input
                  type="date"
                  aria-label={t('startDate')}
                  value={startDate}
                  required
                  onChange={(e) => moveStart(e.target.value, startTime)}
                />
                {!allDay && (
                  <input
                    type="time"
                    aria-label={t('startTime')}
                    value={startTime}
                    step={300}
                    required
                    onChange={(e) => moveStart(startDate, e.target.value)}
                  />
                )}
              </div>
              <div className="cal-when-row">
                <span className="cal-when-label">{t('end')}</span>
                <input
                  type="date"
                  aria-label={t('endDate')}
                  value={endDate}
                  min={startDate}
                  required
                  onChange={(e) => setEndDate(e.target.value)}
                />
                {!allDay && (
                  <input
                    type="time"
                    aria-label={t('endTime')}
                    value={endTime}
                    step={300}
                    required
                    onChange={(e) => setEndTime(e.target.value)}
                  />
                )}
              </div>
              <label className="cal-check cal-when-allday">
                <input
                  type="checkbox"
                  checked={allDay}
                  onChange={(e) => toggleAllDay(e.target.checked)}
                />
                <span>{t('allDay')}</span>
              </label>
              {initial.timezone && initial.timezone !== zone && !allDay && (
                <p className="cal-field-note cal-when-note">
                  {t('timezoneNote', { zone: initial.timezone })}
                </p>
              )}
            </div>
          </div>

          {showRepeat && (
            <div className="cal-field cal-field-top">
              <span className="cal-field-icon">
                <IconRepeat />
              </span>
              <div className="cal-repeat">
                <select
                  aria-label={t('repeat')}
                  value={repeat.kind}
                  onChange={(e) => changeRepeat(e.target.value as RepeatKind)}
                >
                  {REPEAT_KINDS.map((kind) => (
                    <option key={kind} value={kind}>
                      {kind === 'none'
                        ? `${t('repeat')}: ${t('presetNone')}`
                        : kind === 'daily'
                          ? t('repeatDaily')
                          : kind === 'weekly'
                            ? t('repeatWeekly')
                            : kind === 'monthly'
                              ? t('repeatMonthly', { day: String(startForLabels.getDate()) })
                              : t('repeatYearly', {
                                  date: formatDay(startForLabels, lang, 'short'),
                                })}
                    </option>
                  ))}
                  {originalRepeat.current.kind === 'custom' && (
                    <option value="custom">{t('repeatCustom')}</option>
                  )}
                </select>

                {repeat.kind === 'weekly' && (
                  <div className="cal-weekdays" role="group" aria-label={t('repeatOn')}>
                    {weekOrder(weekStart).map((d) => {
                      const on = repeat.weekdays.includes(d)
                      return (
                        <button
                          key={d}
                          type="button"
                          className={on ? 'on' : undefined}
                          aria-pressed={on}
                          title={longNames[d]}
                          onClick={() => {
                            const next = on
                              ? repeat.weekdays.filter((x) => x !== d)
                              : [...repeat.weekdays, d]
                            if (next.length) patchRepeat({ weekdays: next })
                          }}
                        >
                          {shortNames[d]}
                        </button>
                      )
                    })}
                  </div>
                )}

                {repeat.kind === 'custom' && (
                  <div className="cal-custom-rule">
                    <code>{repeat.raw}</code>
                    <p className="cal-field-note">{t('customRuleNote')}</p>
                  </div>
                )}

                {repeat.kind !== 'none' && repeat.kind !== 'custom' && (
                  <div className="cal-ends" role="radiogroup" aria-label={t('ends')}>
                    <span className="cal-ends-label">{t('ends')}</span>
                    <label className="cal-check">
                      <input
                        type="radio"
                        name="cal-ends"
                        checked={repeat.ends === 'never'}
                        onChange={() => patchRepeat({ ends: 'never' })}
                      />
                      <span>{t('endsNever')}</span>
                    </label>
                    <label className="cal-check">
                      <input
                        type="radio"
                        name="cal-ends"
                        checked={repeat.ends === 'on'}
                        onChange={() =>
                          patchRepeat({
                            ends: 'on',
                            until:
                              repeat.until ||
                              dayKey(addMonths(isValidDate(start) ? start : initial.start, 3)),
                          })
                        }
                      />
                      <span>{t('endsOn')}</span>
                      <input
                        type="date"
                        aria-label={t('endsOn')}
                        value={repeat.until}
                        min={startDate}
                        disabled={repeat.ends !== 'on'}
                        onChange={(e) => patchRepeat({ until: e.target.value })}
                      />
                    </label>
                    <label className="cal-check">
                      <input
                        type="radio"
                        name="cal-ends"
                        checked={repeat.ends === 'after'}
                        onChange={() => patchRepeat({ ends: 'after' })}
                      />
                      <span>{t('endsAfter')}</span>
                      <input
                        type="number"
                        aria-label={t('occurrences')}
                        className="cal-count"
                        min={1}
                        max={999}
                        value={repeat.count}
                        disabled={repeat.ends !== 'after'}
                        onChange={(e) => patchRepeat({ count: Number(e.target.value) || 1 })}
                      />
                      <span>{t('occurrences')}</span>
                    </label>
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="cal-field">
            <span className="cal-field-icon">
              <IconBell />
            </span>
            <select
              aria-label={t('reminder')}
              value={reminder === null ? 'none' : String(reminder)}
              onChange={(e) => {
                setRemindersTouched(true)
                setReminder(e.target.value === 'none' ? null : Number(e.target.value))
              }}
            >
              <option value="none">
                {t('reminder')}: {t('reminderNone')}
              </option>
              {reminderOptions.map((m) => (
                <option key={m} value={String(m)}>
                  {reminderLabel(m, t)}
                </option>
              ))}
            </select>
          </div>

          <div className="cal-field">
            <span className="cal-field-icon">
              <IconPin />
            </span>
            <input
              value={location}
              placeholder={t('locationPlaceholder')}
              aria-label={t('location')}
              onChange={(e) => setLocation(e.target.value)}
            />
          </div>

          <div className="cal-field cal-field-top">
            <span className="cal-field-icon">
              <IconAttendees />
            </span>
            <div className="cal-attendees">
              <ul className="cal-att-list" aria-label={t('attendees')}>
                {attendees.map((a) => (
                  <li key={a.email.toLowerCase()} className="cal-att-chip" title={a.email}>
                    {editing && <AttendeeStatusMark status={a.status} t={t} />}
                    <span className="cal-att-name">{a.name || a.email}</span>
                    {canEditAttendees && (
                      <button
                        type="button"
                        aria-label={t('removeAttendee', { name: a.name || a.email })}
                        title={t('removeAttendee', { name: a.name || a.email })}
                        onClick={() => setAttendees(attendees.filter((x) => x !== a))}
                      >
                        ×
                      </button>
                    )}
                  </li>
                ))}
                {canEditAttendees && (
                  <li className="cal-att-input">
                    <input
                      value={attendeeText}
                      aria-label={t('attendees')}
                      aria-autocomplete="list"
                      placeholder={attendees.length ? '' : t('attendeesPlaceholder')}
                      spellCheck={false}
                      onChange={(e) => {
                        const value = e.target.value
                        const cut = Math.max(value.lastIndexOf(','), value.lastIndexOf(';'))
                        // commit what precedes a separator unless it is inside quotes or <…>
                        if (
                          cut >= 0 &&
                          parseAddressList(value.slice(0, cut)).invalid.length === 0
                        ) {
                          commitText(value.slice(0, cut))
                          setAttendeeText(value.slice(cut + 1).trimStart())
                        } else {
                          setAttendeeText(value)
                        }
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'ArrowDown' && suggestions.length) {
                          e.preventDefault()
                          setActiveSuggestion((i) => (i + 1) % suggestions.length)
                        } else if (e.key === 'ArrowUp' && suggestions.length) {
                          e.preventDefault()
                          setActiveSuggestion(
                            (i) => (i - 1 + suggestions.length) % suggestions.length,
                          )
                        } else if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey) {
                          e.preventDefault()
                          const pick = suggestions[activeSuggestion]
                          if (pick) pickSuggestion(pick)
                          else commitText(attendeeText)
                        } else if (e.key === 'Escape' && suggestions.length) {
                          e.stopPropagation()
                          setSuggestions([])
                        } else if (e.key === 'Backspace' && !attendeeText && attendees.length) {
                          setAttendees(attendees.slice(0, -1))
                        }
                      }}
                      onBlur={() => {
                        if (attendeeText.trim()) commitText(attendeeText)
                        setSuggestions([])
                      }}
                    />
                  </li>
                )}
              </ul>
              {suggestions.length > 0 && (
                <ul className="cal-suggest" role="listbox">
                  {suggestions.map((s, i) => (
                    <li
                      key={s.email}
                      role="option"
                      aria-selected={i === activeSuggestion}
                      className={i === activeSuggestion ? 'active' : undefined}
                      // mousedown, so the input does not lose focus (and commit) first
                      onMouseDown={(e) => {
                        e.preventDefault()
                        pickSuggestion(s)
                      }}
                    >
                      <span className="cal-suggest-name">{s.name || s.email}</span>
                      {s.name && <span className="cal-suggest-mail">{s.email}</span>}
                    </li>
                  ))}
                </ul>
              )}
              {!canEditAttendees && organizer && (
                <p className="cal-field-note">
                  {t('organizerOnly', { name: organizer.name || organizer.email })}
                </p>
              )}
              {canEditAttendees && attendees.length > 0 && accounts.length > 0 && (
                <div className="cal-invite">
                  <label className="cal-check">
                    <input
                      type="checkbox"
                      checked={invite}
                      onChange={(e) => {
                        inviteManual.current = true
                        setInvite(e.target.checked)
                      }}
                    />
                    <span>{t('sendInvites')}</span>
                  </label>
                  <select
                    aria-label={t('sendInvites')}
                    value={inviteFrom}
                    disabled={!invite}
                    onChange={(e) => setInviteFrom(e.target.value)}
                  >
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.email}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          </div>

          <div className="cal-field cal-field-top">
            <span className="cal-field-icon">
              <IconNotes />
            </span>
            <textarea
              value={description}
              rows={5}
              placeholder={t('description')}
              aria-label={t('description')}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
        </div>

        {(error || shownProblem) && (
          <p className="cal-editor-error" role="alert">
            {error || shownProblem}
          </p>
        )}

        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={close}>
            {t('cancel')}
          </button>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={saving || !!problem}
            title={t('saveShortcut', { key: mod })}
          >
            {saving ? t('saving') : t('save')}
          </button>
        </div>
      </form>
    </div>
  )
}
