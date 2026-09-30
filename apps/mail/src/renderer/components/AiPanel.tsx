import { useEffect, useRef, useState, type ReactElement } from 'react'
import type { EventInput } from '../../shared/pim'
import { AiUnconfiguredError, prompts, runAi, type AiRun, type MailContext } from '../ai'
import { draftEventFromMail } from '../calendar/ai-calendar'
import { languageName, type MailStringKey } from '../i18n'
import { IconClose, SuiteMark } from './icons'

type T = (key: MailStringKey, vars?: Record<string, string>) => string

export type AiMode = 'idle' | 'reading' | 'compose'

interface Props {
  t: T
  lang: string
  mode: AiMode
  /** the message being read, or the one the draft answers */
  mail: MailContext | null
  /** the user's own part of the draft (without the quoted original) */
  draft: string
  senderName: string
  onApplyDraft(text: string): void
  onStartReply(text: string): void
  /** hand an appointment found in the mail to the calendar */
  onCreateEvent?(draft: Partial<EventInput>): void
  onClose(): void
}

type Output = { kind: 'draft' | 'reply' | 'info'; text: string }

export function AiPanel(props: Props): ReactElement {
  const { t, lang, mode, mail, draft, senderName } = props
  const [output, setOutput] = useState<Output | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [prompt, setPrompt] = useState('')
  const [replyGoal, setReplyGoal] = useState('')
  const run = useRef<AiRun | null>(null)
  const language = languageName(lang)
  const otherLanguage = lang.startsWith('de') ? 'English' : 'German'

  // a new message or a new draft session starts with a clean panel
  const contextKey = `${mode}\n${mail?.subject ?? ''}\n${mail?.date ?? ''}`
  useEffect(() => {
    run.current?.cancel()
    run.current = null
    setOutput(null)
    setError('')
    setBusy(false)
  }, [contextKey])

  useEffect(() => () => run.current?.cancel(), [])

  const start = (kind: Output['kind'], p: { system: string; user: string }): void => {
    run.current?.cancel()
    setError('')
    setBusy(true)
    setOutput({ kind, text: '' })
    const current = runAi(p.system, p.user, (text) => setOutput({ kind, text }))
    run.current = current
    current.done
      .then((text) => {
        if (run.current !== current) return
        setOutput({ kind, text })
      })
      .catch((err: Error) => {
        if (run.current !== current) return
        setOutput((o) => (o?.text ? o : null))
        setError(err instanceof AiUnconfiguredError ? t('aiNoModel') : err.message)
      })
      .finally(() => {
        if (run.current === current) {
          run.current = null
          setBusy(false)
        }
      })
  }

  const createEvent = async (context: MailContext): Promise<void> => {
    run.current?.cancel()
    run.current = null
    setError('')
    setOutput(null)
    setBusy(true)
    try {
      const draft = await draftEventFromMail(context, lang)
      if (draft) props.onCreateEvent?.(draft)
      else setError(t('aiNoEvent'))
    } catch (err) {
      setError(err instanceof AiUnconfiguredError ? t('aiNoModel') : (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const stop = (): void => {
    run.current?.cancel()
    run.current = null
    setBusy(false)
  }

  const rewrite = (instruction: string): void => {
    start('draft', prompts.rewrite(draft, instruction, mail ?? undefined))
  }

  const submitPrompt = (): void => {
    const q = prompt.trim()
    if (!q) return
    setPrompt('')
    if (mode === 'reading' && mail) start('info', prompts.ask(mail, q, language))
    else if (mode === 'compose') rewrite(q)
  }

  return (
    <aside className="ai-panel-mail" aria-label={t('aiTitle')}>
      <header className="ai-head">
        <SuiteMark size={20} />
        <span>{t('aiTitle')}</span>
        <button className="icon-btn" title={t('formCancel')} onClick={props.onClose}>
          <IconClose />
        </button>
      </header>

      <div className="ai-body">
        {mode === 'idle' && <p className="ai-hint">{t('aiIdleHint')}</p>}

        {mode === 'reading' && mail && (
          <>
            <p className="ai-hint">{t('aiReadingHint')}</p>
            <div className="ai-chips">
              <button
                disabled={busy}
                onClick={() => start('info', prompts.summarize(mail, language))}
              >
                {t('aiSummarize')}
              </button>
              <button
                disabled={busy}
                onClick={() => start('info', prompts.actionItems(mail, language))}
              >
                {t('aiActionItems')}
              </button>
              <button
                disabled={busy}
                onClick={() => start('info', prompts.translate(mail, language))}
              >
                {t('aiTranslate')}
              </button>
              {props.onCreateEvent && (
                <button disabled={busy} onClick={() => void createEvent(mail)}>
                  {t('aiCreateEvent')}
                </button>
              )}
            </div>
            <div className="ai-reply-box">
              <input
                value={replyGoal}
                placeholder={t('aiReplyInstruction')}
                onChange={(e) => setReplyGoal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !busy)
                    start('reply', prompts.draftReply(mail, senderName, replyGoal))
                }}
              />
              <button
                className="btn btn-ai"
                disabled={busy}
                onClick={() => start('reply', prompts.draftReply(mail, senderName, replyGoal))}
              >
                {t('aiDraftReply')}
              </button>
            </div>
          </>
        )}

        {mode === 'compose' && (
          <>
            <p className="ai-hint">{t('aiComposeHint')}</p>
            <div className="ai-chips">
              <button
                disabled={busy || !draft.trim()}
                onClick={() => rewrite('Make it clear, polite and professional.')}
              >
                {t('aiImprove')}
              </button>
              <button
                disabled={busy || !draft.trim()}
                onClick={() => rewrite('Make it noticeably shorter; keep every fact.')}
              >
                {t('aiShorter')}
              </button>
              <button
                disabled={busy || !draft.trim()}
                onClick={() => rewrite('Make it warmer and friendlier.')}
              >
                {t('aiFriendlier')}
              </button>
              <button
                disabled={busy || !draft.trim()}
                onClick={() =>
                  rewrite('Fix spelling, grammar and punctuation only; change nothing else.')
                }
              >
                {t('aiProofread')}
              </button>
              <button
                disabled={busy || !draft.trim()}
                onClick={() => rewrite(`Translate it into ${otherLanguage}.`)}
              >
                {t('aiTranslateEn')}
              </button>
              <button
                disabled={busy || !draft.trim()}
                onClick={() =>
                  rewrite(
                    `The draft is rough notes. Turn them into a complete, well-structured email in ${language} unless the notes are in another language; add a greeting and a sign-off with the name ${senderName || 'of the sender'}.`,
                  )
                }
              >
                {t('aiWriteFromNotes')}
              </button>
            </div>
          </>
        )}

        {error && <p className="ai-error">{error}</p>}

        {output && (
          <div className="ai-output">
            {busy && !output.text && <p className="ai-thinking">{t('aiThinking')}</p>}
            {output.text && <div className="ai-text">{output.text}</div>}
            <div className="ai-output-actions">
              {busy ? (
                <button className="btn" onClick={stop}>
                  {t('aiStop')}
                </button>
              ) : (
                <>
                  {output.kind === 'draft' && output.text && (
                    <button
                      className="btn btn-primary"
                      onClick={() => props.onApplyDraft(output.text)}
                    >
                      {t('aiApply')}
                    </button>
                  )}
                  {output.kind === 'reply' && output.text && (
                    <button
                      className="btn btn-primary"
                      onClick={() => props.onStartReply(output.text)}
                    >
                      {t('aiInsertReply')}
                    </button>
                  )}
                  {output.text && (
                    <button
                      className="btn"
                      onClick={() => void navigator.clipboard?.writeText(output.text)}
                    >
                      {t('aiCopy')}
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {mode !== 'idle' && (
        <form
          className="ai-prompt"
          onSubmit={(e) => {
            e.preventDefault()
            submitPrompt()
          }}
        >
          <textarea
            value={prompt}
            rows={2}
            placeholder={mode === 'reading' ? t('aiPromptReading') : t('aiPromptCompose')}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submitPrompt()
              }
            }}
          />
          <button type="submit" className="btn btn-ai" disabled={busy || !prompt.trim()}>
            ↵
          </button>
        </form>
      )}
    </aside>
  )
}
