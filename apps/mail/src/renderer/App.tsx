import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { MailAccountInfo, MailFolder, MailMessage, MailSummary } from '../shared/ipc'
import type { MailContext } from './ai'
import type { CalendarInfo, EventInput } from '../shared/pim'
import { AccountDialog } from './components/AccountDialog'
import { InvitationCard } from './components/InvitationCard'
import { splitRecipients } from './contacts/address-tokens'
import { AiPanel, type AiMode } from './components/AiPanel'
import { Composer } from './components/Composer'
import {
  FolderIcon,
  IconChevron,
  IconCompose,
  IconEnvelope,
  IconEnvelopeOpen,
  IconFlag,
  IconFolderMove,
  IconForward,
  IconGear,
  IconPaperclip,
  IconPlus,
  IconRefresh,
  IconReply,
  IconReplyAll,
  IconSearch,
  IconTrash,
  SuiteMark,
} from './components/icons'
import {
  displayName,
  emptyDraft,
  formatAddressList,
  formatBytes,
  forwardDraft,
  listDate,
  messageText,
  outgoingText,
  parseRecipient,
  readerDocument,
  replyDraft,
  type Draft,
} from './format'
import { translator, type MailStringKey } from './i18n'

const PAGE_SIZE = 50

interface Location {
  accountId: string
  folder: string
}

interface Compose {
  accountId: string
  draft: Draft
  /** the message this draft answers, for the AI's context */
  context: MailContext | null
}

const SPECIAL_LABEL: Record<string, MailStringKey> = {
  '\\Inbox': 'folderInbox',
  '\\Sent': 'folderSent',
  '\\Drafts': 'folderDrafts',
  '\\Trash': 'folderTrash',
  '\\Junk': 'folderJunk',
  '\\Archive': 'folderArchive',
}

function contextOf(msg: MailMessage, locale: string): MailContext {
  return {
    from: formatAddressList(msg.from),
    to: formatAddressList(msg.to),
    subject: msg.subject,
    date: new Date(msg.date).toLocaleString(locale),
    body: messageText(msg),
  }
}

export interface MailRequest {
  kind: 'compose'
  to: string
}

interface MailAppProps {
  lang: string
  /** false while the calendar or contacts are in front: no keyboard shortcuts then */
  active: boolean
  /** a request from another module (contacts: "write to …") */
  request?: MailRequest | null
  onRequestHandled?(): void
  /** switch to the calendar with a new event prefilled (Suite AI, invitations) */
  onCreateEvent(draft: Partial<EventInput>): void
  onOpenCalendar(): void
}

export default function App({
  lang,
  active,
  request,
  onRequestHandled,
  onCreateEvent,
  onOpenCalendar,
}: MailAppProps): ReactElement {
  const t = useMemo(() => translator(lang), [lang])

  const [accounts, setAccounts] = useState<MailAccountInfo[] | null>(null)
  const [folders, setFolders] = useState<Record<string, MailFolder[]>>({})
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [location, setLocation] = useState<Location | null>(null)
  const [messages, setMessages] = useState<MailSummary[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [listLoading, setListLoading] = useState(false)
  const [query, setQuery] = useState('')
  const [activeQuery, setActiveQuery] = useState('')
  const [selected, setSelected] = useState<number | null>(null)
  const [message, setMessage] = useState<MailMessage | null>(null)
  const [messageLoading, setMessageLoading] = useState(false)
  const [allowRemote, setAllowRemote] = useState(false)
  const [compose, setCompose] = useState<Compose | null>(null)
  const [sending, setSending] = useState(false)
  const [aiOpen, setAiOpen] = useState(true)
  const [dialog, setDialog] = useState<{ account?: MailAccountInfo } | null>(null)
  const [moveOpen, setMoveOpen] = useState(false)
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null)
  const listRequest = useRef(0)
  const messageRequest = useRef(0)

  const [calendars, setCalendars] = useState<CalendarInfo[]>([])
  const [responding, setResponding] = useState(false)
  /** the open message's sender is already a contact (null: unknown / no contacts module) */
  const [senderKnown, setSenderKnown] = useState<boolean | null>(null)

  // the invitation card needs to know where an accepted meeting can go
  useEffect(() => {
    if (!message?.invitation || !window.pimApi) return
    let live = true
    void window.pimApi.listCalendars().then((list) => live && setCalendars(list))
    return () => {
      live = false
    }
  }, [message])

  useEffect(() => {
    setSenderKnown(null)
    const email = message?.from[0]?.address?.toLowerCase()
    if (!email || !window.pimApi) return
    let live = true
    void window.pimApi.listContacts(email).then((r) => {
      if (!live || !r.ok) return
      setSenderKnown(r.value.some((c) => c.emails.some((e) => e.value.toLowerCase() === email)))
    })
    return () => {
      live = false
    }
  }, [message])

  const flash = useCallback((text: string, error = false) => {
    setNotice({ text, error })
    window.setTimeout(() => setNotice((n) => (n?.text === text ? null : n)), error ? 8000 : 3500)
  }, [])

  // ---- accounts & folders ----

  const loadFolders = useCallback(
    async (accountId: string): Promise<MailFolder[]> => {
      const r = await window.mailApi.listFolders(accountId)
      if (!r.ok || !r.value) {
        flash(r.error ?? '', true)
        return []
      }
      setFolders((f) => ({ ...f, [accountId]: r.value! }))
      return r.value
    },
    [flash],
  )

  const loadAccounts = useCallback(async () => {
    const list = await window.mailApi.listAccounts()
    setAccounts(list)
    return list
  }, [])

  useEffect(() => {
    void (async () => {
      const list = await loadAccounts()
      for (const account of list) {
        const fs = await loadFolders(account.id)
        if (account === list[0]) {
          const inbox = fs.find((f) => f.specialUse === '\\Inbox') ?? fs[0]
          if (inbox) setLocation({ accountId: account.id, folder: inbox.path })
        }
      }
    })()
  }, [loadAccounts, loadFolders])

  // ---- message list ----

  const loadList = useCallback(
    async (loc: Location, pageNo: number, q: string, append: boolean) => {
      const id = ++listRequest.current
      setListLoading(true)
      const r = await window.mailApi.listMessages(loc.accountId, loc.folder, {
        page: pageNo,
        pageSize: PAGE_SIZE,
        query: q || undefined,
      })
      if (id !== listRequest.current) return
      setListLoading(false)
      if (!r.ok || !r.value) {
        flash(r.error ?? '', true)
        return
      }
      setTotal(r.value.total)
      setPage(pageNo)
      setMessages((prev) => (append ? [...prev, ...r.value!.messages] : r.value!.messages))
    },
    [flash],
  )

  useEffect(() => {
    if (!location) return
    setMessages([])
    setSelected(null)
    setMessage(null)
    void loadList(location, 0, activeQuery, false)
  }, [location, activeQuery, loadList])

  const refresh = useCallback(() => {
    if (!location) return
    void loadList(location, 0, activeQuery, false)
    void loadFolders(location.accountId)
  }, [location, activeQuery, loadList, loadFolders])

  // new mail shows up without a manual refresh
  useEffect(() => {
    if (!location) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible' && !activeQuery) {
        void loadList(location, 0, '', false)
        void loadFolders(location.accountId)
      }
    }, 120_000)
    return () => window.clearInterval(timer)
  }, [location, activeQuery, loadList, loadFolders])

  // ---- reading ----

  const open = useCallback(
    async (uid: number) => {
      if (!location) return
      const id = ++messageRequest.current
      setSelected(uid)
      setCompose(null)
      setMessageLoading(true)
      setAllowRemote(false)
      const r = await window.mailApi.getMessage(location.accountId, location.folder, uid)
      if (id !== messageRequest.current) return
      setMessageLoading(false)
      if (!r.ok || !r.value) {
        setMessage(null)
        flash(r.error ?? '', true)
        return
      }
      setMessage(r.value)
      setMessages((list) => list.map((m) => (m.uid === uid ? { ...m, seen: true } : m)))
    },
    [location, flash],
  )

  const account = accounts?.find((a) => a.id === location?.accountId) ?? accounts?.[0] ?? null

  // ---- actions ----

  const selectedSummary = messages.find((m) => m.uid === selected) ?? null

  const afterRemoval = (uids: number[]): void => {
    setMessages((list) => list.filter((m) => !uids.includes(m.uid)))
    setTotal((n) => Math.max(0, n - uids.length))
    setSelected(null)
    setMessage(null)
  }

  const remove = async (): Promise<void> => {
    if (!location || selected === null) return
    const r = await window.mailApi.deleteMessages(location.accountId, location.folder, [selected])
    if (!r.ok) flash(r.error ?? '', true)
    else afterRemoval([selected])
  }

  const move = async (target: string): Promise<void> => {
    setMoveOpen(false)
    if (!location || selected === null) return
    const r = await window.mailApi.moveMessages(
      location.accountId,
      location.folder,
      [selected],
      target,
    )
    if (!r.ok) flash(r.error ?? '', true)
    else afterRemoval([selected])
  }

  const toggleFlag = async (flag: 'seen' | 'flagged'): Promise<void> => {
    if (!location || !selectedSummary) return
    const on = flag === 'seen' ? !selectedSummary.seen : !selectedSummary.flagged
    const r = await window.mailApi.setFlags(
      location.accountId,
      location.folder,
      [selectedSummary.uid],
      flag,
      on,
    )
    if (!r.ok) {
      flash(r.error ?? '', true)
      return
    }
    setMessages((list) =>
      list.map((m) => (m.uid === selectedSummary.uid ? { ...m, [flag]: on } : m)),
    )
  }

  const startCompose = (draft: Draft, context: MailContext | null = null): void => {
    if (!account) return
    setCompose({ accountId: account.id, draft, context })
  }

  // "write to …" from the contacts module: a mail being written gains the
  // recipient instead of being thrown away
  useEffect(() => {
    if (request?.kind !== 'compose' || !account) return
    setCompose((current) => {
      if (!current) {
        return { accountId: account.id, draft: { ...emptyDraft(), to: request.to }, context: null }
      }
      const to = current.draft.to.trim().replace(/[,;]\s*$/, '')
      const email = parseRecipient(request.to)?.email.toLowerCase()
      if (email && to.toLowerCase().includes(email)) return current
      return {
        ...current,
        draft: { ...current.draft, to: to ? `${to}, ${request.to}` : request.to },
      }
    })
    onRequestHandled?.()
  }, [request, account, onRequestHandled])

  const addSenderToContacts = async (): Promise<void> => {
    const from = message?.from[0]
    if (!from?.address) return
    const books = await window.pimApi.listAddressBooks()
    const book = books.find((b) => !b.readOnly)
    if (!book) return
    const name = displayName(from)
    const r = await window.pimApi.saveContact({
      addressBookId: book.id,
      name: from.name?.trim() || from.address,
      emails: [{ type: '', value: from.address }],
    })
    if (!r.ok) {
      flash(r.error ?? '', true)
      return
    }
    setSenderKnown(true)
    flash(t('contactSaved', { name }))
  }

  const replyTo = (mode: 'reply' | 'replyAll', text = ''): void => {
    if (!message || !account) return
    const name = displayName(message.from[0] ?? { name: '', address: '' })
    const header = t('replyHeader', { date: new Date(message.date).toLocaleString(lang), name })
    const draft = replyDraft(message, mode, account.email, header)
    startCompose({ ...draft, text }, contextOf(message, lang))
  }

  const forward = (): void => {
    if (!message) return
    const draft = forwardDraft(
      message,
      t('forwardHeader'),
      {
        from: t('from'),
        to: t('to'),
        date: t('date'),
        subject: t('subject'),
      },
      lang,
    )
    startCompose(draft, contextOf(message, lang))
  }

  const send = async (): Promise<void> => {
    if (!compose) return
    setSending(true)
    const { draft } = compose
    const r = await window.mailApi.send({
      accountId: compose.accountId,
      to: draft.to,
      cc: draft.cc,
      bcc: draft.bcc,
      subject: draft.subject,
      text: outgoingText(draft),
      inReplyTo: draft.inReplyTo,
      references: draft.references,
      attachments: draft.attachments,
      answering: draft.answering,
    })
    setSending(false)
    if (!r.ok) {
      flash(r.error ?? '', true)
      return
    }
    flash(t('sent'))
    const recipients = [draft.to, draft.cc, draft.bcc]
      .flatMap((field) => splitRecipients(field))
      .map(parseRecipient)
      .filter((r): r is { name: string; email: string } => r !== null)
    if (recipients.length) void window.pimApi?.rememberRecipients(recipients).catch(() => undefined)
    if (draft.answering) {
      const uid = draft.answering.uid
      setMessages((list) => list.map((m) => (m.uid === uid ? { ...m, answered: true } : m)))
    }
    setCompose(null)
  }

  const discard = (): void => {
    if (compose && (compose.draft.text.trim() || compose.draft.attachments.length)) {
      if (!window.confirm(t('discardConfirm'))) return
    }
    setCompose(null)
  }

  // keyboard: Delete removes, R replies, N composes — only outside text fields
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = e.target as HTMLElement | null
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return
      if (!active || e.metaKey || e.ctrlKey || e.altKey || compose) return
      if (e.key === 'Delete' || e.key === 'Backspace') void remove()
      else if (e.key === 'r') replyTo('reply')
      else if (e.key === 'n') startCompose(emptyDraft())
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const i = messages.findIndex((m) => m.uid === selected)
        const next = messages[e.key === 'ArrowDown' ? i + 1 : Math.max(0, i - 1)]
        if (next) {
          e.preventDefault()
          void open(next.uid)
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // ---- AI context ----

  const aiMode: AiMode = compose ? 'compose' : message ? 'reading' : 'idle'
  const aiMail = compose ? compose.context : message ? contextOf(message, lang) : null

  // ---- render ----

  if (accounts === null) return <div className="mail-empty">{t('loading')}</div>

  if (accounts.length === 0) {
    return (
      <div className="mail-welcome">
        <div className="welcome-card">
          <SuiteMark size={44} />
          <h1>{t('noAccountTitle')}</h1>
          <p>{t('noAccountBody')}</p>
          <button className="btn btn-primary" onClick={() => setDialog({})}>
            <IconPlus /> {t('addAccount')}
          </button>
        </div>
        {dialog && (
          <AccountDialog
            t={t}
            onClose={() => setDialog(null)}
            onSaved={(saved) => {
              setDialog(null)
              void loadAccounts().then(async () => {
                const fs = await loadFolders(saved.id)
                const inbox = fs.find((f) => f.specialUse === '\\Inbox') ?? fs[0]
                if (inbox) setLocation({ accountId: saved.id, folder: inbox.path })
              })
            }}
          />
        )}
      </div>
    )
  }

  const currentFolders = location ? (folders[location.accountId] ?? []) : []
  const folderLabel = (f: MailFolder): string =>
    f.specialUse && SPECIAL_LABEL[f.specialUse] ? t(SPECIAL_LABEL[f.specialUse]!) : f.name

  return (
    <div className={`mail-app${aiOpen ? ' with-ai' : ''}`}>
      <header className="mail-toolbar">
        <button className="btn btn-primary" onClick={() => startCompose(emptyDraft())}>
          <IconCompose /> {t('newMail')}
        </button>
        <span className="sep" />
        <button
          className="tool"
          disabled={!message}
          onClick={() => replyTo('reply')}
          title={t('reply')}
        >
          <IconReply /> <span>{t('reply')}</span>
        </button>
        <button
          className="tool"
          disabled={!message}
          onClick={() => replyTo('replyAll')}
          title={t('replyAll')}
        >
          <IconReplyAll /> <span>{t('replyAll')}</span>
        </button>
        <button className="tool" disabled={!message} onClick={forward} title={t('forward')}>
          <IconForward /> <span>{t('forward')}</span>
        </button>
        <span className="sep" />
        <button
          className="tool"
          disabled={selected === null}
          onClick={() => void remove()}
          title={t('delete')}
        >
          <IconTrash /> <span>{t('delete')}</span>
        </button>
        <div className="menu-anchor">
          <button
            className="tool"
            disabled={selected === null}
            onClick={() => setMoveOpen(!moveOpen)}
            title={t('moveTo')}
          >
            <IconFolderMove /> <span>{t('moveTo')}</span>
          </button>
          {moveOpen && (
            <ul className="dropdown" role="menu" onMouseLeave={() => setMoveOpen(false)}>
              {currentFolders
                .filter((f) => f.path !== location?.folder)
                .map((f) => (
                  <li key={f.path}>
                    <button role="menuitem" onClick={() => void move(f.path)}>
                      <FolderIcon use={f.specialUse} /> {folderLabel(f)}
                    </button>
                  </li>
                ))}
            </ul>
          )}
        </div>
        <button
          className="tool icon-only"
          disabled={!selectedSummary}
          onClick={() => void toggleFlag('seen')}
          title={selectedSummary?.seen ? t('markUnread') : t('markRead')}
        >
          {selectedSummary?.seen ? <IconEnvelope /> : <IconEnvelopeOpen />}
        </button>
        <button
          className={`tool icon-only${selectedSummary?.flagged ? ' on' : ''}`}
          disabled={!selectedSummary}
          onClick={() => void toggleFlag('flagged')}
          title={selectedSummary?.flagged ? t('unflag') : t('flag')}
        >
          <IconFlag />
        </button>
        <button className="tool icon-only" onClick={refresh} title={t('refresh')}>
          <IconRefresh />
        </button>
        <span className="spacer" />
        <form
          className="search"
          onSubmit={(e) => {
            e.preventDefault()
            setActiveQuery(query.trim())
          }}
        >
          <IconSearch />
          <input
            type="search"
            value={query}
            placeholder={t('searchPlaceholder')}
            onChange={(e) => {
              setQuery(e.target.value)
              if (!e.target.value) setActiveQuery('')
            }}
          />
        </form>
        <button
          className={`tool ai-toggle${aiOpen ? ' on' : ''}`}
          onClick={() => setAiOpen(!aiOpen)}
        >
          <SuiteMark size={18} /> <span>{t('aiToggle')}</span>
        </button>
      </header>

      <nav className="mail-sidebar" aria-label={t('accounts')}>
        {accounts.map((a) => (
          <div key={a.id} className="account">
            <div className="account-row">
              <button
                className="account-name"
                onClick={() => setCollapsed((c) => ({ ...c, [a.id]: !c[a.id] }))}
                title={a.email}
              >
                <IconChevron open={!collapsed[a.id]} />
                <span>{a.name && a.name !== a.email ? a.name : a.email}</span>
              </button>
              <button
                className="icon-btn"
                title={t('editAccount')}
                onClick={() => setDialog({ account: a })}
              >
                <IconGear />
              </button>
            </div>
            {!collapsed[a.id] && (
              <ul className="folders">
                {(folders[a.id] ?? []).map((f) => (
                  <li key={f.path}>
                    <button
                      className={`folder${location?.accountId === a.id && location.folder === f.path ? ' active' : ''}`}
                      style={{ paddingLeft: 26 + f.depth * 14 }}
                      onClick={() => {
                        setQuery('')
                        setActiveQuery('')
                        setLocation({ accountId: a.id, folder: f.path })
                      }}
                    >
                      <FolderIcon use={f.specialUse} />
                      <span className="folder-name">{folderLabel(f)}</span>
                      {!!f.unseen && f.specialUse !== '\\Sent' && f.specialUse !== '\\Drafts' && (
                        <span className="badge">{f.unseen}</span>
                      )}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
        <button className="add-account" onClick={() => setDialog({})}>
          <IconPlus /> {t('addAccount')}
        </button>
      </nav>

      <section className="mail-list" aria-label={location?.folder ?? ''}>
        {messages.length === 0 && !listLoading && <p className="mail-empty">{t('noMessages')}</p>}
        <ul role="listbox">
          {messages.map((m) => (
            <li
              key={m.uid}
              role="option"
              aria-selected={m.uid === selected}
              className={`mail-row${m.seen ? '' : ' unread'}${m.uid === selected ? ' selected' : ''}`}
              onClick={() => void open(m.uid)}
            >
              <div className="row-top">
                <span className="row-from">
                  {location &&
                  currentFolders.find((f) => f.path === location.folder)?.specialUse === '\\Sent'
                    ? `${t('to')}: ${m.to.map(displayName).join(', ')}`
                    : m.from.map(displayName).join(', ')}
                </span>
                <span className="row-date">
                  {listDate(m.date, { today: t('today'), yesterday: t('yesterday') }, lang)}
                </span>
              </div>
              <div className="row-bottom">
                <span className="row-subject">{m.subject || t('noSubject')}</span>
                {m.hasAttachments && <IconPaperclip />}
                {m.flagged && (
                  <span className="row-flag">
                    <IconFlag />
                  </span>
                )}
                {m.answered && <span className="row-answered">↩</span>}
              </div>
            </li>
          ))}
        </ul>
        {listLoading && <p className="mail-empty">{t('loading')}</p>}
        {!listLoading && messages.length < total && location && (
          <button
            className="load-more"
            onClick={() => void loadList(location, page + 1, activeQuery, true)}
          >
            {t('loadMore')}
          </button>
        )}
      </section>

      <main className="mail-reader">
        {compose ? (
          <Composer
            t={t}
            lang={lang}
            accounts={accounts}
            accountId={compose.accountId}
            draft={compose.draft}
            sending={sending}
            onAccount={(id) => setCompose({ ...compose, accountId: id })}
            onChange={(draft) => setCompose({ ...compose, draft })}
            onSend={() => void send()}
            onDiscard={discard}
          />
        ) : messageLoading ? (
          <p className="mail-empty">{t('loading')}</p>
        ) : message ? (
          <article className="message">
            <h1 className="message-subject">{message.subject || t('noSubject')}</h1>
            <div className="message-meta">
              <div className="avatar" aria-hidden>
                {displayName(message.from[0] ?? { name: '?', address: '?' })
                  .slice(0, 1)
                  .toUpperCase()}
              </div>
              <div className="meta-lines">
                <div className="meta-from">
                  <strong>{displayName(message.from[0] ?? { name: '', address: '' })}</strong>
                  <span className="meta-addr">&lt;{message.from[0]?.address}&gt;</span>
                  {senderKnown === false && (
                    <button
                      className="link-btn meta-add-contact"
                      onClick={() => void addSenderToContacts()}
                    >
                      <IconPlus /> {t('addToContacts')}
                    </button>
                  )}
                </div>
                <div className="meta-to">
                  {t('to')}: {formatAddressList(message.to)}
                  {message.cc.length > 0 && ` · ${t('cc')}: ${formatAddressList(message.cc)}`}
                </div>
              </div>
              <time className="meta-date">{new Date(message.date).toLocaleString(lang)}</time>
            </div>
            {message.attachments.length > 0 && (
              <ul className="attachments">
                {message.attachments.map((a) => (
                  <li key={a.index}>
                    <button
                      className="attachment-chip"
                      onClick={async () => {
                        if (!location) return
                        const r = await window.mailApi.saveAttachment(
                          location.accountId,
                          location.folder,
                          message.uid,
                          a.index,
                        )
                        if (!r.ok) flash(r.error ?? '', true)
                        else if (r.value) flash(r.value)
                      }}
                    >
                      <IconPaperclip />
                      <span>{a.filename}</span>
                      <span className="att-size">{formatBytes(a.size)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {message.invitation && (
              <InvitationCard
                invitation={message.invitation}
                lang={lang}
                calendars={calendars}
                busy={responding}
                onOpenCalendar={onOpenCalendar}
                onRespond={async (answer, calendarId) => {
                  if (!location) return
                  setResponding(true)
                  const r = await window.pimApi.respondInvitation({
                    accountId: location.accountId,
                    folder: location.folder,
                    uid: message.uid,
                    answer,
                    calendarId,
                    lang,
                  })
                  setResponding(false)
                  if (!r.ok) {
                    flash(r.error ?? '', true)
                    return
                  }
                  flash(t(answer === 'declined' ? 'inviteDeclined' : 'inviteSaved'))
                  void open(message.uid)
                }}
                onRemove={async () => {
                  const invitation = message.invitation
                  if (!invitation?.existingEventId) return
                  setResponding(true)
                  const r = await window.pimApi.deleteEvent(
                    invitation.existingEventId,
                    invitation.uid,
                  )
                  setResponding(false)
                  if (!r.ok) flash(r.error ?? '', true)
                  else void open(message.uid)
                }}
              />
            )}
            {message.hasRemoteContent && !allowRemote && (
              <div className="remote-banner">
                <span>{t('remoteBlocked')}</span>
                <button className="link-btn" onClick={() => setAllowRemote(true)}>
                  {t('remoteAllow')}
                </button>
              </div>
            )}
            <iframe
              className="message-body"
              title={message.subject}
              sandbox="allow-popups allow-popups-to-escape-sandbox"
              srcDoc={readerDocument(message.html, message.text, allowRemote)}
            />
          </article>
        ) : (
          <p className="mail-empty">{t('noSelection')}</p>
        )}
      </main>

      {aiOpen && (
        <AiPanel
          t={t}
          lang={lang}
          mode={aiMode}
          mail={aiMail}
          draft={compose?.draft.text ?? ''}
          senderName={account?.name ?? ''}
          onApplyDraft={(text) =>
            compose && setCompose({ ...compose, draft: { ...compose.draft, text } })
          }
          onStartReply={(text) => replyTo('reply', text)}
          onCreateEvent={onCreateEvent}
          onClose={() => setAiOpen(false)}
        />
      )}

      {notice && (
        <div className={`toast${notice.error ? ' toast-error' : ''}`} role="status">
          {notice.error ? `${t('errorPrefix')}: ` : ''}
          {notice.text}
        </div>
      )}

      {dialog && (
        <AccountDialog
          t={t}
          account={dialog.account}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            setDialog(null)
            void loadAccounts()
            void loadFolders(saved.id)
          }}
          onRemove={async (a) => {
            if (!window.confirm(t('removeAccountConfirm', { name: a.name || a.email }))) return
            await window.mailApi.removeAccount(a.id)
            setDialog(null)
            const list = await loadAccounts()
            if (location?.accountId === a.id) {
              setLocation(null)
              setMessages([])
              setMessage(null)
              const next = list[0]
              if (next) {
                const fs = folders[next.id] ?? (await loadFolders(next.id))
                const inbox = fs.find((f) => f.specialUse === '\\Inbox') ?? fs[0]
                if (inbox) setLocation({ accountId: next.id, folder: inbox.path })
              }
            }
          }}
        />
      )}
    </div>
  )
}
