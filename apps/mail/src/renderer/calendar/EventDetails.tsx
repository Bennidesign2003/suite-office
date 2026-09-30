import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { AttendeeStatus, CalendarEvent, CalendarInfo } from '../../shared/pim'
import { IconCalendar, IconClose, IconTrash } from '../components/icons'
import {
  eventSpan,
  formatDay,
  formatEventWhen,
  parseDayKey,
  parseRrule,
  weekdayNames,
  weekOrder,
} from './dates'
import type { CalendarStringKey, CalT } from './i18n'

// ---- icons the calendar views share (the mail set has no arrows, clocks or pins) ----

function Svg({ children, size = 16 }: { children: ReactNode; size?: number }): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      {children}
    </svg>
  )
}

export const IconArrowLeft = () => (
  <Svg size={18}>
    <path d="m12 4.5-5.5 5.5 5.5 5.5" />
  </Svg>
)
export const IconArrowRight = () => (
  <Svg size={18}>
    <path d="m8 4.5 5.5 5.5-5.5 5.5" />
  </Svg>
)
export const IconClock = () => (
  <Svg>
    <circle cx="10" cy="10" r="7" />
    <path d="M10 6v4.2l2.8 1.8" />
  </Svg>
)
export const IconPin = () => (
  <Svg>
    <path d="M10 17.5s5.5-5 5.5-9.5a5.5 5.5 0 0 0-11 0c0 4.5 5.5 9.5 5.5 9.5z" />
    <circle cx="10" cy="8" r="2" />
  </Svg>
)
export const IconRepeat = () => (
  <Svg size={14}>
    <path d="M4 9V8a3 3 0 0 1 3-3h8.5M13 2.5 15.5 5 13 7.5" />
    <path d="M16 11v1a3 3 0 0 1-3 3H4.5M7 17.5 4.5 15 7 12.5" />
  </Svg>
)
export const IconBell = () => (
  <Svg>
    <path d="M5 13.5V9a5 5 0 0 1 10 0v4.5l1.5 1.5h-13z" />
    <path d="M8.5 17a1.6 1.6 0 0 0 3 0" />
  </Svg>
)
export const IconAttendees = () => (
  <Svg>
    <circle cx="7.5" cy="7" r="3" />
    <path d="M2 16.5a5.5 5.5 0 0 1 11 0" />
    <path d="M13 4.2a3 3 0 0 1 0 5.6M15 12a5.5 5.5 0 0 1 3 4.5" />
  </Svg>
)
export const IconNotes = () => (
  <Svg>
    <path d="M4 5h12M4 10h12M4 15h8" />
  </Svg>
)
export const IconLink = () => (
  <Svg>
    <path d="M8.5 11.5a3.5 3.5 0 0 0 5 0l2.5-2.5a3.5 3.5 0 0 0-5-5l-1 1" />
    <path d="M11.5 8.5a3.5 3.5 0 0 0-5 0L4 11a3.5 3.5 0 0 0 5 5l1-1" />
  </Svg>
)
export const IconPencil = () => (
  <Svg>
    <path d="M13.5 3.5a1.8 1.8 0 0 1 2.5 2.5l-9 9-3.5 1 1-3.5z" />
  </Svg>
)
export const IconMore = () => (
  <Svg>
    <circle cx="4.5" cy="10" r="0.6" fill="currentColor" />
    <circle cx="10" cy="10" r="0.6" fill="currentColor" />
    <circle cx="15.5" cy="10" r="0.6" fill="currentColor" />
  </Svg>
)
export const IconSidebar = () => (
  <Svg size={18}>
    <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
    <path d="M7.5 3.5v13" />
  </Svg>
)
export const IconWarning = () => (
  <Svg size={14}>
    <path d="M10 2.5 17.5 16h-15zM10 8v3.5M10 13.8v.2" />
  </Svg>
)

// ---- text helpers ----

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"']+/gi

/** plain text with http(s) links made clickable (they open in the browser) */
export function Linkified({ text }: { text: string }): ReactElement {
  const parts: ReactNode[] = []
  let last = 0
  for (const match of text.matchAll(URL_PATTERN)) {
    let href = match[0]
    // a sentence's closing punctuation is not part of the link
    const trail = /[).,;:!?\]]+$/.exec(href)?.[0] ?? ''
    if (trail) href = href.slice(0, -trail.length)
    const at = match.index ?? 0
    if (at > last) parts.push(text.slice(last, at))
    parts.push(
      <a key={at} href={href} target="_blank" rel="noreferrer">
        {href}
      </a>,
    )
    last = at + href.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return <>{parts}</>
}

/** "15 Minuten vorher", "1 Tag vorher" … */
export function reminderLabel(minutes: number, t: CalT): string {
  const m = Math.abs(Math.round(minutes))
  if (m === 0) return t('reminderAtStart')
  if (m === 10080) return t('reminderWeek')
  if (m % 1440 === 0)
    return m === 1440 ? t('reminderDay') : t('reminderDays', { n: String(m / 1440) })
  if (m % 60 === 0) return m === 60 ? t('reminderHour') : t('reminderHours', { n: String(m / 60) })
  return t('reminderMinutes', { n: String(m) })
}

/** "Wöchentlich am Mo., Mi., bis 31. Dez. 2026" and the like; '' for single events */
export function describeRepeat(
  rrule: string | undefined,
  start: Date,
  lang: string,
  weekStart: number,
  t: CalT,
): string {
  const rule = parseRrule(rrule, start)
  let text: string
  switch (rule.kind) {
    case 'none':
      return ''
    case 'custom':
      return t('repeatCustom')
    case 'daily':
      text = t('repeatDaily')
      break
    case 'weekly': {
      const days = rule.weekdays
      if (days.join(',') === '1,2,3,4,5') text = t('repeatWorkdays')
      else {
        const names = weekdayNames(lang, days.length === 1 ? 'long' : 'short')
        const ordered = weekOrder(weekStart).filter((d) => days.includes(d))
        text = t('repeatWeeklyOn', { days: ordered.map((d) => names[d]).join(', ') })
      }
      break
    }
    case 'monthly':
      text = t('repeatMonthly', { day: String(start.getDate()) })
      break
    case 'yearly':
      text = t('repeatYearly', { date: formatDay(start, lang, 'short') })
      break
  }
  if (rule.ends === 'on') {
    text += `, ${t('repeatUntil', { date: formatDay(parseDayKey(rule.until), lang, 'medium') })}`
  } else if (rule.ends === 'after') {
    text += `, ${t('repeatTimes', { n: String(rule.count) })}`
  }
  return text
}

const STATUS_LABEL: Record<AttendeeStatus, CalendarStringKey> = {
  accepted: 'statusAccepted',
  declined: 'statusDeclined',
  tentative: 'statusTentative',
  'needs-action': 'statusNeedsAction',
}

const STATUS_MARK: Record<AttendeeStatus, string> = {
  accepted: '✓',
  declined: '✕',
  tentative: '?',
  'needs-action': '○',
}

export function AttendeeStatusMark({
  status,
  t,
}: {
  status: AttendeeStatus
  t: CalT
}): ReactElement {
  return (
    <span className={`cal-rsvp cal-rsvp-${status}`} title={t(STATUS_LABEL[status])}>
      <span aria-hidden>{STATUS_MARK[status]}</span>
      <span className="cal-sr">{t(STATUS_LABEL[status])}</span>
    </span>
  )
}

// ---- the popover ----

interface EventDetailsProps {
  t: CalT
  lang: string
  weekStart: number
  event: CalendarEvent
  calendar?: CalendarInfo
  /** the clicked block, to sit next to */
  anchor: DOMRect
  onClose(): void
  onEdit(): void
  onDelete(): void
}

export function EventDetails({
  t,
  lang,
  weekStart,
  event,
  calendar,
  anchor,
  onClose,
  onEdit,
  onDelete,
}: EventDetailsProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const close = useRef(onClose)
  close.current = onClose
  const titleId = useId()

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const gap = 8
    const w = el.offsetWidth
    const h = el.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let left = anchor.right + gap
    if (left + w > vw - gap) left = anchor.left - w - gap
    if (left < gap)
      left = Math.min(vw - w - gap, Math.max(gap, anchor.left + anchor.width / 2 - w / 2))
    const top = Math.max(gap, Math.min(anchor.top, vh - h - gap))
    setPos({ left: Math.max(gap, left), top })
    el.focus({ preventScroll: true })
  }, [anchor, event.id])

  // a click anywhere else closes it (a click on another event then opens that one)
  useEffect(() => {
    const onDown = (e: PointerEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) close.current()
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [])

  const span = eventSpan(event)
  const title = event.title.trim() || t('noTitle')
  const repeat = event.recurring
    ? describeRepeat(event.rrule, span.start, lang, weekStart, t) || t('recurringEvent')
    : ''
  const readOnly = event.readOnly || !!calendar?.readOnly
  const color = calendar?.color ?? 'currentColor'

  return (
    <div
      ref={ref}
      className="cal-popover"
      role="dialog"
      aria-labelledby={titleId}
      tabIndex={-1}
      style={{
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        visibility: pos ? 'visible' : 'hidden',
        ...({ '--ev-color': color } as CSSProperties),
      }}
      onKeyDown={(e) => {
        const el = e.target as HTMLElement
        if (e.key === 'Escape') {
          e.stopPropagation()
          onClose()
        } else if (
          (e.key === 'Delete' || e.key === 'Backspace') &&
          !readOnly &&
          el === ref.current
        ) {
          e.preventDefault()
          e.stopPropagation()
          onDelete()
        }
      }}
    >
      <div className="cal-pop-head">
        <span className="cal-pop-swatch" aria-hidden />
        <h2 id={titleId} className={event.status === 'cancelled' ? 'cancelled' : undefined}>
          {title}
        </h2>
        <button
          type="button"
          className="icon-btn"
          title={t('close')}
          aria-label={t('close')}
          onClick={onClose}
        >
          <IconClose />
        </button>
      </div>

      {(event.status === 'cancelled' || event.status === 'tentative') && (
        <p className={`cal-pop-badge cal-pop-badge-${event.status}`}>
          {event.status === 'cancelled' ? t('eventCancelled') : t('eventTentative')}
        </p>
      )}

      <div className="cal-pop-row">
        <IconClock />
        <div>
          <div>{formatEventWhen(span, lang)}</div>
          {repeat && (
            <div className="cal-pop-sub">
              <IconRepeat /> {repeat}
            </div>
          )}
        </div>
      </div>

      {event.location.trim() && (
        <div className="cal-pop-row">
          <IconPin />
          <div className="cal-pop-text">
            <Linkified text={event.location} />
          </div>
        </div>
      )}

      {calendar && (
        <div className="cal-pop-row">
          <IconCalendar size={16} />
          <div className="cal-pop-text">
            {calendar.name}
            {readOnly && <span className="cal-pop-muted"> · {t('readOnly')}</span>}
          </div>
        </div>
      )}

      {event.reminders.length > 0 && (
        <div className="cal-pop-row">
          <IconBell />
          <div className="cal-pop-text">
            {[...new Set(event.reminders)]
              .sort((a, b) => a - b)
              .map((m) => reminderLabel(m, t))
              .join(', ')}
          </div>
        </div>
      )}

      {(event.organizer || event.attendees.length > 0) && (
        <div className="cal-pop-row">
          <IconAttendees />
          <ul className="cal-pop-people">
            {event.organizer && (
              <li>
                <span className="cal-person" title={event.organizer.email}>
                  {event.organizer.name || event.organizer.email}
                </span>
                <span className="cal-pop-muted"> · {t('organizer')}</span>
              </li>
            )}
            {event.attendees
              .filter((a) => a.email.toLowerCase() !== event.organizer?.email.toLowerCase())
              .map((a) => (
                <li key={a.email}>
                  <AttendeeStatusMark status={a.status} t={t} />
                  <span className="cal-person" title={a.email}>
                    {a.name || a.email}
                  </span>
                  {a.optional && <span className="cal-pop-muted"> · {t('optionalAttendee')}</span>}
                </li>
              ))}
          </ul>
        </div>
      )}

      {event.url && /^https?:\/\//i.test(event.url) && (
        <div className="cal-pop-row">
          <IconLink />
          <div className="cal-pop-text">
            <a href={event.url} target="_blank" rel="noreferrer">
              {t('openLink')}
            </a>
          </div>
        </div>
      )}

      {event.description.trim() && (
        <div className="cal-pop-desc">
          <Linkified text={event.description.trim()} />
        </div>
      )}

      {readOnly ? (
        <p className="cal-pop-note">{t('readOnlyEvent')}</p>
      ) : (
        <div className="cal-pop-actions">
          <button type="button" className="btn" onClick={onEdit}>
            <IconPencil /> {t('edit')}
          </button>
          <button type="button" className="btn btn-danger" onClick={onDelete}>
            <IconTrash /> {t('delete')}
          </button>
        </div>
      )}
    </div>
  )
}

// ---- "just this one or the whole series?" ----

interface ScopePromptProps {
  t: CalT
  title: string
  action: 'edit' | 'delete'
  onChoose(scope: 'occurrence' | 'series'): void
  onCancel(): void
}

export function ScopePrompt({
  t,
  title,
  action,
  onChoose,
  onCancel,
}: ScopePromptProps): ReactElement {
  const titleId = useId()
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        className="modal cal-scope"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onCancel()
          }
        }}
      >
        <h2 id={titleId}>{action === 'edit' ? t('scopeEditTitle') : t('scopeDeleteTitle')}</h2>
        <p>{t('scopeQuestion', { title: title.trim() || t('noTitle') })}</p>
        <div className="cal-scope-choices">
          <button
            type="button"
            className={`btn${action === 'delete' ? ' btn-danger' : ''}`}
            autoFocus
            onClick={() => onChoose('occurrence')}
          >
            {t('scopeOccurrence')}
          </button>
          <button
            type="button"
            className={`btn${action === 'delete' ? ' btn-danger' : ''}`}
            onClick={() => onChoose('series')}
          >
            {t('scopeSeries')}
          </button>
        </div>
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={onCancel}>
            {t('cancel')}
          </button>
        </div>
      </div>
    </div>
  )
}
