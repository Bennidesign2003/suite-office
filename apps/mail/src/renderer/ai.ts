import type { AiStreamChunk } from '@genoffice/ai-provider'

/**
 * Suite AI for mail: one-shot streaming prompts through the shell's
 * `ai:stream` (the local Ollama model chosen in Settings). No tools — reading
 * and writing an email is plain text in, plain text out.
 */

const MAX_MAIL_CHARS = 12_000

export interface AiRun {
  cancel(): void
  done: Promise<string>
}

export class AiUnconfiguredError extends Error {}

export function runAi(system: string, user: string, onText: (text: string) => void): AiRun {
  const api = window.mailApi
  const requestId = `mail-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
  let text = ''
  let unsubscribe: () => void = () => undefined
  let settle: { resolve: (t: string) => void; reject: (e: Error) => void } | null = null

  const done = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject }
  })
  const finish = (err?: Error): void => {
    unsubscribe()
    if (!settle) return
    const s = settle
    settle = null
    if (err) s.reject(err)
    else s.resolve(text)
  }

  unsubscribe = api.onAiStream((chunk: AiStreamChunk) => {
    if (chunk.requestId !== requestId) return
    if (chunk.type === 'delta' && chunk.text) {
      text += chunk.text
      onText(stripThinking(text))
    } else if (chunk.type === 'done') {
      text = stripThinking(text)
      finish()
    } else if (chunk.type === 'error') {
      finish(new Error(chunk.error || 'Suite AI hat nicht geantwortet.'))
    }
  })

  void (async () => {
    try {
      const settings = await api.getAiSettings()
      const model = settings.providers?.[settings.provider]?.model
      if (!model) throw new AiUnconfiguredError('no model')
      await api.aiStream({
        requestId,
        settings,
        system,
        messages: [{ role: 'user', text: user }],
      })
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)))
    }
  })()

  return {
    cancel() {
      void api.aiStreamCancel(requestId).catch(() => undefined)
      finish()
    },
    done,
  }
}

/** models with visible reasoning sometimes leak <think> blocks into the text */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').replace(/^\s+/, '')
}

export function clip(text: string): string {
  return text.length > MAX_MAIL_CHARS ? `${text.slice(0, MAX_MAIL_CHARS)}\n[…gekürzt]` : text
}

const BASE = `You are Suite AI, the email assistant built into Suite Office. You run on the user's own computer.
Write plain text only: no Markdown headings, no bold markers, no code fences.`

export interface MailContext {
  from: string
  to: string
  subject: string
  date: string
  body: string
}

function mailBlock(mail: MailContext): string {
  return `From: ${mail.from}\nTo: ${mail.to}\nDate: ${mail.date}\nSubject: ${mail.subject}\n\n${clip(mail.body)}`
}

export const prompts = {
  summarize(mail: MailContext, language: string) {
    return {
      system: `${BASE}\nSummarize emails in ${language}: 2–5 short bullet points starting with "• ", then one line "Action needed:" naming what (if anything) the reader has to do.`,
      user: `Summarize this email:\n\n${mailBlock(mail)}`,
    }
  },
  actionItems(mail: MailContext, language: string) {
    return {
      system: `${BASE}\nExtract tasks, deadlines, dates and appointments from emails, in ${language}. One item per line starting with "• ", with the date when there is one. If there are none, say so in one sentence.`,
      user: `Extract tasks and dates from this email:\n\n${mailBlock(mail)}`,
    }
  },
  translate(mail: MailContext, language: string) {
    return {
      system: `${BASE}\nTranslate emails faithfully into ${language}. Keep names, numbers and line breaks; output only the translation.`,
      user: `Translate this email body:\n\n${clip(mail.body)}`,
    }
  },
  ask(mail: MailContext, question: string, language: string) {
    return {
      system: `${BASE}\nAnswer questions about the email the user is reading, in ${language}. Be brief and point to the relevant part of the email.`,
      user: `${mailBlock(mail)}\n\nQuestion: ${question}`,
    }
  },
  draftReply(mail: MailContext, senderName: string, instruction: string) {
    return {
      system: `${BASE}\nDraft email replies in the language of the email being answered. Output only the reply body: greeting, text and sign-off with the sender's name. No subject line, no quoted original.`,
      user:
        `Write a reply to this email on behalf of ${senderName || 'me'}.` +
        (instruction.trim() ? `\nThe reply should: ${instruction.trim()}` : '') +
        `\n\n${mailBlock(mail)}`,
    }
  },
  rewrite(body: string, instruction: string, context?: MailContext) {
    return {
      system: `${BASE}\nYou rewrite email drafts. Keep the author's language unless asked to translate, keep facts, names and numbers. Output only the new email body.`,
      user:
        `Instruction: ${instruction}\n\nDraft:\n${clip(body)}` +
        (context ? `\n\nThe draft answers this email:\n${mailBlock(context)}` : ''),
    }
  },
}
