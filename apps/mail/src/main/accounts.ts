import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MailAccountInfo, MailAccountInput, ServerSettings } from '../shared/ipc'

/**
 * Mail accounts live in userData/mail-accounts.json, readable by the user
 * only. Passwords are encrypted with the OS keychain (Electron safeStorage)
 * when it is available; otherwise — the browser build, or a Linux session
 * without a keyring — they are stored as plain text in that private file.
 */

export interface StoredAccount {
  id: string
  name: string
  email: string
  user: string
  imap: ServerSettings
  smtp: ServerSettings
  /** 'enc:' + base64 (safeStorage) or 'plain:' + password */
  secret: string
}

export interface SecretBox {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
}

export class AccountStore {
  constructor(
    private readonly file: () => string,
    private readonly box: SecretBox | null,
  ) {}

  private read(): StoredAccount[] {
    const path = this.file()
    if (!existsSync(path)) return []
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { accounts?: StoredAccount[] }
      return Array.isArray(parsed.accounts) ? parsed.accounts : []
    } catch {
      return []
    }
  }

  private write(accounts: StoredAccount[]): void {
    const path = this.file()
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, accounts }, null, 2), { mode: 0o600 })
    renameSync(tmp, path)
    try {
      chmodSync(path, 0o600)
    } catch {
      // not supported on this file system
    }
  }

  private seal(password: string): string {
    try {
      if (this.box?.isEncryptionAvailable()) {
        return 'enc:' + this.box.encryptString(password).toString('base64')
      }
    } catch {
      // keychain refused; fall through to the private file
    }
    return 'plain:' + password
  }

  private open(secret: string): string {
    if (secret.startsWith('plain:')) return secret.slice('plain:'.length)
    if (secret.startsWith('enc:') && this.box) {
      return this.box.decryptString(Buffer.from(secret.slice('enc:'.length), 'base64'))
    }
    throw new Error(
      'Das gespeicherte Passwort kann nicht entschlüsselt werden. Bitte neu eingeben.',
    )
  }

  static info(account: StoredAccount): MailAccountInfo {
    return {
      id: account.id,
      name: account.name,
      email: account.email,
      user: account.user,
      imap: { ...account.imap },
      smtp: { ...account.smtp },
      hasPassword: account.secret !== 'plain:',
    }
  }

  list(): MailAccountInfo[] {
    return this.read().map(AccountStore.info)
  }

  get(id: string): StoredAccount | undefined {
    return this.read().find((a) => a.id === id)
  }

  password(account: StoredAccount): string {
    return this.open(account.secret)
  }

  /** a stored account merged with form input (an empty password keeps the old one) */
  resolve(input: MailAccountInput): StoredAccount {
    const existing = input.id ? this.get(input.id) : undefined
    return {
      id: existing?.id ?? input.id ?? randomUUID(),
      name: input.name.trim() || input.email.trim(),
      email: input.email.trim(),
      user: input.user.trim() || input.email.trim(),
      imap: { ...input.imap, host: input.imap.host.trim() },
      smtp: { ...input.smtp, host: input.smtp.host.trim() },
      secret: input.password ? this.seal(input.password) : (existing?.secret ?? 'plain:'),
    }
  }

  save(account: StoredAccount): MailAccountInfo {
    const accounts = this.read()
    const at = accounts.findIndex((a) => a.id === account.id)
    if (at >= 0) accounts[at] = account
    else accounts.push(account)
    this.write(accounts)
    return AccountStore.info(account)
  }

  remove(id: string): void {
    this.write(this.read().filter((a) => a.id !== id))
  }
}
