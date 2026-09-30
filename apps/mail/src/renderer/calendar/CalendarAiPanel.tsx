import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import type { CalendarEvent, EventInput } from '../../shared/pim'
import { AiUnconfiguredError, runAi, type AiRun } from '../ai'
import { IconClose, SuiteMark } from '../components/icons'
import {
  agendaPrompt,
  eventDraftPrompt,
  findFreeSlots,
  meetingPrepPrompt,
  parseEventDraft,
} from './ai-calendar'
import {
  aiTranslator,
  describeRrule,
  formatDayLabel,
  formatTimeRange,
  formatWhen,
  type CalendarAiKey,
} from './ai-i18n'
import type { CalendarAiContext } from './types'
import './ai.css'

/**
 * Suite AI beside the calendar: type an appointment in your own words and get
 * a prefilled event, ask what is coming up, find free time (no AI — plain
 * arithmetic over the calendar) or prepare the selected meeting.
 */

type Busy = null | 'draft' | 'text'
type Output = { kind: 'agenda' | 'prep'; text: string }

interface FreeTime {
  loading: boolean
  events: CalendarEvent[]
  from: string
  to: string
  error?: string
}

const DURATIONS: Array<[number, CalendarAiKey]> = [
  [30, 'dur30'],
  [60, 'dur60'],
  [90, 'dur90'],
  [120, 'dur120'],
]

function systemZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function CalendarAiPanel({
  ctx,
  onClose,
}: {
  ctx: CalendarAiContext
  onClose(): void
}): ReactElement {
  const lang = ctx.lang
  const t = useMemo(() => aiTranslator(lang), [lang])
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState<Partial<EventInput> | null>(null)
  const [output, setOutput] = useState<Output | null>(null)
  const [free, setFree] = useState<FreeTime | null>(null)
  const [duration, setDuration] = useState(60)
  const run = useRef<AiRun | null>(null)
  const freeRequest = useRef(0)

  useEffect(() => () => run.current?.cancel(), [])

  const failure = (err: unknown): string =>
    err instanceof AiUnconfiguredError
      ? t('noModel')
      : err instanceof Error
        ? err.message
        : String(err)

  const withCalendar = (fields: Partial<EventInput>): Partial<EventInput> =>
    ctx.defaultCalendarId && !fields.calendarId
      ? { calendarId: ctx.defaultCalendarId, ...fields }
      : fields

  const stop = (): void => {
    run.current?.cancel()
    run.current = null
    setBusy(null)
  }

  const streamText = (kind: Output['kind'], p: { system: string; user: string }): void => {
    run.current?.cancel()
    setError('')
    setDraft(null)
    setBusy('text')
    setOutput({ kind, text: '' })
    const current = runAi(p.system, p.user, (text) => {
      if (run.current === current) setOutput({ kind, text })
    })
    run.current = current
    current.done
      .then((text) => {
        if (run.current === current) setOutput({ kind, text })
      })
      .catch((err: unknown) => {
        if (run.current !== current) return
        setOutput((o) => (o?.text ? o : null))
        setError(failure(err))
      })
      .finally(() => {
        if (run.current === current) {
          run.current = null
          setBusy(null)
        }
      })
  }

  const recognize = (): void => {
    const text = prompt.trim()
    if (!text || busy) return
    run.current?.cancel()
    setError('')
    setDraft(null)
    setOutput(null)
    setBusy('draft')
    const nowIso = new Date().toISOString()
    const zone = systemZone()
    const p = eventDraftPrompt(text, nowIso, zone, lang)
    // the JSON is not worth watching: the panel waits and shows the result
    const current = runAi(p.system, p.user, () => undefined)
    run.current = current
    current.done
      .then((answer) => {
        if (run.current !== current) return
        const parsed = parseEventDraft(answer, nowIso, zone)
        if (!parsed) {
          setError(t('draftFailed'))
          return
        }
        setDraft(withCalendar(parsed))
        setPrompt('')
      })
      .catch((err: unknown) => {
        if (run.current === current) setError(failure(err))
      })
      .finally(() => {
        if (run.current === current) {
          run.current = null
          setBusy(null)
        }
      })
  }

  const agenda = (): void => {
    if (!ctx.events.length) {
      run.current?.cancel()
      run.current = null
      setError('')
      setDraft(null)
      setOutput({ kind: 'agenda', text: t('agendaEmpty') })
      return
    }
    streamText('agenda', agendaPrompt(ctx.events, ctx.visibleRange, lang))
  }

  const prepare = (): void => {
    if (ctx.selectedEvent) streamText('prep', meetingPrepPrompt(ctx.selectedEvent, lang))
  }

  const loadFree = (): void => {
    const id = ++freeRequest.current
    const now = new Date()
    const from = now.toISOString()
    const to = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 7).toISOString()
    setFree({ loading: true, events: [], from, to })
    ctx
      .loadEvents(from, to)
      .then((events) => {
        if (freeRequest.current === id)
          setFree({ loading: false, events: Array.isArray(events) ? events : [], from, to })
      })
      .catch((err: unknown) => {
        if (freeRequest.current === id)
          setFree({ loading: false, events: [], from, to, error: failure(err) })
      })
  }

  const toggleFree = (): void => {
    if (free) {
      freeRequest.current++
      setFree(null)
    } else loadFree()
  }

  // slots grouped by local day, with that day's all-day events as a hint:
  // findFreeSlots does not let them block time
  const freeDays = useMemo(() => {
    if (!free || free.loading || free.error) return []
    const days = new Map<string, { label: string; slots: Array<{ start: string; end: string }> }>()
    for (const slot of findFreeSlots(free.events, free.from, free.to, duration)) {
      const d = new Date(slot.start)
      const key = localDayKey(d)
      let day = days.get(key)
      if (!day) {
        day = { label: formatDayLabel(d, lang), slots: [] }
        days.set(key, day)
      }
      day.slots.push(slot)
    }
    return [...days].map(([key, day]) => ({
      key,
      ...day,
      allDay: free.events
        .filter(
          (e) =>
            e.allDay &&
            e.status !== 'cancelled' &&
            typeof e.start === 'string' &&
            typeof e.end === 'string' &&
            e.start.slice(0, 10) <= key &&
            e.end.slice(0, 10) > key,
        )
        .map((e) => (typeof e.title === 'string' && e.title.trim()) || t('untitled')),
    }))
  }, [free, duration, lang, t])

  const durationLabel = t(DURATIONS.find(([m]) => m === duration)?.[1] ?? 'dur60')

  const onPanelKey = (e: KeyboardEvent<HTMLElement>): void => {
    // Esc stops a running answer; typing never reaches a shortcut here
    if (e.key === 'Escape' && busy) {
      e.stopPropagation()
      stop()
    }
  }

  return (
    <aside
      className="ai-panel-mail cal-ai-panel"
      aria-label={t('panelTitle')}
      onKeyDown={onPanelKey}
    >
      <header className="ai-head">
        <SuiteMark size={20} />
        <span>{t('panelTitle')}</span>
        <button type="button" className="icon-btn" title={t('close')} onClick={onClose}>
          <IconClose />
        </button>
      </header>

      <div className="ai-body">
        <p className="ai-hint">
          {t('hint')}
          <br />
          <span className="cal-ai-example">{t('example')}</span>
        </p>

        <div className="ai-chips">
          <button type="button" disabled={busy !== null} onClick={agenda}>
            {t('chipAgenda')}
          </button>
          <button type="button" aria-pressed={free !== null} onClick={toggleFree}>
            {t('chipFreeTime')}
          </button>
          <button
            type="button"
            disabled={busy !== null || !ctx.selectedEvent}
            title={ctx.selectedEvent ? undefined : t('prepNeedsEvent')}
            onClick={prepare}
          >
            {t('chipPrep')}
          </button>
        </div>

        {free && (
          <section className="cal-ai-free" aria-label={t('chipFreeTime')}>
            <div className="cal-ai-free-head">
              <label>
                <span>{t('freeDuration')}</span>
                <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
                  {DURATIONS.map(([minutes, key]) => (
                    <option key={minutes} value={minutes}>
                      {t(key)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {free.loading ? (
              <p className="cal-ai-muted">{t('freeLoading')}</p>
            ) : free.error ? (
              <p className="ai-error">{t('freeLoadFailed', { error: free.error })}</p>
            ) : freeDays.length === 0 ? (
              <p className="cal-ai-muted">{t('freeNone', { duration: durationLabel })}</p>
            ) : (
              <>
                <p className="cal-ai-muted">{t('freeHint')}</p>
                {freeDays.map((day) => (
                  <div className="cal-ai-day" key={day.key}>
                    <div className="cal-ai-day-label">{day.label}</div>
                    {day.allDay.length > 0 && (
                      <div className="cal-ai-day-note">
                        {t('freeAllDay', { titles: day.allDay.join(', ') })}
                      </div>
                    )}
                    <div className="cal-ai-slots">
                      {day.slots.map((slot) => (
                        <button
                          type="button"
                          key={slot.start}
                          onClick={() =>
                            ctx.openNewEvent(
                              withCalendar({
                                start: slot.start,
                                end: slot.end,
                                allDay: false,
                                timezone: systemZone(),
                              }),
                            )
                          }
                        >
                          {formatTimeRange(slot.start, slot.end, lang)}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </>
            )}
          </section>
        )}

        {error && <p className="ai-error">{error}</p>}

        {busy === 'draft' && (
          <div className="ai-output">
            <p className="ai-thinking">{t('reading')}</p>
            <div className="ai-output-actions">
              <button type="button" className="btn" onClick={stop}>
                {t('stop')}
              </button>
            </div>
          </div>
        )}

        {draft && (
          <div className="ai-output cal-ai-draft">
            <div className="cal-ai-draft-title">{draft.title?.trim() || t('untitled')}</div>
            <dl className="cal-ai-facts">
              <dt>{t('when')}</dt>
              <dd>{formatWhen(draft.start ?? '', draft.end ?? '', draft.allDay === true, lang)}</dd>
              {draft.rrule && (
                <>
                  <dt>{t('repeats')}</dt>
                  <dd>{describeRrule(draft.rrule, lang)}</dd>
                </>
              )}
              {draft.location && (
                <>
                  <dt>{t('where')}</dt>
                  <dd>{draft.location}</dd>
                </>
              )}
              {draft.attendees && draft.attendees.length > 0 && (
                <>
                  <dt>{t('who')}</dt>
                  <dd>{draft.attendees.map((a) => a.name || a.email).join(', ')}</dd>
                </>
              )}
            </dl>
            {draft.description && <div className="cal-ai-draft-notes">{draft.description}</div>}
            <div className="ai-output-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  ctx.openNewEvent(draft)
                  setDraft(null)
                }}
              >
                {t('draftCreate')}
              </button>
              <button type="button" className="btn" onClick={() => setDraft(null)}>
                {t('draftDiscard')}
              </button>
            </div>
          </div>
        )}

        {output && (
          <div className="ai-output">
            {busy === 'text' && !output.text && <p className="ai-thinking">{t('thinking')}</p>}
            {output.text && <div className="ai-text">{output.text}</div>}
            <div className="ai-output-actions">
              {busy === 'text' ? (
                <button type="button" className="btn" onClick={stop}>
                  {t('stop')}
                </button>
              ) : (
                output.text && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      void navigator.clipboard?.writeText(output.text).catch(() => undefined)
                    }
                  >
                    {t('copy')}
                  </button>
                )
              )}
            </div>
          </div>
        )}
      </div>

      <form
        className="ai-prompt"
        onSubmit={(e) => {
          e.preventDefault()
          recognize()
        }}
      >
        <textarea
          value={prompt}
          rows={2}
          aria-label={t('promptPlaceholder')}
          placeholder={t('promptPlaceholder')}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              recognize()
            }
          }}
        />
        <button
          type="submit"
          className="btn btn-ai"
          title={t('promptSubmit')}
          aria-label={t('promptSubmit')}
          disabled={busy !== null || !prompt.trim()}
        >
          ↵
        </button>
      </form>
    </aside>
  )
}
