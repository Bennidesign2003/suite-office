import { useEffect, useId, useMemo, useRef, useState, type ReactElement } from 'react'
import type { MailAccountInfo } from '../../shared/ipc'
import type { PimSource, PimSourceInput, SourceKind } from '../../shared/pim'
import { pimTranslator, type PimStringKey } from './i18n'
import './pim.css'

/**
 * Connect a CalDAV / CardDAV account or an .ics subscription. Shared by the
 * calendar (kinds caldav + ics) and the contacts module (carddav). A mail
 * account can lend its login, and its address tells us where the provider
 * serves calendars and address books.
 */

interface SourceDialogProps {
  lang: string
  kinds: SourceKind[]
  /** edit this source instead of adding one */
  source?: PimSource
  onClose(): void
  onSaved(source: PimSource): void
}

const KIND_LABEL: Record<SourceKind, PimStringKey> = {
  caldav: 'kindCaldav',
  carddav: 'kindCarddav',
  ics: 'kindIcs',
  local: 'kindLocal',
}

const KIND_HINT: Record<SourceKind, PimStringKey> = {
  caldav: 'hintCaldav',
  carddav: 'hintCarddav',
  ics: 'hintIcs',
  local: 'hintLocal',
}

type Status = { kind: 'ok' | 'error' | 'busy'; text: string }

export function SourceDialog({
  lang,
  kinds,
  source,
  onClose,
  onSaved,
}: SourceDialogProps): ReactElement {
  const t = useMemo(() => pimTranslator(lang), [lang])
  const editing = !!source
  const offered = kinds.length ? kinds : (['caldav'] as SourceKind[])
  const [kind, setKind] = useState<SourceKind>(source?.kind ?? offered[0]!)
  const [name, setName] = useState(source?.name ?? '')
  const [url, setUrl] = useState(source?.url ?? '')
  const [accounts, setAccounts] = useState<MailAccountInfo[]>([])
  const [login, setLogin] = useState<'mail' | 'own'>(editing ? 'own' : 'mail')
  const [accountId, setAccountId] = useState('')
  const [user, setUser] = useState(source?.user ?? '')
  const [password, setPassword] = useState('')
  const [icsAuth, setIcsAuth] = useState(source?.kind === 'ics' && !!source.user)
  const [note, setNote] = useState('')
  const [status, setStatus] = useState<Status | null>(null)
  const urlTouched = useRef(!!source?.url)
  const titleId = useId()

  const isDav = kind === 'caldav' || kind === 'carddav'
  const account = accounts.find((a) => a.id === accountId) ?? null
  const usesMail = isDav && login === 'mail' && !!account
  const busy = status?.kind === 'busy'

  useEffect(() => {
    let live = true
    window.mailApi
      .listAccounts()
      .then((list) => {
        if (!live) return
        setAccounts(list)
        if (list[0]) setAccountId((id) => id || list[0]!.id)
        else setLogin('own')
      })
      .catch(() => live && setLogin('own'))
    return () => {
      live = false
    }
  }, [])

  // where does the provider serve CalDAV/CardDAV? asked with the mail
  // account's address, or with a user name that is an address
  const guessFrom = !isDav ? '' : usesMail ? account!.email : user.includes('@') ? user.trim() : ''
  useEffect(() => {
    if (!guessFrom) {
      setNote('')
      return
    }
    let live = true
    const timer = setTimeout(() => {
      window.pimApi
        .guessDav(guessFrom)
        .then((guess) => {
          if (!live) return
          const guessed = kind === 'carddav' ? guess.carddav : guess.caldav
          if (!urlTouched.current) setUrl(guessed ?? '')
          setNote(guess.note ?? '')
        })
        .catch(() => undefined)
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [guessFrom, kind])

  const chooseKind = (next: SourceKind): void => {
    if (next === kind) return
    setKind(next)
    setStatus(null)
    // a guessed server address means nothing for a subscription and vice versa
    if (!urlTouched.current) setUrl('')
  }

  const input = (): PimSourceInput => {
    const base: PimSourceInput = {
      ...(source ? { id: source.id } : {}),
      kind,
      name: name.trim() || (usesMail ? account!.email : ''),
      url: url.trim(),
    }
    if (usesMail) return { ...base, mailAccountId: account!.id }
    if (kind === 'ics' && !icsAuth) return base
    return { ...base, user: user.trim(), password }
  }

  const check = (): boolean => {
    if (url.trim()) return true
    setStatus({ kind: 'error', text: t('urlMissing') })
    return false
  }

  const test = async (): Promise<void> => {
    if (!check()) return
    setStatus({ kind: 'busy', text: t('testing') })
    try {
      const r = await window.pimApi.testSource(input())
      setStatus(r.ok ? { kind: 'ok', text: t('testOk') } : { kind: 'error', text: r.error ?? '' })
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  const save = async (): Promise<void> => {
    if (busy || !check()) return
    setStatus({ kind: 'busy', text: t('saving') })
    try {
      const r = await window.pimApi.saveSource(input())
      if (!r.ok || !r.value) {
        setStatus({ kind: 'error', text: r.error ?? '' })
        return
      }
      onSaved(r.value)
    } catch (err) {
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) })
    }
  }

  const title = editing
    ? t('editSource')
    : offered.every((k) => k === 'carddav')
      ? t('addAddressBookSource')
      : offered.every((k) => k === 'caldav' || k === 'ics')
        ? t('addCalendarSource')
        : t('addSource')

  const credentials = (
    <div className="pim-cred">
      <label className="pim-field">
        <span>{t('user')}</span>
        <input
          value={user}
          onChange={(e) => setUser(e.target.value)}
          autoComplete="username"
          spellCheck={false}
        />
      </label>
      <label className="pim-field">
        <span>{t('password')}</span>
        <input
          type="password"
          value={password}
          placeholder={source?.hasPassword ? t('passwordKeep') : ''}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
      </label>
    </div>
  )

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <form
        className="modal pim-source-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            onClose()
          }
        }}
      >
        <h2 id={titleId}>{title}</h2>

        {offered.length > 1 && !editing ? (
          <div className="pim-kinds" role="radiogroup" aria-label={t('kind')}>
            {offered.map((k) => (
              <label key={k} className={`pim-kind${k === kind ? ' selected' : ''}`}>
                <input
                  type="radio"
                  name="pim-kind"
                  checked={k === kind}
                  onChange={() => chooseKind(k)}
                />
                <span className="pim-kind-name">{t(KIND_LABEL[k])}</span>
                <span className="pim-kind-hint">{t(KIND_HINT[k])}</span>
              </label>
            ))}
          </div>
        ) : (
          <p className="pim-hint">
            <strong>{t(KIND_LABEL[kind])}</strong> – {t(KIND_HINT[kind])}
          </p>
        )}

        <label className="pim-field">
          <span>{isDav ? t('serverUrl') : t('icsUrl')}</span>
          <input
            value={url}
            inputMode="url"
            placeholder={isDav ? t('serverUrlPlaceholder') : t('icsUrlPlaceholder')}
            autoFocus={!editing}
            spellCheck={false}
            onChange={(e) => {
              urlTouched.current = e.target.value.trim() !== ''
              setUrl(e.target.value)
            }}
          />
        </label>

        <label className="pim-field">
          <span>{t('name')}</span>
          <input
            value={name}
            placeholder={usesMail ? account!.email : t('namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </label>

        {isDav && (
          <fieldset className="pim-login">
            <legend>{t('credentials')}</legend>
            {accounts.length > 0 && (
              <div className="pim-radio-row">
                <label className="pim-radio">
                  <input
                    type="radio"
                    name="pim-login"
                    checked={login === 'mail'}
                    onChange={() => setLogin('mail')}
                  />
                  <span>{t('useMailLogin')}</span>
                </label>
                <select
                  aria-label={t('mailAccount')}
                  value={accountId}
                  disabled={login !== 'mail'}
                  onChange={(e) => setAccountId(e.target.value)}
                >
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <label className="pim-radio">
              <input
                type="radio"
                name="pim-login"
                checked={login === 'own' || accounts.length === 0}
                onChange={() => setLogin('own')}
              />
              <span>{t('ownLogin')}</span>
            </label>
            {(login === 'own' || accounts.length === 0) && credentials}
            <p className="pim-note">{t('appPasswordHint')}</p>
          </fieldset>
        )}

        {kind === 'ics' && (
          <>
            <label className="pim-check">
              <input
                type="checkbox"
                checked={icsAuth}
                onChange={(e) => setIcsAuth(e.target.checked)}
              />
              <span>{t('icsNeedsLogin')}</span>
            </label>
            {icsAuth && credentials}
          </>
        )}

        {note && <p className="pim-note pim-guess">{note}</p>}
        <p className="pim-privacy">{t('privacy')}</p>
        {status && (
          <p
            className={`pim-status pim-status-${status.kind}`}
            role={status.kind === 'error' ? 'alert' : 'status'}
          >
            {status.text}
          </p>
        )}

        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={() => void test()} disabled={busy}>
            {t('test')}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t('cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {t('save')}
          </button>
        </div>
      </form>
    </div>
  )
}
