import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ContactsService } from '../src/main/pim/contacts-service'
import { SourceStore, type StoredSource } from '../src/main/pim/store'
import { parseVcards } from '../src/main/pim/vcard'

const dav = vi.hoisted(() => ({ connectDav: vi.fn(), forgetDav: vi.fn() }))
vi.mock('../src/main/pim/dav', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/pim/dav')>()),
  connectDav: dav.connectDav,
  forgetDav: dav.forgetDav,
}))

const crlf = (lines: string[]): string => lines.join('\r\n') + '\r\n'

const APPLE = crlf([
  'BEGIN:VCARD',
  'VERSION:3.0',
  'N:Schmidt;Anna;;;',
  'FN:Anna Schmidt',
  'item1.EMAIL;type=INTERNET;type=pref:anna@example.com',
  'item1.X-ABLabel:_$!<Other>!$_',
  'TEL;type=CELL:+49 170 1111111',
  'X-SOCIALPROFILE;type=twitter:https://twitter.com/anna',
  'CATEGORIES:Freunde',
  'UID:anna-1',
  'END:VCARD',
])

const OUTLOOK = crlf([
  'BEGIN:VCARD',
  'VERSION:2.1',
  'N;CHARSET=utf-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=B6rg',
  'FN;CHARSET=utf-8;ENCODING=QUOTED-PRINTABLE:J=C3=B6rg M=C3=BCller',
  'EMAIL;PREF;INTERNET:joerg@firma.de',
  'X-MS-IMADDRESS:joerg@im.example',
  'END:VCARD',
])

const GROUP = crlf([
  'BEGIN:VCARD',
  'VERSION:3.0',
  'FN:Familie',
  'X-ADDRESSBOOKSERVER-KIND:group',
  'UID:group-1',
  'END:VCARD',
])

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'suite-contacts-'))
}

function service(dir = tempDir()) {
  const sources = new SourceStore(() => dir, null)
  const contacts = new ContactsService({
    dir: () => dir,
    sources,
    localName: 'Auf diesem Computer',
  })
  return { dir, sources, contacts }
}

const LOCAL = 'local:contacts'

describe('local address book', () => {
  it('lists the local book and stores contacts as vCards', async () => {
    const { dir, contacts } = service()
    expect(contacts.listAddressBooks()).toEqual([
      { id: LOCAL, sourceId: 'local', name: 'Auf diesem Computer', readOnly: false },
    ])
    const saved = await contacts.saveContact({
      addressBookId: LOCAL,
      name: 'Jörg Müller',
      firstName: 'Jörg',
      lastName: 'Müller',
      emails: [{ type: 'work', value: 'joerg@firma.de' }],
      phones: [{ type: 'cell', value: '+49 171 1234567' }],
      organization: 'Muster GmbH',
    })
    expect(saved.id).toBe(`${LOCAL}|${saved.uid}`)
    expect(saved.readOnly).toBe(false)
    expect(saved.emails).toEqual([{ type: 'work', value: 'joerg@firma.de' }])
    const file = JSON.parse(readFileSync(join(dir, 'local-contacts.json'), 'utf8'))
    expect(file.books).toEqual([{ id: LOCAL, name: 'Auf diesem Computer' }])
    expect(file.cards[LOCAL][saved.uid]).toMatch(/^BEGIN:VCARD\r\nVERSION:3\.0/)
    expect(await contacts.listContacts()).toEqual([saved])
  })

  it('searches name, e-mail, phone and organization, ignoring case and accents', async () => {
    const { contacts } = service()
    await contacts.saveContact({
      addressBookId: LOCAL,
      name: 'Jörg Müller',
      emails: [{ type: 'work', value: 'jm@firma.de' }],
      phones: [{ type: 'cell', value: '+49 171 1234567' }],
      organization: 'Straßenbau AG',
    })
    await contacts.saveContact({ addressBookId: LOCAL, name: 'Zoë Adams' })
    const names = async (q: string) => (await contacts.listContacts(q)).map((c) => c.name)
    expect(await names('muller')).toEqual(['Jörg Müller'])
    expect(await names('MUELLER')).toEqual(['Jörg Müller'])
    expect(await names('jörg mü')).toEqual(['Jörg Müller'])
    expect(await names('strassenbau')).toEqual(['Jörg Müller'])
    expect(await names('firma.de')).toEqual(['Jörg Müller'])
    expect(await names('171 123')).toEqual(['Jörg Müller'])
    expect(await names('zoe')).toEqual(['Zoë Adams'])
    expect(await names('nobody')).toEqual([])
  })

  it('sorts by name the German way', async () => {
    const { contacts } = service()
    for (const name of ['Zacharias', 'Bernd', 'Ärmel Anton', 'anna']) {
      await contacts.saveContact({ addressBookId: LOCAL, name })
    }
    expect((await contacts.listContacts()).map((c) => c.name)).toEqual([
      'anna',
      'Ärmel Anton',
      'Bernd',
      'Zacharias',
    ])
  })

  it('updates without losing what the editor does not show, and deletes', async () => {
    const { dir, contacts } = service()
    expect(await contacts.importVcf(LOCAL, APPLE)).toBe(1)
    const [anna] = await contacts.listContacts()
    expect(anna!.uid).toBe('anna-1')
    const updated = await contacts.saveContact({
      ...anna!,
      addressBookId: LOCAL,
      phones: [{ type: 'work', value: '030 999' }],
    })
    expect(updated.phones).toEqual([{ type: 'work', value: '030 999' }])
    const stored: string = JSON.parse(readFileSync(join(dir, 'local-contacts.json'), 'utf8')).cards[
      LOCAL
    ]['anna-1']
    expect(stored).toContain('X-SOCIALPROFILE;TYPE=twitter:https://twitter.com/anna')
    expect(stored).toContain('CATEGORIES:Freunde')
    expect(stored).toContain('item1.EMAIL;TYPE=INTERNET,pref:anna@example.com')
    expect(stored).not.toContain('+49 170 1111111')

    await contacts.deleteContact(LOCAL, 'anna-1')
    expect(await contacts.listContacts()).toEqual([])
    await expect(contacts.deleteContact(LOCAL, 'anna-1')).resolves.toBeUndefined()
  })

  it('rejects empty contacts, bad birthdays and unknown books in German', async () => {
    const { contacts } = service()
    await expect(contacts.saveContact({ addressBookId: LOCAL, name: '  ' })).rejects.toThrow(
      /Namen/,
    )
    await expect(
      contacts.saveContact({ addressBookId: LOCAL, name: 'X', birthday: '31.02.' }),
    ).rejects.toThrow(/Geburtsdatum/)
    await expect(contacts.saveContact({ addressBookId: 'nope:x', name: 'X' })).rejects.toThrow(
      /Adressbuch/,
    )
  })

  it('survives a corrupt file', async () => {
    const { dir, contacts } = service()
    writeFileSync(
      join(dir, 'local-contacts.json'),
      '{"books": 5, "cards": {"local:contacts": {"a": 1, "b": "garbage"}}}',
    )
    expect(await contacts.listContacts()).toEqual([])
    expect(contacts.listAddressBooks()).toHaveLength(1)
  })
})

describe('import and export', () => {
  it('imports 2.1 and 3.0 files as 3.0, skips groups, and exports what is stored', async () => {
    const { dir, contacts } = service()
    expect(await contacts.importVcf(LOCAL, OUTLOOK + APPLE + GROUP)).toBe(2)
    const list = await contacts.listContacts()
    expect(list.map((c) => c.name)).toEqual(['Anna Schmidt', 'Jörg Müller'])
    const cards: Record<string, string> = JSON.parse(
      readFileSync(join(dir, 'local-contacts.json'), 'utf8'),
    ).cards[LOCAL]
    for (const vcf of Object.values(cards)) {
      expect(vcf).toContain('VERSION:3.0')
      expect(vcf).not.toMatch(/QUOTED-PRINTABLE/)
    }
    expect(Object.values(cards).join('')).toContain('X-MS-IMADDRESS:joerg@im.example')

    const exported = await contacts.exportVcf(LOCAL)
    expect(exported).not.toMatch(/[^\r]\n/)
    expect(
      parseVcards(exported)
        .map((c) => c.name)
        .sort(),
    ).toEqual(['Anna Schmidt', 'Jörg Müller'])
  })

  it('never overwrites: identical cards are skipped, a changed card with a taken UID is added', async () => {
    const { contacts } = service()
    expect(await contacts.importVcf(LOCAL, APPLE)).toBe(1)
    expect(await contacts.importVcf(LOCAL, APPLE)).toBe(0)
    const changed = APPLE.replace('FN:Anna Schmidt', 'FN:Anna S.')
    expect(await contacts.importVcf(LOCAL, changed + changed)).toBe(1)
    const list = await contacts.listContacts()
    expect(list.map((c) => c.name)).toEqual(['Anna S.', 'Anna Schmidt'])
    expect(new Set(list.map((c) => c.uid)).size).toBe(2)
    // a round trip through export adds nothing
    expect(await contacts.importVcf(LOCAL, await contacts.exportVcf(LOCAL))).toBe(0)
    // nor do UID-less Outlook cards imported twice
    expect(await contacts.importVcf(LOCAL, OUTLOOK)).toBe(1)
    expect(await contacts.importVcf(LOCAL, OUTLOOK)).toBe(0)
  })

  it('reports a file without contacts', async () => {
    const { contacts } = service()
    await expect(contacts.importVcf(LOCAL, 'hallo welt')).rejects.toThrow(/keine Kontakte/)
    expect(await contacts.exportVcf(LOCAL)).toBe('')
  })
})

describe('address suggestions', () => {
  async function seeded() {
    const s = service()
    const { contacts } = s
    await contacts.saveContact({
      addressBookId: LOCAL,
      name: 'Anna Schmidt',
      emails: [
        { type: 'home', value: 'anna@example.com' },
        { type: 'work', value: 'a.schmidt@work.de' },
      ],
    })
    await contacts.saveContact({
      addressBookId: LOCAL,
      name: 'Johann Andersson',
      emails: [{ type: 'work', value: 'j.a@x.de' }],
    })
    await contacts.saveContact({
      addressBookId: LOCAL,
      name: 'Hannah Berg',
      emails: [{ type: 'home', value: 'hb@berg.de' }],
    })
    await contacts.saveContact({ addressBookId: LOCAL, name: 'Ohne Mail' })
    contacts.rememberRecipients([{ name: 'Andreas Bauer', email: 'andreas@bauer.de' }])
    contacts.rememberRecipients([{ name: 'Andreas Bauer', email: 'andreas@bauer.de' }])
    return s
  }

  it('ranks prefixes before matches inside, then by use', async () => {
    const { contacts } = await seeded()
    expect(contacts.suggest('an')).toEqual([
      { name: 'Andreas Bauer', email: 'andreas@bauer.de', kind: 'recent' },
      // a tie keeps the contact's own order: the preferred address first
      { name: 'Anna Schmidt', email: 'anna@example.com', kind: 'contact' },
      { name: 'Anna Schmidt', email: 'a.schmidt@work.de', kind: 'contact' },
      { name: 'Johann Andersson', email: 'j.a@x.de', kind: 'contact' },
      { name: 'Hannah Berg', email: 'hb@berg.de', kind: 'contact' },
    ])
    expect(contacts.suggest('an', 2)).toHaveLength(2)
    expect(contacts.suggest('   ')).toEqual([])
    expect(contacts.suggest('a.schmidt@').map((s) => s.email)).toEqual(['a.schmidt@work.de'])
    // found inside the address, and inside a name word
    expect(contacts.suggest('schmidt@').map((s) => s.email)).toEqual(['a.schmidt@work.de'])
    expect(contacts.suggest('nnah').map((s) => s.name)).toEqual(['Hannah Berg'])
    expect(contacts.suggest('xyz')).toEqual([])
  })

  it('merges a recent recipient into the contact and lets use decide the order', async () => {
    const { contacts } = await seeded()
    contacts.rememberRecipients([{ name: 'A. S.', email: 'A.Schmidt@work.de' }])
    const annas = contacts.suggest('anna s')
    expect(annas).toEqual([
      { name: 'Anna Schmidt', email: 'a.schmidt@work.de', kind: 'contact' },
      { name: 'Anna Schmidt', email: 'anna@example.com', kind: 'contact' },
    ])
    expect(
      contacts.suggest('ANNA@').filter((s) => s.email.toLowerCase() === 'anna@example.com'),
    ).toHaveLength(1)
  })
})

describe('recent recipients', () => {
  it('counts, keeps names, ignores junk and keeps only the 500 most recent', () => {
    const { dir, contacts } = service()
    const file = join(dir, 'recent-recipients.json')
    const old: Record<string, object> = {}
    for (let i = 0; i < 500; i++) {
      const email = `p${i}@old.de`
      old[email] = {
        name: `P ${i}`,
        email,
        count: 1,
        lastUsed: new Date(Date.UTC(2020, 0, 1, 0, i)).toISOString(),
      }
    }
    writeFileSync(file, JSON.stringify(old))
    contacts.rememberRecipients([
      { name: '"Neu Eins"', email: 'Neu1@Example.com' },
      { name: '', email: 'neu1@example.com' },
      { name: 'Kaputt', email: 'keine adresse' },
      { name: 'Neu Zwei', email: 'neu2@example.com' },
      { name: '', email: 'p499@old.de' },
    ])
    const data = JSON.parse(readFileSync(file, 'utf8'))
    expect(Object.keys(data)).toHaveLength(500)
    expect(data['neu1@example.com']).toMatchObject({
      name: 'Neu Eins',
      email: 'Neu1@Example.com',
      count: 1,
    })
    expect(data['neu2@example.com'].count).toBe(1)
    expect(data['p499@old.de']).toMatchObject({ name: 'P 499', count: 2 })
    // the two least recently used made room
    expect(data['p0@old.de']).toBeUndefined()
    expect(data['p1@old.de']).toBeUndefined()
    expect(data['p2@old.de']).toBeDefined()
    expect(data['keine adresse']).toBeUndefined()
  })
})

// ---- CardDAV against an in-memory server ----

interface FakeBook {
  displayName: string
  ctag: number
  readOnly: boolean
  objects: Map<string, { data: string; etag: string }>
}

const HOME = 'https://dav.example.com/remote.php/dav/addressbooks/users/benni/'
const BOOK = `${HOME}contacts/`
const SYSTEM = `${HOME}z-server-generated--system/`

class FakeServer {
  books = new Map<string, FakeBook>()
  log: string[] = []
  private seq = 0

  etag(): string {
    return `"e${++this.seq}"`
  }

  put(bookUrl: string, name: string, data: string): string {
    const book = this.books.get(bookUrl)!
    const etag = this.etag()
    book.objects.set(new URL(name, bookUrl).href, { data, etag })
    book.ctag++
    return etag
  }

  private owner(url: string): FakeBook | undefined {
    for (const [bookUrl, book] of this.books) if (url.startsWith(bookUrl)) return book
    return undefined
  }

  client() {
    return {
      fetchAddressBooks: async () =>
        [...this.books].map(([url, b]) => ({
          url,
          displayName: b.displayName,
          ctag: `c${b.ctag}`,
          syncToken: `https://dav.example.com/sync/${b.ctag}`,
          resourcetype: ['collection', 'addressbook'],
        })),
      propfind: async ({ url, props }: { url: string; props: Record<string, unknown> }) => {
        const book = this.books.get(url)!
        if ('d:current-user-privilege-set' in props) {
          const privilege = book.readOnly ? [{ read: {} }] : [{ read: {} }, { write: {} }]
          return [
            { href: url, ok: true, status: 207, props: { currentUserPrivilegeSet: { privilege } } },
          ]
        }
        this.log.push(`list ${new URL(url).pathname}`)
        return [
          {
            href: new URL(url).pathname,
            ok: true,
            status: 207,
            props: { resourcetype: { collection: {}, addressbook: {} } },
          },
          ...[...book.objects].map(([u, o]) => ({
            href: new URL(u).pathname,
            ok: true,
            status: 207,
            props: { getetag: o.etag, resourcetype: {} },
          })),
        ]
      },
      fetchVCards: async ({ objectUrls }: { objectUrls: string[] }) => {
        this.log.push(`multiget ${objectUrls.length}`)
        return objectUrls.flatMap((u) => {
          const o = this.owner(u)?.objects.get(u)
          return o ? [{ url: u, etag: o.etag, data: o.data }] : []
        })
      },
      createVCard: async (p: {
        addressBook: { url: string }
        vCardString: string
        filename: string
      }) => {
        const url = new URL(p.filename, p.addressBook.url).href
        this.log.push(`create ${p.filename}`)
        const book = this.books.get(p.addressBook.url)!
        if (book.readOnly) return new Response(null, { status: 403 })
        if (book.objects.has(url)) return new Response(null, { status: 412 })
        const etag = this.put(p.addressBook.url, p.filename, p.vCardString)
        return new Response(null, { status: 201, headers: { etag } })
      },
      updateVCard: async ({ vCard }: { vCard: { url: string; etag?: string; data?: string } }) => {
        this.log.push(`update ${vCard.etag}`)
        const book = this.owner(vCard.url)!
        const current = book.objects.get(vCard.url)
        if (!current || (vCard.etag && vCard.etag !== current.etag)) {
          return new Response(null, { status: 412 })
        }
        const etag = this.etag()
        book.objects.set(vCard.url, { data: vCard.data!, etag })
        book.ctag++
        return new Response(null, { status: 204, headers: { etag } })
      },
      deleteVCard: async ({ vCard }: { vCard: { url: string; etag?: string } }) => {
        this.log.push(`delete ${vCard.etag}`)
        const book = this.owner(vCard.url)!
        const current = book.objects.get(vCard.url)
        if (!current) return new Response(null, { status: 404 })
        if (vCard.etag && vCard.etag !== current.etag) return new Response(null, { status: 412 })
        book.objects.delete(vCard.url)
        book.ctag++
        return new Response(null, { status: 204 })
      },
    }
  }
}

describe('CardDAV address books', () => {
  let server: FakeServer
  let ctx: ReturnType<typeof service>
  let source: StoredSource

  beforeEach(() => {
    server = new FakeServer()
    server.books.set(BOOK, {
      displayName: 'Kontakte',
      ctag: 1,
      readOnly: false,
      objects: new Map(),
    })
    server.books.set(SYSTEM, { displayName: '', ctag: 1, readOnly: true, objects: new Map() })
    server.put(BOOK, 'anna-1.vcf', APPLE)
    // no UID: it is addressed by its file name
    server.put(
      BOOK,
      'Ohne%20UID.vcf',
      crlf(['BEGIN:VCARD', 'VERSION:3.0', 'FN:Ohne Kennung', 'END:VCARD']),
    )
    server.put(
      SYSTEM,
      'sys.vcf',
      crlf(['BEGIN:VCARD', 'VERSION:3.0', 'FN:Kollege', 'UID:k1', 'END:VCARD']),
    )
    server.log = []
    dav.connectDav.mockReset()
    dav.forgetDav.mockReset()
    dav.connectDav.mockImplementation(async () => server.client())
    ctx = service()
    source = ctx.sources.save({
      id: 'dav1',
      kind: 'carddav',
      name: 'Nextcloud',
      url: 'https://dav.example.com/remote.php/dav',
      user: 'benni',
      secret: 'plain:pw',
    })
  })

  it('mirrors the server and lists its books with their rights', async () => {
    await ctx.contacts.syncSource(source)
    expect(dav.connectDav).toHaveBeenCalledWith(
      'dav1',
      'carddav',
      'https://dav.example.com/remote.php/dav',
      'benni',
      'pw',
    )
    expect(ctx.contacts.listAddressBooks()).toEqual([
      { id: LOCAL, sourceId: 'local', name: 'Auf diesem Computer', readOnly: false },
      { id: 'dav1:contacts', sourceId: 'dav1', name: 'Kontakte', readOnly: false },
      {
        id: 'dav1:z-server-generated--system',
        sourceId: 'dav1',
        name: 'Nextcloud',
        readOnly: true,
      },
    ])
    const list = await ctx.contacts.listContacts()
    expect(list.map((c) => [c.name, c.id, c.readOnly])).toEqual([
      ['Anna Schmidt', 'dav1:contacts|anna-1', false],
      ['Kollege', 'dav1:z-server-generated--system|k1', true],
      ['Ohne Kennung', 'dav1:contacts|Ohne UID', false],
    ])
    expect(existsSync(join(ctx.dir, 'carddav-dav1.json'))).toBe(true)
  })

  it('fetches only books whose ctag moved, and in them only changed cards', async () => {
    await ctx.contacts.syncSource(source)
    server.log = []
    await ctx.contacts.syncSource(source)
    expect(server.log).toEqual([])

    server.put(BOOK, 'anna-1.vcf', APPLE.replace('FN:Anna Schmidt', 'FN:Anna Maria Schmidt'))
    await ctx.contacts.syncSource(source)
    expect(server.log).toEqual([`list ${new URL(BOOK).pathname}`, 'multiget 1'])
    const names = (await ctx.contacts.listContacts()).map((c) => c.name)
    expect(names).toContain('Anna Maria Schmidt')

    server.books.get(BOOK)!.objects.delete(new URL('Ohne%20UID.vcf', BOOK).href)
    server.books.get(BOOK)!.ctag++
    await ctx.contacts.syncSource(source)
    expect((await ctx.contacts.listContacts()).map((c) => c.name)).not.toContain('Ohne Kennung')
  })

  it('writes changes to the server with the ETag, keeping unknown properties', async () => {
    await ctx.contacts.syncSource(source)
    const [anna] = await ctx.contacts.listContacts('anna')
    const etagBefore = server.books.get(BOOK)!.objects.get(`${BOOK}anna-1.vcf`)!.etag
    const saved = await ctx.contacts.saveContact({
      ...anna!,
      addressBookId: 'dav1:contacts',
      jobTitle: 'Architektin',
    })
    expect(saved.jobTitle).toBe('Architektin')
    expect(server.log).toContain(`update ${etagBefore}`)
    const onServer = server.books.get(BOOK)!.objects.get(`${BOOK}anna-1.vcf`)!
    expect(onServer.data).toContain('TITLE:Architektin')
    expect(onServer.data).toContain('X-SOCIALPROFILE;TYPE=twitter:https://twitter.com/anna')
    // the mirror has the new ETag: a second edit is not a conflict
    await ctx.contacts.saveContact({ ...saved, jobTitle: 'Chefin' })
    expect(server.log).toContain(`update ${onServer.etag}`)
    expect(server.books.get(BOOK)!.objects.get(`${BOOK}anna-1.vcf`)!.data).toContain('TITLE:Chefin')
  })

  it('refuses to overwrite a card changed elsewhere and loads the new version', async () => {
    await ctx.contacts.syncSource(source)
    const [anna] = await ctx.contacts.listContacts('anna')
    server.put(BOOK, 'anna-1.vcf', APPLE.replace('FN:Anna Schmidt', 'FN:Anna vom Handy'))
    await expect(
      ctx.contacts.saveContact({ ...anna!, addressBookId: 'dav1:contacts', name: 'Anna Laptop' }),
    ).rejects.toThrow(/inzwischen an anderer Stelle geändert/)
    expect(server.books.get(BOOK)!.objects.get(`${BOOK}anna-1.vcf`)!.data).toContain(
      'FN:Anna vom Handy',
    )
    expect((await ctx.contacts.listContacts('anna')).map((c) => c.name)).toEqual(['Anna vom Handy'])
  })

  it('creates as <uid>.vcf, deletes, and respects read-only books', async () => {
    await ctx.contacts.syncSource(source)
    const created = await ctx.contacts.saveContact({
      addressBookId: 'dav1:contacts',
      name: 'Neu Angelegt',
      emails: [{ type: 'home', value: 'neu@example.com' }],
    })
    expect(server.log).toContain(`create ${created.uid}.vcf`)
    expect(server.books.get(BOOK)!.objects.has(`${BOOK}${created.uid}.vcf`)).toBe(true)
    expect(ctx.contacts.suggest('neu')).toEqual([
      { name: 'Neu Angelegt', email: 'neu@example.com', kind: 'contact' },
    ])

    await ctx.contacts.deleteContact('dav1:contacts', created.uid)
    expect(server.books.get(BOOK)!.objects.has(`${BOOK}${created.uid}.vcf`)).toBe(false)
    expect((await ctx.contacts.listContacts('neu')).length).toBe(0)

    await expect(
      ctx.contacts.saveContact({ addressBookId: 'dav1:z-server-generated--system', name: 'X' }),
    ).rejects.toThrow(/schreibgeschützt/)
    await expect(ctx.contacts.importVcf('dav1:z-server-generated--system', APPLE)).rejects.toThrow(
      /schreibgeschützt/,
    )
  })

  it('imports into a server book, converting to 3.0 and skipping what is there', async () => {
    await ctx.contacts.syncSource(source)
    expect(await ctx.contacts.importVcf('dav1:contacts', APPLE + OUTLOOK)).toBe(1)
    const created = [...server.books.get(BOOK)!.objects.values()].find((o) =>
      o.data.includes('joerg@firma.de'),
    )!
    expect(created.data).toContain('VERSION:3.0')
    expect(created.data).toContain('X-MS-IMADDRESS:joerg@im.example')
    expect((await ctx.contacts.listContacts('jörg')).map((c) => c.addressBookId)).toEqual([
      'dav1:contacts',
    ])
    const exported = await ctx.contacts.exportVcf('dav1:contacts')
    expect(parseVcards(exported)).toHaveLength(3)
  })

  it('drops the mirror of a removed source', async () => {
    await ctx.contacts.syncSource(source)
    ctx.sources.remove('dav1')
    ctx.contacts.forgetSource('dav1')
    expect(existsSync(join(ctx.dir, 'carddav-dav1.json'))).toBe(false)
    expect(ctx.contacts.listAddressBooks().map((b) => b.id)).toEqual([LOCAL])
    expect(await ctx.contacts.listContacts()).toEqual([])
  })

  it('tests a login without keeping the connection', async () => {
    await expect(ctx.contacts.testSource(source, 'pw')).resolves.toBeUndefined()
    expect(dav.connectDav.mock.calls[0]![0]).toBe('dav1#test')
    expect(dav.forgetDav).toHaveBeenCalledWith('dav1#test')

    server.books.clear()
    await expect(ctx.contacts.testSource(source, 'pw')).rejects.toThrow(/kein Adressbuch/)

    dav.connectDav.mockImplementation(async () => {
      throw Object.assign(new Error('Unauthorized'), { status: 401 })
    })
    await expect(ctx.contacts.testSource(source, 'falsch')).rejects.toThrow(
      /Anmeldung fehlgeschlagen/,
    )
    await expect(ctx.contacts.syncSource(source)).rejects.toThrow(/Anmeldung fehlgeschlagen/)
  })

  describe('awkward servers', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    /** plain GETs, answered from the fake server, with Basic auth checked */
    function stubGet(etagHeader = true) {
      const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
        const url = String(input)
        expect(new Headers(init?.headers).get('authorization')).toBe(
          `Basic ${Buffer.from('benni:pw').toString('base64')}`,
        )
        for (const book of server.books.values()) {
          const o = book.objects.get(url)
          if (o) {
            return new Response(o.data, {
              status: 200,
              headers: etagHeader ? { etag: o.etag } : {},
            })
          }
        }
        return new Response('', { status: 404 })
      })
      vi.stubGlobal('fetch', fetchMock)
      return fetchMock
    }

    it('falls back to GET when addressbook-multiget returns nothing', async () => {
      const get = stubGet()
      dav.connectDav.mockImplementation(async () => ({
        ...server.client(),
        fetchVCards: async () => [],
      }))
      await ctx.contacts.syncSource(source)
      expect(get).toHaveBeenCalledTimes(3)
      expect((await ctx.contacts.listContacts()).map((c) => c.name)).toEqual([
        'Anna Schmidt',
        'Kollege',
        'Ohne Kennung',
      ])
    })

    it('reads the stored copy back when a PUT returns no ETag', async () => {
      await ctx.contacts.syncSource(source)
      const get = stubGet()
      const plain = server.client()
      dav.connectDav.mockImplementation(async () => ({
        ...plain,
        updateVCard: async (p: Parameters<typeof plain.updateVCard>[0]) => {
          await plain.updateVCard(p)
          return new Response(null, { status: 204 })
        },
      }))
      const [anna] = await ctx.contacts.listContacts('anna')
      await ctx.contacts.saveContact({ ...anna!, addressBookId: 'dav1:contacts', note: 'neu' })
      expect(get).toHaveBeenCalledTimes(1)
      const onServer = server.books.get(BOOK)!.objects.get(`${BOOK}anna-1.vcf`)!
      // the next edit is guarded by the ETag the GET returned
      await ctx.contacts.saveContact({ ...anna!, addressBookId: 'dav1:contacts', note: 'neuer' })
      expect(server.log).toContain(`update ${onServer.etag}`)
    })

    it('keeps the old mirror when a sync fails half-way', async () => {
      await ctx.contacts.syncSource(source)
      server.put(BOOK, 'anna-1.vcf', APPLE.replace('FN:Anna Schmidt', 'FN:Anna Neu'))
      dav.connectDav.mockImplementation(async () => ({
        ...server.client(),
        fetchVCards: async () => {
          throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
        },
      }))
      await expect(ctx.contacts.syncSource(source)).rejects.toThrow(/lehnt die Verbindung ab/)
      expect((await ctx.contacts.listContacts('anna')).map((c) => c.name)).toEqual(['Anna Schmidt'])
    })
  })
})

describe('odd UIDs', () => {
  it('stores a card whose UID is __proto__ like any other', async () => {
    const { contacts } = service()
    const card = crlf(['BEGIN:VCARD', 'VERSION:3.0', 'FN:Prototyp', 'UID:__proto__', 'END:VCARD'])
    expect(await contacts.importVcf(LOCAL, card)).toBe(1)
    const list = await contacts.listContacts()
    expect(list.map((c) => [c.name, c.uid])).toEqual([['Prototyp', '__proto__']])
    await contacts.deleteContact(LOCAL, '__proto__')
    expect(await contacts.listContacts()).toEqual([])
  })
})
