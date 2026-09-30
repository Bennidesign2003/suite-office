import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react'
import type { MailResult } from '../../shared/ipc'
import type { AddressBookInfo, Contact, LabeledValue, PimApi, PimSource } from '../../shared/pim'
import type { Translate } from '../calendar/types'
import {
  IconGear,
  IconPeople,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconTrash,
} from '../components/icons'
import { SourceDialog } from '../pim/SourceDialog'
import { formatRecipient } from './address-tokens'
import { ContactEditor } from './ContactEditor'
import { contactsTranslator, formatBirthday, typeName, type ContactsStringKey } from './i18n'
import './contacts.css'

type T = Translate<ContactsStringKey>

const SEARCH_DEBOUNCE_MS = 200
const AVATAR_TONES = 8

function pimApi(): PimApi | undefined {
  return typeof window === 'undefined' ? undefined : (window as { pimApi?: PimApi }).pimApi
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** a thrown IPC call (bridge gone, handler missing) reads like a failed one */
async function call<V>(work: () => Promise<MailResult<V>>): Promise<MailResult<V>> {
  try {
    const r = await work()
    return r && typeof r === 'object' ? r : { ok: false, error: String(r) }
  } catch (err) {
    return { ok: false, error: errorText(err) }
  }
}

function labeled(list: unknown): LabeledValue[] {
  if (!Array.isArray(list)) return []
  return list
    .filter((v): v is LabeledValue => !!v && typeof (v as LabeledValue).value === 'string')
    .map((v) => ({ type: typeof v.type === 'string' ? v.type : '', value: v.value }))
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** one malformed vCard must not take the whole list down */
function normalize(c: Contact): Contact {
  return {
    ...c,
    name: str(c.name),
    firstName: str(c.firstName),
    lastName: str(c.lastName),
    emails: labeled(c.emails),
    phones: labeled(c.phones),
    organization: str(c.organization),
    jobTitle: str(c.jobTitle),
    birthday: str(c.birthday),
    addresses: labeled(c.addresses),
    note: str(c.note),
    photo: typeof c.photo === 'string' ? c.photo : undefined,
  }
}

/** the name a contact goes by; '' when it has none at all */
function nameOf(c: Contact): string {
  return (
    c.name.trim() ||
    [c.firstName, c.lastName]
      .map((s) => s.trim())
      .filter(Boolean)
      .join(' ') ||
    c.organization.trim()
  )
}

function listLabel(c: Contact): string {
  return nameOf(c) || c.emails[0]?.value || c.phones[0]?.value || ''
}

function initials(label: string): string {
  const text = label.includes('@') && !label.includes(' ') ? label.split('@')[0]! : label
  const words = text
    .split(/[\s,._-]+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+/u, ''))
    .filter(Boolean)
  const firstChar = (w: string | undefined): string => (w ? Array.from(w)[0]! : '')
  const letters = firstChar(words[0]) + (words.length > 1 ? firstChar(words[words.length - 1]) : '')
  return letters.toLocaleUpperCase() || '?'
}

/** a stable color per name, picked from the palette in contacts.css */
function avatarTone(label: string): number {
  let hash = 0
  for (const ch of label.toLowerCase()) hash = (hash * 31 + ch.codePointAt(0)!) >>> 0
  return (hash % AVATAR_TONES) + 1
}

function groupLetter(label: string, lang: string): string {
  const first = Array.from(label.trim().normalize('NFD').replace(/[̀-ͯ]/g, ''))[0]
  if (!first || !/\p{L}/u.test(first)) return '#'
  try {
    return first.toLocaleUpperCase(lang || undefined)
  } catch {
    return first.toUpperCase()
  }
}

function telHref(phone: string): string {
  const digits = phone.replace(/[^\d+*#,;]/g, '')
  return digits ? `tel:${digits}` : ''
}

function Avatar({
  label,
  photo,
  size,
}: {
  label: string
  photo?: string
  size: 'sm' | 'lg'
}): ReactElement {
  // only embedded pictures: a remote URL in a vCard would be a tracking pixel
  if (photo && /^data:image\//i.test(photo)) {
    return <img className={`ct-avatar ct-avatar-${size}`} src={photo} alt="" />
  }
  return (
    <span className={`ct-avatar ct-avatar-${size} ct-tone-${avatarTone(label)}`} aria-hidden>
      {initials(label)}
    </span>
  )
}

const IconImport = (): ReactElement => (
  <svg
    width={18}
    height={18}
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M10 3v9M6.5 8.5 10 12l3.5-3.5M3.5 13.5v2a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-2" />
  </svg>
)

const IconExport = (): ReactElement => (
  <svg
    width={18}
    height={18}
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <path d="M10 12.5v-9M6.5 7 10 3.5 13.5 7M3.5 13.5v2a1.5 1.5 0 0 0 1.5 1.5h10a1.5 1.5 0 0 0 1.5-1.5v-2" />
  </svg>
)

const IconCopy = (): ReactElement => (
  <svg
    width={15}
    height={15}
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="7" y="7" width="10" height="10" rx="1.5" />
    <path d="M13 4.5V4a1.5 1.5 0 0 0-1.5-1.5h-7A1.5 1.5 0 0 0 3 4v7.5A1.5 1.5 0 0 0 4.5 13H5" />
  </svg>
)

const IconLock = (): ReactElement => (
  <svg
    width={13}
    height={13}
    viewBox="0 0 20 20"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.6}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
  >
    <rect x="4" y="9" width="12" height="8.5" rx="1.5" />
    <path d="M6.5 9V6.5a3.5 3.5 0 0 1 7 0V9" />
  </svg>
)

interface Entry {
  contact: Contact
  label: string
}

interface BookGroup {
  key: string
  name: string
  source?: PimSource
  books: AddressBookInfo[]
}

type Notice = { text: string; error?: boolean }

export function ContactsApp({
  lang,
  onWriteMail,
}: {
  lang: string
  onWriteMail(to: string): void
}): ReactElement {
  const t = useMemo(() => contactsTranslator(lang), [lang])
  const api = useMemo(pimApi, [])
  const listDomId = useId()

  const [sources, setSources] = useState<PimSource[]>([])
  const [books, setBooks] = useState<AddressBookInfo[]>([])
  const [contacts, setContacts] = useState<Contact[] | null>(null)
  const [listError, setListError] = useState('')
  const [query, setQuery] = useState('')
  const [bookFilter, setBookFilter] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [editor, setEditor] = useState<{ contact?: Contact } | null>(null)
  const [sourceDialog, setSourceDialog] = useState<{ source?: PimSource } | null>(null)
  const [menu, setMenu] = useState<'import' | 'export' | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)

  const queryRef = useRef(query)
  const listRequest = useRef(0)
  const metaRequest = useRef(0)
  const loadedOnce = useRef(false)
  const listRef = useRef<HTMLDivElement>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const flash = useCallback((text: string, error = false) => {
    clearTimeout(noticeTimer.current)
    setNotice({ text, error })
    noticeTimer.current = setTimeout(() => setNotice(null), error ? 8000 : 4000)
  }, [])
  useEffect(() => () => clearTimeout(noticeTimer.current), [])

  const loadMeta = useCallback(async () => {
    if (!api) return
    const ticket = ++metaRequest.current
    const [s, b] = await Promise.all([
      Promise.resolve()
        .then(() => api.listSources())
        .catch((): PimSource[] => []),
      Promise.resolve()
        .then(() => api.listAddressBooks())
        .catch((): AddressBookInfo[] => []),
    ])
    if (ticket !== metaRequest.current) return
    setSources(Array.isArray(s) ? s : [])
    setBooks(Array.isArray(b) ? b : [])
  }, [api])

  const loadContacts = useCallback(
    async (q: string) => {
      if (!api) return
      const ticket = ++listRequest.current
      const r = await call(() => api.listContacts(q.trim() || undefined))
      if (ticket !== listRequest.current) return
      loadedOnce.current = true
      if (r.ok) {
        setContacts((Array.isArray(r.value) ? r.value : []).map(normalize))
        setListError('')
      } else {
        setContacts((list) => list ?? [])
        setListError(r.error ?? '')
      }
    },
    [api],
  )

  const reload = useCallback(() => {
    void loadMeta()
    void loadContacts(queryRef.current)
  }, [loadMeta, loadContacts])

  // the search asks the main process (it also matches fields the list does
  // not show), a moment after the user stops typing
  useEffect(() => {
    queryRef.current = query
    const timer = setTimeout(
      () => void loadContacts(query),
      loadedOnce.current ? SEARCH_DEBOUNCE_MS : 0,
    )
    return () => clearTimeout(timer)
  }, [query, loadContacts])

  useEffect(() => {
    if (!api) return
    void loadMeta()
    const off = api.onChanged((change) => {
      if (change.kind === 'contacts') reload()
      else if (change.kind === 'sources') void loadMeta()
    })
    return () => {
      if (typeof off === 'function') off()
    }
  }, [api, loadMeta, reload])

  const bookById = useMemo(() => new Map(books.map((b) => [b.id, b])), [books])
  const writableBooks = useMemo(() => books.filter((b) => !b.readOnly), [books])

  // a removed account takes its address books along
  useEffect(() => {
    if (bookFilter && books.length && !bookById.has(bookFilter)) setBookFilter(null)
  }, [bookFilter, books, bookById])

  const collator = useMemo(() => {
    try {
      return new Intl.Collator(lang || undefined, { sensitivity: 'base', numeric: true })
    } catch {
      return new Intl.Collator(undefined, { sensitivity: 'base', numeric: true })
    }
  }, [lang])

  const entries = useMemo<Entry[]>(
    () =>
      (contacts ?? [])
        .filter((c) => !bookFilter || c.addressBookId === bookFilter)
        .map((contact) => ({ contact, label: listLabel(contact) }))
        .sort(
          (a, b) => collator.compare(a.label, b.label) || a.contact.id.localeCompare(b.contact.id),
        ),
    [contacts, bookFilter, collator],
  )

  const letterGroups = useMemo(() => {
    const groups = new Map<string, Entry[]>()
    for (const entry of entries) {
      const letter = groupLetter(entry.label, lang)
      const list = groups.get(letter)
      if (list) list.push(entry)
      else groups.set(letter, [entry])
    }
    return [...groups.entries()]
  }, [entries, lang])

  const bookGroups = useMemo<BookGroup[]>(() => {
    const groups: BookGroup[] = []
    const placed = new Set<string>()
    for (const source of sources) {
      const own = books.filter((b) => b.sourceId === source.id)
      if (source.kind !== 'carddav' && !own.length) continue
      own.forEach((b) => placed.add(b.id))
      groups.push({ key: source.id, name: source.name, source, books: own })
    }
    const rest = books.filter((b) => !placed.has(b.id))
    if (rest.length) groups.push({ key: '', name: t('otherBooks'), books: rest })
    return groups
  }, [sources, books, t])

  const perBook = useMemo(() => {
    const counts = new Map<string, number>()
    for (const c of contacts ?? [])
      counts.set(c.addressBookId, (counts.get(c.addressBookId) ?? 0) + 1)
    return counts
  }, [contacts])

  const selected = entries.find((e) => e.contact.id === selectedId)?.contact ?? null
  // contact ids carry server UIDs; DOM ids get the list position instead
  const positions = useMemo(() => new Map(entries.map((e, i) => [e.contact.id, i])), [entries])
  const optionId = (id: string): string => `${listDomId}-${positions.get(id) ?? 0}`
  const isReadOnly = (c: Contact): boolean =>
    c.readOnly || !!bookById.get(c.addressBookId)?.readOnly

  // new contacts go to the book in view, or the first one that takes them
  const filterBook = bookFilter ? bookById.get(bookFilter) : undefined
  const targetBook = filterBook && !filterBook.readOnly ? filterBook : writableBooks[0]
  const importTargets = filterBook ? (filterBook.readOnly ? [] : [filterBook]) : writableBooks
  const exportTargets = filterBook ? [filterBook] : books

  useEffect(() => {
    if (!selectedId) return
    for (const el of Array.from(
      listRef.current?.querySelectorAll<HTMLElement>('[data-id]') ?? [],
    )) {
      if (el.dataset.id === selectedId) el.scrollIntoView?.({ block: 'nearest' })
    }
  }, [selectedId])

  const openNew = (): void => {
    if (!writableBooks.length) {
      flash(t('noWritableBook'), true)
      return
    }
    setEditor({})
  }

  const remove = async (c: Contact): Promise<void> => {
    if (!api || isReadOnly(c)) return
    if (!window.confirm(t('deleteConfirm', { name: listLabel(c) || t('noName') }))) return
    const r = await call(() => api.deleteContact(c.addressBookId, c.uid))
    if (!r.ok) {
      flash(r.error ?? t('errorPrefix'), true)
      return
    }
    // keep the place in the list: the next contact takes over
    const i = entries.findIndex((e) => e.contact.id === c.id)
    const neighbor = entries[i + 1] ?? entries[i - 1]
    setSelectedId(neighbor && neighbor.contact.id !== c.id ? neighbor.contact.id : null)
    setContacts((list) => list?.filter((x) => x.id !== c.id) ?? null)
    void loadContacts(queryRef.current)
  }

  const runImport = async (book: AddressBookInfo): Promise<void> => {
    setMenu(null)
    if (!api) return
    const r = await call(() => api.importVcf(book.id))
    if (!r.ok) {
      flash(r.error ?? t('errorPrefix'), true)
      return
    }
    const count = r.value ?? 0
    if (count > 0) flash(count === 1 ? t('importedOne') : t('imported', { count: String(count) }))
    reload()
  }

  const runExport = async (book: AddressBookInfo): Promise<void> => {
    setMenu(null)
    if (!api) return
    const r = await call(() => api.exportVcf(book.id))
    if (!r.ok) flash(r.error ?? t('errorPrefix'), true)
    else if (r.value) flash(t('exported', { path: r.value }))
  }

  const sync = async (): Promise<void> => {
    if (!api || syncing) return
    setSyncing(true)
    const r = await call(() => api.sync())
    setSyncing(false)
    if (r.ok) flash(t('synced'))
    else flash(r.error ?? t('errorPrefix'), true)
    reload()
  }

  const removeSource = async (source: PimSource): Promise<void> => {
    if (!api || !window.confirm(t('removeSourceConfirm', { name: source.name }))) return
    try {
      await api.removeSource(source.id)
    } catch (err) {
      flash(errorText(err), true)
    }
    reload()
  }

  const copy = (text: string): void => {
    void navigator.clipboard
      ?.writeText(text)
      .then(() => flash(t('copied')))
      .catch(() => undefined)
  }

  const onListKey = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!entries.length) return
    const i = entries.findIndex((x) => x.contact.id === selectedId)
    let next = -1
    if (e.key === 'ArrowDown') next = i < 0 ? 0 : Math.min(entries.length - 1, i + 1)
    else if (e.key === 'ArrowUp') next = i < 0 ? 0 : Math.max(0, i - 1)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = entries.length - 1
    else if (e.key === 'Enter' && selected && !isReadOnly(selected)) {
      e.preventDefault()
      setEditor({ contact: selected })
      return
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
      e.preventDefault()
      void remove(selected)
      return
    }
    if (next < 0) return
    e.preventDefault()
    setSelectedId(entries[next]!.contact.id)
  }

  const toolMenu = (
    kind: 'import' | 'export',
    targets: AddressBookInfo[],
    run: (book: AddressBookInfo) => Promise<void>,
    icon: ReactNode,
    label: string,
    hint: (book: string) => string,
  ): ReactElement => (
    <div
      className="menu-anchor"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMenu(null)
      }}
    >
      <button
        type="button"
        className={`tool${menu === kind ? ' on' : ''}`}
        disabled={!targets.length}
        title={targets.length === 1 ? hint(targets[0]!.name) : label}
        aria-haspopup={targets.length > 1 ? 'menu' : undefined}
        aria-expanded={targets.length > 1 ? menu === kind : undefined}
        onClick={() => {
          if (targets.length === 1) void run(targets[0]!)
          else setMenu(menu === kind ? null : kind)
        }}
      >
        {icon}
        <span>{label}</span>
      </button>
      {menu === kind && targets.length > 1 && (
        <ul className="dropdown" role="menu" aria-label={t('chooseBook')}>
          {targets.map((b) => (
            <li key={b.id} role="none">
              <button
                type="button"
                role="menuitem"
                title={hint(b.name)}
                onClick={() => void run(b)}
              >
                {b.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  if (!api) {
    return (
      <div className="ct-app ct-unavailable">
        <p className="ct-empty">{t('unavailable')}</p>
      </div>
    )
  }

  const countText =
    entries.length === 1 ? t('countOne') : t('count', { count: String(entries.length) })
  const nothingYet = contacts !== null && contacts.length === 0 && !query.trim()

  return (
    <div
      className="ct-app"
      onKeyDown={(e) => {
        if (editor || sourceDialog) return
        if (e.key === 'Escape' && menu) {
          setMenu(null)
          return
        }
        const el = e.target as HTMLElement
        const typing = el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)
        if (!typing && e.key === 'n' && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault()
          openNew()
        }
      }}
    >
      <div className="ct-toolbar">
        <button
          type="button"
          className="tool"
          onClick={openNew}
          disabled={!writableBooks.length}
          title={t('newContact')}
        >
          <IconPlus /> <span>{t('newContact')}</span>
        </button>
        <span className="sep" />
        {toolMenu('import', importTargets, runImport, <IconImport />, t('importVcf'), (book) =>
          t('importInto', { book }),
        )}
        {toolMenu('export', exportTargets, runExport, <IconExport />, t('exportVcf'), (book) =>
          t('exportFrom', { book }),
        )}
        <span className="sep" />
        <button
          type="button"
          className="tool"
          onClick={() => void sync()}
          disabled={syncing}
          title={t('refresh')}
        >
          <IconRefresh /> <span>{syncing ? t('syncing') : t('refresh')}</span>
        </button>
      </div>

      <aside className="ct-sidebar" aria-label={t('addressBooks')}>
        <button
          type="button"
          className={`ct-book ct-book-all${bookFilter === null ? ' active' : ''}`}
          aria-current={bookFilter === null ? 'true' : undefined}
          onClick={() => setBookFilter(null)}
        >
          <IconPeople size={16} />
          <span className="ct-book-name">{t('allContacts')}</span>
          {!query.trim() && contacts && <span className="ct-book-count">{contacts.length}</span>}
        </button>
        {bookGroups.map((group) => (
          <section key={group.key || 'other'} className="ct-source">
            <div className="ct-source-row">
              <span
                className="ct-source-name"
                title={
                  group.source?.lastSync
                    ? t('lastSync', { time: new Date(group.source.lastSync).toLocaleString(lang) })
                    : group.name
                }
              >
                {group.name}
              </span>
              {group.source && group.source.kind !== 'local' && (
                <>
                  <button
                    type="button"
                    className="icon-btn"
                    title={t('editSource')}
                    aria-label={`${t('editSource')}: ${group.name}`}
                    onClick={() => setSourceDialog({ source: group.source })}
                  >
                    <IconGear />
                  </button>
                  <button
                    type="button"
                    className="icon-btn"
                    title={t('removeSource')}
                    aria-label={`${t('removeSource')}: ${group.name}`}
                    onClick={() => void removeSource(group.source!)}
                  >
                    <IconTrash />
                  </button>
                </>
              )}
            </div>
            {group.source?.error && (
              <p className="ct-source-error" title={group.source.error}>
                {t('syncFailed')}: {group.source.error}
              </p>
            )}
            <ul className="ct-books">
              {group.books.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    className={`ct-book${bookFilter === b.id ? ' active' : ''}`}
                    aria-current={bookFilter === b.id ? 'true' : undefined}
                    title={b.readOnly ? `${b.name} (${t('readOnly')})` : b.name}
                    onClick={() => setBookFilter(b.id)}
                  >
                    <span className="ct-book-name">{b.name}</span>
                    {b.readOnly && (
                      <span className="ct-book-lock">
                        <IconLock />
                      </span>
                    )}
                    {!query.trim() && contacts && (
                      <span className="ct-book-count">{perBook.get(b.id) ?? 0}</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <button
          type="button"
          className="add-account ct-add-book"
          onClick={() => setSourceDialog({})}
        >
          <IconPlus /> {t('addBook')}
        </button>
      </aside>

      <section className="ct-list-pane">
        <div className="ct-list-head">
          <label className="search ct-search">
            <IconSearch />
            <input
              type="search"
              value={query}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // from the search box straight into the results
                if ((e.key === 'ArrowDown' || e.key === 'Enter') && entries.length) {
                  e.preventDefault()
                  if (!selected) setSelectedId(entries[0]!.contact.id)
                  listRef.current?.focus()
                } else if (e.key === 'Escape' && query) {
                  e.preventDefault()
                  setQuery('')
                }
              }}
            />
          </label>
        </div>
        <div className="ct-count" aria-live="polite">
          {contacts === null ? t('loading') : countText}
          {filterBook ? ` · ${filterBook.name}` : ''}
        </div>
        {listError && (
          <p className="ct-error" role="alert">
            {listError}
          </p>
        )}
        <div
          ref={listRef}
          className="ct-list"
          role="listbox"
          tabIndex={0}
          aria-label={t('title')}
          aria-activedescendant={selected ? optionId(selected.id) : undefined}
          onKeyDown={onListKey}
        >
          {contacts !== null && !entries.length && (
            <p className="ct-empty">{query.trim() ? t('noResults') : t('noContacts')}</p>
          )}
          {letterGroups.map(([letter, group]) => (
            <div key={letter} role="group" aria-label={letter}>
              <div className="ct-letter" aria-hidden>
                {letter}
              </div>
              {group.map((entry) => {
                const c = entry.contact
                const sub = c.emails[0]?.value || c.organization || c.phones[0]?.value || ''
                return (
                  <div
                    key={c.id}
                    id={optionId(c.id)}
                    data-id={c.id}
                    role="option"
                    aria-selected={c.id === selectedId}
                    className={`ct-row${c.id === selectedId ? ' selected' : ''}`}
                    onClick={() => setSelectedId(c.id)}
                    onDoubleClick={() => !isReadOnly(c) && setEditor({ contact: c })}
                  >
                    <Avatar label={entry.label} photo={c.photo} size="sm" />
                    <span className="ct-row-text">
                      <span className="ct-row-name">{entry.label || t('noName')}</span>
                      {sub && sub !== entry.label && <span className="ct-row-sub">{sub}</span>}
                    </span>
                  </div>
                )
              })}
            </div>
          ))}
        </div>
      </section>

      <section className="ct-detail" aria-label={selected ? listLabel(selected) : undefined}>
        {selected ? (
          <ContactCard
            t={t}
            lang={lang}
            contact={selected}
            book={bookById.get(selected.addressBookId)}
            readOnly={isReadOnly(selected)}
            onWriteMail={(email) => onWriteMail(formatRecipient(nameOf(selected), email))}
            onEdit={() => setEditor({ contact: selected })}
            onDelete={() => void remove(selected)}
            onCopy={copy}
          />
        ) : nothingYet ? (
          <div className="ct-welcome">
            <IconPeople size={40} />
            <h1>{t('emptyTitle')}</h1>
            <p>{t('emptyBody')}</p>
            <div className="ct-welcome-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={openNew}
                disabled={!writableBooks.length}
              >
                <IconPlus /> {t('newContact')}
              </button>
              <button type="button" className="btn" onClick={() => setSourceDialog({})}>
                {t('addBook')}
              </button>
            </div>
          </div>
        ) : (
          <p className="ct-empty">{t('noSelection')}</p>
        )}
      </section>

      {editor && (
        <ContactEditor
          lang={lang}
          contact={editor.contact}
          books={writableBooks}
          defaultBookId={targetBook?.id}
          onClose={() => setEditor(null)}
          onSaved={(saved) => {
            const fresh = normalize(saved)
            const created = !editor.contact
            setEditor(null)
            // show the saved version at once; the reload below confirms it
            setContacts((list) =>
              list ? [...list.filter((c) => c.id !== fresh.id), fresh] : [fresh],
            )
            setSelectedId(fresh.id)
            if (bookFilter && bookFilter !== fresh.addressBookId) setBookFilter(null)
            if (created && query) setQuery('')
            else void loadContacts(queryRef.current)
          }}
        />
      )}
      {sourceDialog && (
        <SourceDialog
          lang={lang}
          kinds={['carddav']}
          source={sourceDialog.source}
          onClose={() => setSourceDialog(null)}
          onSaved={() => {
            setSourceDialog(null)
            reload()
          }}
        />
      )}
      {notice && (
        <div className={`toast${notice.error ? ' toast-error' : ''}`} role="status">
          {notice.text}
        </div>
      )}
    </div>
  )
}

function ContactCard({
  t,
  lang,
  contact: c,
  book,
  readOnly,
  onWriteMail,
  onEdit,
  onDelete,
  onCopy,
}: {
  t: T
  lang: string
  contact: Contact
  book?: AddressBookInfo
  readOnly: boolean
  onWriteMail(email: string): void
  onEdit(): void
  onDelete(): void
  onCopy(text: string): void
}): ReactElement {
  const label = listLabel(c)
  const role = [c.jobTitle, c.organization].map((s) => s.trim()).filter(Boolean)
  const kind = (v: LabeledValue, fallback: string): string => typeName(t, v.type) || fallback
  return (
    <article className="ct-card">
      <header className="ct-card-head">
        <Avatar label={label} photo={c.photo} size="lg" />
        <div className="ct-card-title">
          <h2>{label || t('noName')}</h2>
          {role.length > 0 && <p className="ct-card-sub">{role.join(' · ')}</p>}
          {book && (
            <p className="ct-card-book">
              {book.name}
              {readOnly && (
                <>
                  {' · '}
                  <IconLock /> {t('readOnly')}
                </>
              )}
            </p>
          )}
        </div>
        <div className="ct-card-actions">
          <button type="button" className="btn" onClick={onEdit} disabled={readOnly}>
            {t('edit')}
          </button>
          <button type="button" className="btn btn-danger" onClick={onDelete} disabled={readOnly}>
            {t('delete')}
          </button>
        </div>
      </header>
      <dl className="ct-fields">
        {c.emails.map((e, i) => (
          <div key={`e${i}`} className="ct-field">
            <dt>{kind(e, t('email'))}</dt>
            <dd>
              <button
                type="button"
                className="link-btn ct-email"
                title={t('writeMail', { email: e.value })}
                onClick={() => onWriteMail(e.value)}
              >
                {e.value}
              </button>
            </dd>
          </div>
        ))}
        {c.phones.map((p, i) => {
          const href = telHref(p.value)
          return (
            <div key={`p${i}`} className="ct-field">
              <dt>{kind(p, t('phone'))}</dt>
              <dd className="ct-phone">
                {href ? (
                  <a
                    href={href}
                    target="_blank"
                    rel="noreferrer"
                    title={t('call', { phone: p.value })}
                  >
                    {p.value}
                  </a>
                ) : (
                  p.value
                )}
                <button
                  type="button"
                  className="icon-btn ct-copy"
                  title={t('copy')}
                  aria-label={`${t('copy')}: ${p.value}`}
                  onClick={() => onCopy(p.value)}
                >
                  <IconCopy />
                </button>
              </dd>
            </div>
          )
        })}
        {c.birthday && (
          <div className="ct-field">
            <dt>{t('birthday')}</dt>
            <dd>{formatBirthday(c.birthday, lang)}</dd>
          </div>
        )}
        {c.addresses.map((a, i) => (
          <div key={`a${i}`} className="ct-field">
            <dt>{kind(a, t('address'))}</dt>
            <dd>
              <address className="ct-address">{a.value}</address>
            </dd>
          </div>
        ))}
        {c.note.trim() && (
          <div className="ct-field">
            <dt>{t('note')}</dt>
            <dd className="ct-note">{c.note}</dd>
          </div>
        )}
      </dl>
    </article>
  )
}
