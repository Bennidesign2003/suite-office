import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { MailModule } from '../shared/ipc'
import type { EventInput } from '../shared/pim'
import App, { type MailRequest } from './App'
import { CalendarAiPanel } from './calendar/CalendarAiPanel'
import { CalendarApp } from './calendar/CalendarApp'
import { IconCalendar, IconEnvelope, IconPeople } from './components/icons'
import { ContactsApp } from './contacts/ContactsApp'
import { translator, type MailStringKey } from './i18n'

/**
 * The Outlook-style frame around the three modules: a rail on the left
 * switches between mail, calendar and contacts. A module stays mounted once
 * opened, so a half-written mail or an open event survives a look at the
 * calendar; hidden modules only lose their keyboard shortcuts.
 */

interface CalendarRequest {
  kind: 'new-event'
  draft: Partial<EventInput>
}

const MODULES: Array<{ id: MailModule; label: MailStringKey; icon: () => ReactElement }> = [
  { id: 'mail', label: 'moduleMail', icon: () => <IconEnvelope size={20} /> },
  { id: 'calendar', label: 'moduleCalendar', icon: () => <IconCalendar size={20} /> },
  { id: 'contacts', label: 'moduleContacts', icon: () => <IconPeople size={20} /> },
]

export default function Root({
  initialLang,
  initialModule,
}: {
  initialLang: string
  initialModule: MailModule
}): ReactElement {
  const [lang, setLang] = useState(initialLang)
  const [module, setModule] = useState<MailModule>(initialModule)
  const [visited, setVisited] = useState<ReadonlySet<MailModule>>(() => new Set([initialModule]))
  const [mailRequest, setMailRequest] = useState<MailRequest | null>(null)
  const [calendarRequest, setCalendarRequest] = useState<CalendarRequest | null>(null)
  const [calendarAi, setCalendarAi] = useState(true)
  const t = useMemo(() => translator(lang), [lang])
  const shortcut = navigator.platform.startsWith('Mac')
    ? '⌘'
    : lang.startsWith('de')
      ? 'Strg+'
      : 'Ctrl+'

  const show = useCallback((next: MailModule) => {
    setModule(next)
    setVisited((v) => (v.has(next) ? v : new Set(v).add(next)))
  }, [])

  useEffect(
    () =>
      window.mailApi.onLanguageChanged((next) => {
        setLang(next)
        document.documentElement.lang = next.slice(0, 2)
      }),
    [],
  )

  // the shell's "Kalender" / "Kontakte" entries reuse an open mail tab
  useEffect(() => window.mailApi.onShowModule(show), [show])

  // Ctrl/⌘+1/2/3 like Outlook
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return
      const target = MODULES[Number(e.key) - 1]
      if (!target) return
      e.preventDefault()
      show(target.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [show])

  const writeMail = useCallback(
    (to: string) => {
      setMailRequest({ kind: 'compose', to })
      show('mail')
    },
    [show],
  )

  const createEvent = useCallback(
    (draft: Partial<EventInput>) => {
      setCalendarRequest({ kind: 'new-event', draft })
      show('calendar')
    },
    [show],
  )

  return (
    <div className="suite-root">
      <nav className="module-rail" aria-label={t('moduleSwitcher')}>
        {MODULES.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`rail-btn${module === m.id ? ' active' : ''}`}
            aria-current={module === m.id ? 'page' : undefined}
            title={`${t(m.label)} (${shortcut}${MODULES.indexOf(m) + 1})`}
            onClick={() => show(m.id)}
          >
            {m.icon()}
            <span>{t(m.label)}</span>
          </button>
        ))}
      </nav>
      <div className="module-host">
        {visited.has('mail') && (
          <div className="module-pane" hidden={module !== 'mail'}>
            <App
              lang={lang}
              active={module === 'mail'}
              request={mailRequest}
              onRequestHandled={() => setMailRequest(null)}
              onCreateEvent={createEvent}
              onOpenCalendar={() => show('calendar')}
            />
          </div>
        )}
        {visited.has('calendar') && (
          <div className="module-pane" hidden={module !== 'calendar'}>
            <CalendarApp
              lang={lang}
              aiOpen={calendarAi}
              onToggleAi={() => setCalendarAi((open) => !open)}
              renderAiPanel={(ctx, close) => <CalendarAiPanel ctx={ctx} onClose={close} />}
              request={calendarRequest}
              onRequestHandled={() => setCalendarRequest(null)}
            />
          </div>
        )}
        {visited.has('contacts') && (
          <div className="module-pane" hidden={module !== 'contacts'}>
            <ContactsApp lang={lang} onWriteMail={writeMail} />
          </div>
        )}
      </div>
    </div>
  )
}
