import { useState, type ReactElement } from 'react'
import type { MailAccountInfo } from '../../shared/ipc'
import type { Draft } from '../format'
import type { MailStringKey } from '../i18n'
import { AddressInput } from './AddressInput'
import { IconClose, IconPaperclip, IconSend } from './icons'

type T = (key: MailStringKey, vars?: Record<string, string>) => string

interface Props {
  t: T
  lang: string
  accounts: MailAccountInfo[]
  accountId: string
  draft: Draft
  sending: boolean
  onAccount(id: string): void
  onChange(draft: Draft): void
  onSend(): void
  onDiscard(): void
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function Composer({
  t,
  lang,
  accounts,
  accountId,
  draft,
  sending,
  onAccount,
  onChange,
  onSend,
  onDiscard,
}: Props): ReactElement {
  const [showCc, setShowCc] = useState(!!(draft.cc || draft.bcc))
  const [showQuoted, setShowQuoted] = useState(false)
  const set = (patch: Partial<Draft>): void => onChange({ ...draft, ...patch })

  const attach = async (): Promise<void> => {
    const paths = await window.mailApi.pickAttachments()
    if (paths.length)
      set({
        attachments: [...draft.attachments, ...paths.filter((p) => !draft.attachments.includes(p))],
      })
  }

  return (
    <section
      className="composer"
      aria-label={t('newMail')}
      onKeyDown={(e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
          e.preventDefault()
          onSend()
        }
      }}
    >
      <div className="composer-bar">
        <button className="btn btn-primary" onClick={onSend} disabled={sending}>
          <IconSend /> {sending ? t('sending') : t('send')}
        </button>
        <button className="btn" onClick={() => void attach()} disabled={sending}>
          <IconPaperclip /> {t('attach')}
        </button>
        <span className="spacer" />
        <button className="btn" onClick={onDiscard} disabled={sending}>
          {t('discard')}
        </button>
      </div>
      <div className="composer-fields">
        {accounts.length > 1 && (
          <label className="field">
            <span>{t('from')}</span>
            <select value={accountId} onChange={(e) => onAccount(e.target.value)}>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          <span>{t('to')}</span>
          <AddressInput
            value={draft.to}
            onChange={(to) => set({ to })}
            lang={lang}
            autoFocus={!draft.to}
            ariaLabel={t('to')}
          />
          {!showCc && (
            <button type="button" className="link-btn" onClick={() => setShowCc(true)}>
              {t('showCcBcc')}
            </button>
          )}
        </label>
        {showCc && (
          <>
            <label className="field">
              <span>{t('cc')}</span>
              <AddressInput
                value={draft.cc}
                onChange={(cc) => set({ cc })}
                lang={lang}
                ariaLabel={t('cc')}
              />
            </label>
            <label className="field">
              <span>{t('bcc')}</span>
              <AddressInput
                value={draft.bcc}
                onChange={(bcc) => set({ bcc })}
                lang={lang}
                ariaLabel={t('bcc')}
              />
            </label>
          </>
        )}
        <label className="field">
          <span>{t('subject')}</span>
          <input value={draft.subject} onChange={(e) => set({ subject: e.target.value })} />
        </label>
      </div>
      {draft.attachments.length > 0 && (
        <ul className="attachments composer-attachments">
          {draft.attachments.map((path) => (
            <li key={path} className="attachment-chip">
              <IconPaperclip />
              <span title={path}>{basename(path)}</span>
              <button
                className="icon-btn"
                title={t('delete')}
                onClick={() => set({ attachments: draft.attachments.filter((p) => p !== path) })}
              >
                <IconClose />
              </button>
            </li>
          ))}
        </ul>
      )}
      <textarea
        className="composer-body"
        value={draft.text}
        onChange={(e) => set({ text: e.target.value })}
        autoFocus={!!draft.to}
      />
      {draft.quoted && (
        <div className="composer-quoted">
          <button type="button" className="link-btn" onClick={() => setShowQuoted(!showQuoted)}>
            {showQuoted ? '▾' : '▸'} {t('quotedOriginal')}
          </button>
          {showQuoted && <pre>{draft.quoted}</pre>}
        </div>
      )}
    </section>
  )
}
