import { mkdtempSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AccountStore } from '../src/main/accounts'
import { embedInlineImages } from '../src/main/mailbox'
import { guessServers } from '../src/main/presets'

const input = {
  name: 'Benni',
  email: 'benni@gmx.de',
  user: '',
  password: 'geheim',
  imap: { host: 'imap.gmx.net', port: 993, secure: true },
  smtp: { host: 'mail.gmx.net', port: 465, secure: true },
}

describe('mail accounts', () => {
  const file = () => join(dir, 'mail-accounts.json')
  const dir = mkdtempSync(join(tmpdir(), 'suite-mail-'))

  it('stores accounts privately and never hands the password back', () => {
    const store = new AccountStore(file, null)
    const info = store.save(store.resolve(input))
    expect(info.user).toBe('benni@gmx.de')
    expect(info.hasPassword).toBe(true)
    expect(JSON.stringify(store.list())).not.toContain('geheim')
    expect(store.password(store.get(info.id)!)).toBe('geheim')
    if (process.platform !== 'win32') expect(statSync(file()).mode & 0o777).toBe(0o600)
  })

  it('keeps the stored password when the form leaves it empty', () => {
    const store = new AccountStore(file, null)
    const [first] = store.list()
    const updated = store.resolve({ ...input, id: first!.id, name: 'Neu', password: '' })
    store.save(updated)
    expect(store.password(store.get(first!.id)!)).toBe('geheim')
    expect(store.list()[0]!.name).toBe('Neu')
  })

  it('encrypts through the keychain when one is available', () => {
    const box = {
      isEncryptionAvailable: () => true,
      encryptString: (s: string) => Buffer.from([...s].reverse().join('')),
      decryptString: (b: Buffer) => [...b.toString()].reverse().join(''),
    }
    const store = new AccountStore(() => join(dir, 'enc.json'), box)
    const info = store.save(store.resolve(input))
    expect(readFileSync(join(dir, 'enc.json'), 'utf8')).not.toContain('geheim')
    expect(store.password(store.get(info.id)!)).toBe('geheim')
  })

  it('removes accounts', () => {
    const store = new AccountStore(file, null)
    for (const a of store.list()) store.remove(a.id)
    expect(store.list()).toEqual([])
  })
})

describe('server presets', () => {
  it('knows the common providers and notes app passwords', () => {
    const gmail = guessServers('someone@gmail.com')!
    expect(gmail.imap).toEqual({ host: 'imap.gmail.com', port: 993, secure: true })
    expect(gmail.note).toMatch(/App-Passwort/)
    expect(guessServers('x@web.de')!.smtp).toEqual({
      host: 'smtp.web.de',
      port: 587,
      secure: false,
    })
  })

  it('falls back to the imap./smtp. convention', () => {
    expect(guessServers('ich@meinefirma.de')).toEqual({
      imap: { host: 'imap.meinefirma.de', port: 993, secure: true },
      smtp: { host: 'smtp.meinefirma.de', port: 465, secure: true },
    })
    expect(guessServers('kein-at')).toBeNull()
  })
})

describe('inline images', () => {
  it('embeds cid: pictures as data URLs', () => {
    const html = '<img src="cid:logo@x"><img src="cid:missing">'
    const out = embedInlineImages(html, [
      { contentId: '<logo@x>', contentType: 'image/png', content: Buffer.from('png') } as never,
    ])
    expect(out).toContain('src="data:image/png;base64,cG5n"')
    expect(out).toContain('src="cid:missing"')
  })
})
