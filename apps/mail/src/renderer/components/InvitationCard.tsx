import { useMemo, useState, type ReactElement } from 'react'
import type { Attendee, AttendeeStatus, CalendarInfo, Invitation } from '../../shared/pim'
import { aiTranslator, describeRrule, formatWhen, type CalendarAiKey } from '../calendar/ai-i18n'
import { IconCalendar } from './icons'
import './invitation.css'

/**
 * The meeting card above a mail body, like Outlook's: what, when, where and
 * who, and — depending on the iTIP method — the answer buttons (REQUEST), the
 * removal of a cancelled meeting (CANCEL), who answered (REPLY) or "add to
 * calendar" (PUBLISH). The card only reports the choice; App does the IPC.
 */

interface Props {
  invitation: Invitation
  lang: string
  calendars: CalendarInfo[]
  busy?: boolean
  onRespond(answer: 'accepted' | 'tentative' | 'declined', calendarId: string | undefined): void
  onRemove?(): void
  onOpenCalendar?(): void
}

const COLLAPSED_ATTENDEES = 5

const KIND: Record<string, CalendarAiKey> = {
  REQUEST: 'kindRequest',
  CANCEL: 'kindCancel',
  REPLY: 'kindReply',
  PUBLISH: 'kindPublish',
  COUNTER: 'kindCounter',
  REFRESH: 'kindRefresh',
}

const STATUS_LABEL: Record<AttendeeStatus, CalendarAiKey> = {
  accepted: 'statusAccepted',
  declined: 'statusDeclined',
  tentative: 'statusTentative',
  'needs-action': 'statusNeedsAction',
}

const STATUS_GLYPH: Record<AttendeeStatus, string> = {
  accepted: '✓',
  declined: '✕',
  tentative: '?',
  'needs-action': '·',
}

const REPLY_TEXT: Record<AttendeeStatus, CalendarAiKey> = {
  accepted: 'replyAccepted',
  declined: 'replyDeclined',
  tentative: 'replyTentative',
  'needs-action': 'replyNeedsAction',
}

const TALLY: Array<[AttendeeStatus, CalendarAiKey]> = [
  ['accepted', 'tallyAccepted'],
  ['tentative', 'tallyTentative'],
  ['declined', 'tallyDeclined'],
  ['needs-action', 'tallyPending'],
]

function statusOf(a: Attendee): AttendeeStatus {
  return a.status in STATUS_GLYPH ? a.status : 'needs-action'
}

export function InvitationCard(props: Props): ReactElement {
  const { invitation, lang, calendars, busy = false } = props
  const t = useMemo(() => aiTranslator(lang), [lang])
  const [expanded, setExpanded] = useState(false)
  const [picked, setPicked] = useState<string | undefined>(undefined)

  const method = invitation.method
  const attendees = Array.isArray(invitation.attendees)
    ? invitation.attendees.filter((a) => a && typeof a.email === 'string')
    : []
  const allCalendars = Array.isArray(calendars) ? calendars : []
  const writable = allCalendars.filter((c) => !c.readOnly)
  // an update of a meeting that is already filed stays where it is
  const preferred =
    writable.find((c) => c.id === invitation.existingEventId) ??
    writable.find((c) => c.sourceId === 'local') ??
    writable[0]
  const calendarId = writable.some((c) => c.id === picked) ? picked : preferred?.id
  const selected = writable.find((c) => c.id === calendarId)
  // while the list is still loading the main process picks a calendar itself
  const noWritable = allCalendars.length > 0 && writable.length === 0
  const existingCalendar = invitation.existingEventId
    ? allCalendars.find((c) => c.id === invitation.existingEventId)
    : undefined

  const when = formatWhen(invitation.start, invitation.end, invitation.allDay, lang)
  const recurrence = describeRrule(invitation.rrule, lang)
  const title = (invitation.title ?? '').trim() || t('untitled')
  const location = (invitation.location ?? '').trim()
  const organizer = invitation.organizer
  const nameOf = (p: { name?: string; email: string } | undefined): string =>
    p?.name?.trim() || p?.email || t('someone')

  const shown = expanded ? attendees : attendees.slice(0, COLLAPSED_ATTENDEES)
  const tally = TALLY.map(([status, key]) => {
    const n = attendees.filter((a) => statusOf(a) === status).length
    return n ? t(key, { n: String(n) }) : ''
  }).filter(Boolean)
  const anyAnswer = attendees.some((a) => statusOf(a) !== 'needs-action')

  const existingNote = invitation.existingEventId ? (
    <p className="invite-note is-muted">
      {existingCalendar ? t('alreadyIn', { name: existingCalendar.name }) : t('alreadyInSome')}
    </p>
  ) : null

  const calendarPicker =
    writable.length > 0 ? (
      <label className="invite-cal" title={t('calendar')}>
        <span
          className="invite-cal-dot"
          style={selected?.color ? { background: selected.color } : undefined}
          aria-hidden
        />
        <select
          aria-label={t('calendar')}
          value={calendarId ?? ''}
          disabled={busy}
          onChange={(e) => setPicked(e.target.value)}
        >
          {writable.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
    ) : noWritable ? (
      <p className="invite-note is-muted">{t('noWritableCalendar')}</p>
    ) : null

  let actions: ReactElement | null = null
  if (method === 'REQUEST') {
    actions = (
      <>
        {existingNote}
        <div className="invite-actions">
          {calendarPicker}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || noWritable}
            onClick={() => props.onRespond('accepted', calendarId)}
          >
            {t('accept')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy || noWritable}
            onClick={() => props.onRespond('tentative', calendarId)}
          >
            {t('tentative')}
          </button>
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => props.onRespond('declined', undefined)}
          >
            {t('decline')}
          </button>
        </div>
      </>
    )
  } else if (method === 'PUBLISH') {
    actions = (
      <>
        {existingNote}
        <div className="invite-actions">
          {calendarPicker}
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy || noWritable}
            onClick={() => props.onRespond('accepted', calendarId)}
          >
            {t('publishAdd')}
          </button>
        </div>
      </>
    )
  } else if (method === 'CANCEL') {
    actions = (
      <>
        <p className="invite-note is-declined">{t('cancelled')}</p>
        {invitation.existingEventId ? (
          props.onRemove && (
            <div className="invite-actions">
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy}
                onClick={() => props.onRemove?.()}
              >
                {t('removeFromCalendar')}
              </button>
            </div>
          )
        ) : (
          <p className="invite-note is-muted">{t('cancelledNotInCalendar')}</p>
        )}
      </>
    )
  } else if (method === 'REPLY') {
    const answer = invitation.replyStatus
    const who =
      (answer && attendees.find((a) => statusOf(a) === answer)) ||
      attendees.find((a) => statusOf(a) !== 'needs-action') ||
      attendees[0]
    const status = answer ?? (who ? statusOf(who) : 'needs-action')
    actions = (
      <>
        <p className={`invite-note is-${status}`}>
          {t(REPLY_TEXT[status] ?? 'replyNeedsAction', { name: nameOf(who) })}
        </p>
        {invitation.existingEventId && <p className="invite-note is-muted">{t('replyRecorded')}</p>}
      </>
    )
  } else if (method === 'COUNTER') {
    actions = <p className="invite-note">{t('counterInfo', { name: nameOf(attendees[0]) })}</p>
  } else if (method === 'REFRESH') {
    actions = <p className="invite-note">{t('refreshInfo', { name: nameOf(attendees[0]) })}</p>
  }

  // a REPLY or REFRESH carries only the sender as attendee: the sentence says it all
  const showPeople = attendees.length > 0 && method !== 'REPLY' && method !== 'REFRESH'

  return (
    <section
      className={`invite-card${method === 'CANCEL' ? ' is-cancel' : ''}`}
      aria-label={t(KIND[method] ?? 'kindRequest')}
      aria-busy={busy || undefined}
    >
      <div className="invite-icon" aria-hidden>
        <IconCalendar size={20} />
      </div>
      <div className="invite-main">
        <div className="invite-kicker">
          <span>{t(KIND[method] ?? 'kindRequest')}</span>
          {props.onOpenCalendar && (
            <button type="button" className="link-btn" onClick={() => props.onOpenCalendar?.()}>
              {t('openCalendar')}
            </button>
          )}
        </div>
        <h3 className="invite-title">{title}</h3>
        <dl className="invite-facts">
          {when && (
            <div>
              <dt>{t('when')}</dt>
              <dd>
                {when}
                {recurrence && <span className="invite-rrule"> · {recurrence}</span>}
              </dd>
            </div>
          )}
          {location && (
            <div>
              <dt>{t('where')}</dt>
              <dd>{location}</dd>
            </div>
          )}
          {organizer?.email && (
            <div>
              <dt>{t('organizer')}</dt>
              <dd title={organizer.email}>{nameOf(organizer)}</dd>
            </div>
          )}
        </dl>

        {showPeople && (
          <div className="invite-people">
            <div className="invite-people-head">
              {t('attendees', { n: String(attendees.length) })}
              {anyAnswer && <span className="invite-tally">{tally.join(', ')}</span>}
            </div>
            <ul>
              {shown.map((a, i) => {
                const status = statusOf(a)
                return (
                  <li key={`${a.email}-${i}`} title={a.email}>
                    <span
                      className={`invite-status is-${status}`}
                      role="img"
                      aria-label={t(STATUS_LABEL[status])}
                      title={t(STATUS_LABEL[status])}
                    >
                      {STATUS_GLYPH[status]}
                    </span>
                    <span className="invite-person">{a.name?.trim() || a.email}</span>
                    {a.optional && <span className="invite-optional">{t('optional')}</span>}
                  </li>
                )
              })}
            </ul>
            {attendees.length > COLLAPSED_ATTENDEES && (
              <button
                type="button"
                className="link-btn invite-more"
                aria-expanded={expanded}
                onClick={() => setExpanded((open) => !open)}
              >
                {expanded ? t('showLess') : t('showAll', { n: String(attendees.length) })}
              </button>
            )}
          </div>
        )}

        {actions}
      </div>
    </section>
  )
}
