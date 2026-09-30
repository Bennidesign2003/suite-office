// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { MailMessage } from '../src/shared/ipc'
import {
  formatAddress,
  forwardDraft,
  forwardSubject,
  htmlToText,
  listDate,
  outgoingText,
  readerDocument,
  replyDraft,
  replySubject,
} from '../src/renderer/format'

const msg: MailMessage = {
  uid: 7,
  folder: 'INBOX',
  subject: 'AW: Re: Angebot',
  from: [{ name: 'Anna Schmidt', address: 'anna@firma.de' }],
  to: [
    { name: 'Benni', address: 'benni@example.com' },
    { name: 'Carl', address: 'carl@firma.de' },
  ],
  cc: [{ name: '', address: 'dora@firma.de' }],
  replyTo: [],
  date: '2026-09-29T12:00:00.000Z',
  html: '',
  text: 'Hallo,\n> alt\nneu',
  messageId: '<m1@firma.de>',
  references: ['<m0@firma.de>'],
  attachments: [],
  hasRemoteContent: false,
}

describe('mail format helpers', () => {
  it('normalizes reply and forward subjects', () => {
    expect(replySubject('AW: Re: Angebot')).toBe('Re: Angebot')
    expect(replySubject('Angebot')).toBe('Re: Angebot')
    expect(forwardSubject('WG: Fwd: Angebot')).toBe('Fwd: Angebot')
  })

  it('quotes names that need it', () => {
    expect(formatAddress({ name: 'Schmidt, Anna', address: 'a@b.de' })).toBe(
      '"Schmidt, Anna" <a@b.de>',
    )
    expect(formatAddress({ name: '', address: 'a@b.de' })).toBe('a@b.de')
  })

  it('replies to the sender, and reply-all copies everyone but me', () => {
    const one = replyDraft(msg, 'reply', 'benni@example.com', 'Header:')
    expect(one.to).toBe('Anna Schmidt <anna@firma.de>')
    expect(one.cc).toBe('')
    expect(one.references).toEqual(['<m0@firma.de>', '<m1@firma.de>'])
    expect(one.inReplyTo).toBe('<m1@firma.de>')
    expect(one.answering).toEqual({ folder: 'INBOX', uid: 7 })
    expect(one.quoted).toBe('Header:\n> Hallo,\n>> alt\n> neu')

    const all = replyDraft(msg, 'replyAll', 'BENNI@example.com', 'Header:')
    expect(all.cc).toBe('Carl <carl@firma.de>, dora@firma.de')
  })

  it('prefers Reply-To over From', () => {
    const d = replyDraft(
      { ...msg, replyTo: [{ name: '', address: 'list@firma.de' }] },
      'reply',
      'x@y.z',
      'H',
    )
    expect(d.to).toBe('list@firma.de')
  })

  it('forwards with the original headers and puts the user text first', () => {
    const d = forwardDraft(
      msg,
      '--- Fwd ---',
      { from: 'Von', to: 'An', date: 'Datum', subject: 'Betreff' },
      'de',
    )
    expect(d.subject).toBe('Fwd: AW: Re: Angebot')
    expect(d.quoted).toContain('Von: Anna Schmidt <anna@firma.de>')
    expect(outgoingText({ text: 'FYI  \n', quoted: d.quoted })).toMatch(/^FYI\n\n--- Fwd ---/)
    expect(outgoingText({ text: 'nur text', quoted: '' })).toBe('nur text')
  })

  it('turns HTML mail into readable text', () => {
    const text = htmlToText('<style>p{}</style><p>Hallo</p><p>Welt<br>zwei</p><script>x()</script>')
    expect(text).toBe('Hallo\nWelt\nzwei')
  })

  it('labels list dates relative to today', () => {
    const now = new Date('2026-09-29T15:00:00')
    const labels = { today: 'Heute', yesterday: 'Gestern' }
    expect(listDate('2026-09-28T09:00:00', labels, 'de', now)).toBe('Gestern')
    expect(listDate('2026-09-29T09:05:00', labels, 'de', now)).toBe('09:05')
  })

  it('keeps the reading frame offline unless remote images are allowed', () => {
    const blocked = readerDocument('<img src="https://t.example/p.png">', '', false)
    expect(blocked).toContain('img-src data:;')
    expect(blocked).toContain("default-src 'none'")
    expect(readerDocument('<p>x</p>', '', true)).toContain('img-src data: https: http:')
    const plain = readerDocument('', 'a <b> https://x.de/y', false)
    expect(plain).toContain('a &lt;b&gt; <a href="https://x.de/y">https://x.de/y</a>')
  })
})
