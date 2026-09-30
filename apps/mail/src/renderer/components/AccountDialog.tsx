import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { MailAccountInfo, MailAccountInput, ServerSettings } from '../../shared/ipc'
import type { MailStringKey } from '../i18n'

type T = (key: MailStringKey, vars?: Record<string, string>) => string

interface Props {
  t: T
  account?: MailAccountInfo
  onClose(): void
  onSaved(account: MailAccountInfo): void
  onRemove?(account: MailAccountInfo): void
}

const blankServer = (port: number): ServerSettings => ({ host: '', port, secure: true })

export function AccountDialog({ t, account, onClose, onSaved, onRemove }: Props): ReactElement {
  const [name, setName] = useState(account?.name ?? '')
  const [email, setEmail] = useState(account?.email ?? '')
  const [user, setUser] = useState(account?.user ?? '')
  const [password, setPassword] = useState('')
  const [imap, setImap] = useState<ServerSettings>(account?.imap ?? blankServer(993))
  const [smtp, setSmtp] = useState<ServerSettings>(account?.smtp ?? blankServer(465))
  const [advanced, setAdvanced] = useState(!!account)
  const [note, setNote] = useState('')
  const [status, setStatus] = useState<{ kind: 'ok' | 'error' | 'busy'; text: string } | null>(null)
  const serversTouched = useRef(!!account)
  const userTouched = useRef(!!account)

  // fill the servers from the address until the user edits them by hand
  useEffect(() => {
    if (serversTouched.current || !email.includes('@')) return
    let live = true
    const timer = setTimeout(() => {
      void window.mailApi.guessServers(email).then((guess) => {
        if (!live || !guess || serversTouched.current) return
        setImap(guess.imap)
        setSmtp(guess.smtp)
        setNote(guess.note ?? '')
      })
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [email])

  const input = (): MailAccountInput => ({
    id: account?.id,
    name,
    email,
    user: userTouched.current ? user : user || email,
    password,
    imap,
    smtp,
  })

  const test = async (): Promise<void> => {
    setStatus({ kind: 'busy', text: t('formTesting') })
    const r = await window.mailApi.testAccount(input())
    setStatus(r.ok ? { kind: 'ok', text: t('formTestOk') } : { kind: 'error', text: r.error ?? '' })
  }

  const save = async (): Promise<void> => {
    setStatus({ kind: 'busy', text: t('formTesting') })
    const tested = await window.mailApi.testAccount(input())
    if (!tested.ok) {
      setStatus({ kind: 'error', text: tested.error ?? '' })
      setAdvanced(true)
      return
    }
    const r = await window.mailApi.saveAccount(input())
    if (!r.ok || !r.value) {
      setStatus({ kind: 'error', text: r.error ?? '' })
      return
    }
    onSaved(r.value)
  }

  const server = (
    label: string,
    value: ServerSettings,
    set: (s: ServerSettings) => void,
  ): ReactElement => (
    <fieldset className="acc-server">
      <legend>{label}</legend>
      <label className="acc-host">
        <span>{t('formHost')}</span>
        <input
          value={value.host}
          onChange={(e) => {
            serversTouched.current = true
            set({ ...value, host: e.target.value })
          }}
          spellCheck={false}
        />
      </label>
      <label className="acc-port">
        <span>{t('formPort')}</span>
        <input
          type="number"
          value={value.port}
          onChange={(e) => {
            serversTouched.current = true
            set({ ...value, port: Number(e.target.value) })
          }}
        />
      </label>
      <label className="acc-check">
        <input
          type="checkbox"
          checked={value.secure}
          onChange={(e) => {
            serversTouched.current = true
            set({ ...value, secure: e.target.checked })
          }}
        />
        <span>{t('formSecure')}</span>
      </label>
    </fieldset>
  )

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form
        className="modal acc-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={account ? t('editAccount') : t('addAccount')}
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
        onKeyDown={(e) => e.key === 'Escape' && onClose()}
      >
        <h2>{account ? t('editAccount') : t('addAccount')}</h2>
        <label>
          <span>{t('formEmail')}</span>
          <input
            type="email"
            value={email}
            autoFocus={!account}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </label>
        <label>
          <span>{t('formName')}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label>
          <span>{t('formPassword')}</span>
          <input
            type="password"
            value={password}
            placeholder={account?.hasPassword ? t('formPasswordKeep') : ''}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>
        {note && <p className="acc-note">{note}</p>}
        <button type="button" className="link-btn" onClick={() => setAdvanced(!advanced)}>
          {t('formAdvanced')} {advanced ? '▴' : '▾'}
        </button>
        {advanced && (
          <div className="acc-advanced">
            <label>
              <span>{t('formUser')}</span>
              <input
                value={user}
                placeholder={email}
                onChange={(e) => {
                  userTouched.current = true
                  setUser(e.target.value)
                }}
                spellCheck={false}
              />
            </label>
            {server(t('formImap'), imap, setImap)}
            {server(t('formSmtp'), smtp, setSmtp)}
          </div>
        )}
        <p className="acc-privacy">{t('formPrivacy')}</p>
        {status && <p className={`acc-status acc-status-${status.kind}`}>{status.text}</p>}
        <div className="modal-actions">
          {account && onRemove && (
            <button type="button" className="btn btn-danger" onClick={() => onRemove(account)}>
              {t('removeAccount')}
            </button>
          )}
          <span className="spacer" />
          <button
            type="button"
            className="btn"
            onClick={() => void test()}
            disabled={status?.kind === 'busy'}
          >
            {t('formTest')}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            {t('formCancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={status?.kind === 'busy'}>
            {t('formSave')}
          </button>
        </div>
      </form>
    </div>
  )
}
