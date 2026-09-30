import { describe, expect, it } from 'vitest'
import {
  formatAddress,
  normalizeBirthday,
  parseAddressText,
  parseVcard,
  parseVcards,
  serializeVcard,
  type CardFields,
  type ParsedCard,
} from '../src/main/pim/vcard'

const crlf = (lines: string[]): string => lines.join('\r\n') + '\r\n'

const JPEG = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDAoKCg0MDA0SEBIVFRUVGhsa'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

/** an Outlook 2.1 export: quoted-printable with "=" soft breaks, bare types, folded base64 */
const OUTLOOK_21 = crlf([
  'BEGIN:VCARD',
  'VERSION:2.1',
  'N;LANGUAGE=de;CHARSET=utf-8;ENCODING=QUOTED-PRINTABLE:M=C3=BCller;J=C3=B6rg;;Dr.',
  'FN;CHARSET=utf-8;ENCODING=QUOTED-PRINTABLE:Dr. J=C3=B6rg M=C3=BCller',
  'ORG:Beispiel GmbH;Vertrieb',
  'TITLE:Vertriebsleiter',
  'NOTE;CHARSET=utf-8;ENCODING=QUOTED-PRINTABLE:Erste Zeile=0D=0AZweite Zeile mit einem sehr langen Text, der auf =',
  'mehrere Zeilen umbrochen wird=0D=0AStra=C3=9Fe',
  'TEL;WORK;VOICE:+49 30 1234567',
  'TEL;CELL;VOICE:+49 171 7654321',
  'TEL;WORK;FAX:+49 30 1234568',
  'ADR;WORK;PREF;CHARSET=utf-8;ENCODING=QUOTED-PRINTABLE:;;Hauptstra=C3=9Fe 5;Berlin;;10115;Deutschland',
  'LABEL;WORK;PREF;CHARSET=utf-8;ENCODING=QUOTED-PRINTABLE:Hauptstra=C3=9Fe 5=0D=0A10115 Berlin=0D=0ADeutschland',
  'X-MS-OL-DEFAULT-POSTAL-ADDRESS:2',
  'EMAIL;INTERNET:jm@privat.de',
  'EMAIL;PREF;INTERNET:joerg.mueller@beispiel.de',
  'BDAY:19750412',
  'X-MS-IMADDRESS:joerg@im.example',
  'PHOTO;TYPE=JPEG;ENCODING=BASE64:',
  ` ${JPEG.slice(0, 40)}`,
  ` ${JPEG.slice(40)}`,
  '',
  'X-MS-OL-DESIGN;CHARSET=utf-8:<card xmlns="http://schemas.microsoft.com/office/outlook/12/electronicbusinesscards" ver="1.0"></card>',
  'REV:20240115T101010Z',
  'END:VCARD',
])

/** what iOS / iCloud stores: 3.0 with item groups and X-ABLabel */
const APPLE_30 = crlf([
  'BEGIN:VCARD',
  'VERSION:3.0',
  'PRODID:-//Apple Inc.//iPhone OS 17.0//EN',
  'N:Schmidt;Anna;;;',
  'FN:Anna Schmidt',
  'ORG:Beispiel AG;',
  'TITLE:Entwicklerin',
  'item1.EMAIL;type=INTERNET;type=pref:anna@example.com',
  'item1.X-ABLabel:_$!<Other>!$_',
  'EMAIL;type=INTERNET;type=WORK:anna.schmidt@beispiel.de',
  'TEL;type=CELL;type=VOICE;type=pref:+49 170 1111111',
  'item2.TEL:+49 30 222222',
  'item2.X-ABLabel:Büro',
  'item3.ADR;type=HOME;type=pref:;;Lindenstraße 3;München;;80331;Deutschland',
  'item3.X-ABADR:de',
  'BDAY;X-APPLE-OMIT-YEAR=1604:1604-04-15',
  'NOTE:Kennt sich mit Kaffee aus\\, sehr.\\nZweite Zeile',
  'item4.URL;type=pref:https://example.com',
  'item4.X-ABLabel:_$!<HomePage>!$_',
  'X-SOCIALPROFILE;type=twitter:https://twitter.com/anna',
  'CATEGORIES:Freunde,Arbeit',
  'IMPP;X-SERVICE-TYPE=Skype;type=HOME;type=pref:skype:anna.s',
  `PHOTO;ENCODING=b;TYPE=JPEG:${JPEG}`,
  'UID:ABC-123',
  'END:VCARD',
])

const V40 = crlf([
  'BEGIN:VCARD',
  'VERSION:4.0',
  'KIND:individual',
  'UID:urn:uuid:4fbe8971-0bc3-424c-9c26-36c3e1eff6b1',
  'FN:Émile Zola',
  'N:Zola;Émile;;;',
  'EMAIL;TYPE=work:emile@example.fr',
  'EMAIL;PREF=1;TYPE=home:emile.zola@example.org',
  'TEL;VALUE=uri;TYPE="cell,voice":tel:+33-6-12-34-56-78',
  'BDAY:--0402',
  `PHOTO:data:image/png;base64,${PNG}`,
  'GENDER:M',
  'CATEGORIES:Autoren',
  'END:VCARD',
])

function fieldsOf(card: ParsedCard, uid = card.uid): CardFields {
  const { raw: _raw, kind: _kind, version: _version, ...fields } = card
  return { ...fields, uid }
}

function modeled(card: ParsedCard | null): Omit<ParsedCard, 'raw' | 'version'> | null {
  if (!card) return null
  const { raw: _raw, version: _version, ...rest } = card
  return rest
}

function outputLines(vcf: string): string[] {
  return vcf.replace(/\r\n[ \t]/g, '').split('\r\n')
}

describe('parseVcards', () => {
  it('reads an Outlook vCard 2.1 export (quoted-printable, bare types, base64 photo)', () => {
    const [card] = parseVcards(OUTLOOK_21)
    expect(card).toBeDefined()
    expect(card!.version).toBe('2.1')
    expect(card!.name).toBe('Dr. Jörg Müller')
    expect(card!.firstName).toBe('Jörg')
    expect(card!.lastName).toBe('Müller')
    expect(card!.organization).toBe('Beispiel GmbH')
    expect(card!.jobTitle).toBe('Vertriebsleiter')
    expect(card!.note).toBe(
      'Erste Zeile\nZweite Zeile mit einem sehr langen Text, der auf mehrere Zeilen umbrochen wird\nStraße',
    )
    expect(card!.phones).toEqual([
      { type: 'work', value: '+49 30 1234567' },
      { type: 'cell', value: '+49 171 7654321' },
      { type: 'fax', value: '+49 30 1234568' },
    ])
    // the PREF one first, INTERNET is not a label
    expect(card!.emails).toEqual([
      { type: '', value: 'joerg.mueller@beispiel.de' },
      { type: '', value: 'jm@privat.de' },
    ])
    expect(card!.addresses).toEqual([
      { type: 'work', value: 'Hauptstraße 5\n10115 Berlin\nDeutschland' },
    ])
    expect(card!.birthday).toBe('1975-04-12')
    expect(card!.photo).toBe(`data:image/jpeg;base64,${JPEG}`)
    expect(card!.uid).toBe('')
  })

  it('decodes quoted-printable in the named code page', () => {
    const [card] = parseVcards(
      crlf([
        'BEGIN:VCARD',
        'VERSION:2.1',
        'N;CHARSET=Windows-1252;ENCODING=QUOTED-PRINTABLE:Gr=FC=DFer;J=FCrgen',
        'NOTE;QUOTED-PRINTABLE:Sch=F6ne Gr=FC=DFe',
        'END:VCARD',
      ]),
    )
    expect(card!.lastName).toBe('Grüßer')
    expect(card!.firstName).toBe('Jürgen')
    expect(card!.name).toBe('Jürgen Grüßer')
    // no CHARSET and not UTF-8: Outlook's Windows code page
    expect(card!.note).toBe('Schöne Grüße')
  })

  it('reads Apple 3.0 cards: item groups with X-ABLabel, pref, omitted birth year, photo', () => {
    const [card] = parseVcards(APPLE_30)
    expect(card!.uid).toBe('ABC-123')
    expect(card!.name).toBe('Anna Schmidt')
    expect(card!.organization).toBe('Beispiel AG')
    expect(card!.emails).toEqual([
      { type: 'other', value: 'anna@example.com' },
      { type: 'work', value: 'anna.schmidt@beispiel.de' },
    ])
    expect(card!.phones).toEqual([
      { type: 'cell', value: '+49 170 1111111' },
      { type: 'büro', value: '+49 30 222222' },
    ])
    expect(card!.addresses).toEqual([
      { type: 'home', value: 'Lindenstraße 3\n80331 München\nDeutschland' },
    ])
    expect(card!.birthday).toBe('--04-15')
    expect(card!.note).toBe('Kennt sich mit Kaffee aus, sehr.\nZweite Zeile')
    expect(card!.photo).toBe(`data:image/jpeg;base64,${JPEG}`)
    expect(card!.kind).toBe('individual')
  })

  it('reads vCard 4.0: PREF=1, quoted TYPE lists, tel: URIs, --MMDD, data: URI photo', () => {
    const [card] = parseVcards(V40)
    expect(card!.uid).toBe('urn:uuid:4fbe8971-0bc3-424c-9c26-36c3e1eff6b1')
    expect(card!.emails).toEqual([
      { type: 'home', value: 'emile.zola@example.org' },
      { type: 'work', value: 'emile@example.fr' },
    ])
    expect(card!.phones).toEqual([{ type: 'cell', value: '+33-6-12-34-56-78' }])
    expect(card!.birthday).toBe('--04-02')
    expect(card!.photo).toBe(`data:image/png;base64,${PNG}`)
  })

  it('reads many cards, skips garbage and survives a missing END and a BOM', () => {
    const text =
      '﻿' +
      crlf([
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Eins',
        'END:VCARD',
        'das ist keine vCard-Zeile',
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Zwei',
        'BEGIN:VCARD',
        'fn:Drei',
        'END:VCARD',
        'BEGIN:VCARD',
        'VERSION:3.0',
        'NOTE:nur eine Notiz',
        'END:VCARD',
        'BEGIN:VCALENDAR',
        'END:VCALENDAR',
      ])
    expect(parseVcards(text).map((c) => c.name)).toEqual(['Eins', 'Zwei', 'Drei'])
    expect(parseVcards('')).toEqual([])
    expect(parseVcards('\u0000\u0001 binary : junk')).toEqual([])
    expect(parseVcards(undefined as unknown as string)).toEqual([])
    const many = Array.from({ length: 300 }, (_, i) =>
      crlf(['BEGIN:VCARD', 'VERSION:3.0', `FN:Person ${i}`, `UID:p${i}`, 'END:VCARD']),
    ).join('')
    expect(parseVcards(many)).toHaveLength(300)
  })

  it('derives FN from N and N from FN', () => {
    const fromN = parseVcard(crlf(['BEGIN:VCARD', 'VERSION:3.0', 'N:Schmidt;Anna;;;', 'END:VCARD']))
    expect(fromN!.name).toBe('Anna Schmidt')
    const fromFn = parseVcard(
      crlf(['BEGIN:VCARD', 'VERSION:3.0', 'FN:Max Mustermann', 'END:VCARD']),
    )
    expect([fromFn!.firstName, fromFn!.lastName]).toEqual(['Max', 'Mustermann'])
    const comma = parseVcard(crlf(['BEGIN:VCARD', 'FN:Mustermann, Erika', 'END:VCARD']))
    expect([comma!.firstName, comma!.lastName]).toEqual(['Erika', 'Mustermann'])
    const onlyMail = parseVcard(crlf(['BEGIN:VCARD', 'EMAIL:info@firma.de', 'END:VCARD']))
    expect(onlyMail!.name).toBe('info@firma.de')
    expect([onlyMail!.firstName, onlyMail!.lastName]).toEqual(['', ''])
  })

  it('marks groups and ignores remote photos', () => {
    const group = parseVcard(
      crlf([
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:Familie',
        'X-ADDRESSBOOKSERVER-KIND:group',
        'END:VCARD',
      ]),
    )
    expect(group!.kind).toBe('group')
    const remote = parseVcard(
      crlf([
        'BEGIN:VCARD',
        'VERSION:3.0',
        'FN:X',
        'PHOTO;VALUE=uri:https://example.com/x.jpg',
        'END:VCARD',
      ]),
    )
    expect(remote!.photo).toBeUndefined()
  })
})

describe('serializeVcard', () => {
  it('always writes VERSION 3.0, PRODID, UID, FN and N', () => {
    const vcf = serializeVcard({
      uid: 'u-1',
      name: 'Max Mustermann',
      emails: [{ type: 'work', value: 'max@firma.de' }],
    })
    const lines = outputLines(vcf)
    expect(lines[0]).toBe('BEGIN:VCARD')
    expect(lines).toContain('VERSION:3.0')
    expect(lines.some((l) => l.startsWith('PRODID:'))).toBe(true)
    expect(lines).toContain('UID:u-1')
    expect(lines).toContain('FN:Max Mustermann')
    expect(lines).toContain('N:Mustermann;Max;;;')
    expect(lines).toContain('EMAIL;TYPE=INTERNET,WORK:max@firma.de')
    expect(vcf.endsWith('END:VCARD\r\n')).toBe(true)

    const named = outputLines(
      serializeVcard({ uid: 'u-2', name: '', firstName: 'Anna', lastName: 'Schmidt' }),
    )
    expect(named).toContain('FN:Anna Schmidt')
    expect(named).toContain('N:Schmidt;Anna;;;')
  })

  it('round-trips every field and folds long lines at 75 octets', () => {
    const fields: CardFields = {
      uid: 'rt-1',
      name: 'Zoë Müller-Lüdenscheidt',
      firstName: 'Zoë',
      lastName: 'Müller-Lüdenscheidt',
      emails: [
        { type: 'home', value: 'zoe@example.de' },
        { type: 'privat', value: 'zoe@privat.de' },
      ],
      phones: [
        { type: 'cell', value: '+49 170 1234567' },
        { type: 'work', value: '030 123' },
      ],
      organization: 'Groß & Söhne; Partner',
      jobTitle: 'Chefin, Einkauf',
      birthday: '--12-24',
      addresses: [{ type: 'home', value: 'Am Ring 1\nHinterhaus\n50667 Köln\nDeutschland' }],
      note: 'Zeile 1\nZeile 2; mit Semikolon, Komma und Backslash \\ '.repeat(4).trim(),
      photo: `data:image/png;base64,${PNG}`,
    }
    const vcf = serializeVcard(fields)
    for (const line of vcf.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75)
    const card = parseVcard(vcf)!
    expect(fieldsOf(card)).toEqual(fields)
    expect(vcf).toContain('BDAY;X-APPLE-OMIT-YEAR=1604:1604-12-24')
  })

  it('keeps unknown properties, groups and untouched lines of an Apple card', () => {
    const card = parseVcard(APPLE_30)!
    const vcf = serializeVcard(fieldsOf(card), card.raw)
    const lines = outputLines(vcf)
    for (const kept of [
      'item1.EMAIL;TYPE=INTERNET,pref:anna@example.com',
      'item1.X-ABLABEL:_$!<Other>!$_',
      'item2.X-ABLABEL:Büro',
      'item3.X-ABADR:de',
      'item4.URL;TYPE=pref:https://example.com',
      'item4.X-ABLABEL:_$!<HomePage>!$_',
      'X-SOCIALPROFILE;TYPE=twitter:https://twitter.com/anna',
      'CATEGORIES:Freunde,Arbeit',
      'IMPP;X-SERVICE-TYPE=Skype;TYPE=HOME,pref:skype:anna.s',
      'BDAY;X-APPLE-OMIT-YEAR=1604:1604-04-15',
    ]) {
      expect(lines).toContain(kept)
    }
    expect(lines.filter((l) => l.startsWith('PRODID'))).toEqual([
      'PRODID:-//Suite Office//Mail//DE',
    ])
    expect(modeled(parseVcard(vcf))).toEqual(modeled(card))
    // a second pass changes nothing but REV
    const again = serializeVcard(fieldsOf(card), vcf)
    expect(again.replace(/REV:.*/, '')).toBe(vcf.replace(/REV:.*/, ''))
  })

  it('rewrites only what changed and gives new labels an unused group', () => {
    const card = parseVcard(APPLE_30)!
    const vcf = serializeVcard(
      {
        ...fieldsOf(card),
        emails: [
          { type: 'work', value: 'anna.schmidt@beispiel.de' },
          { type: 'privat', value: 'anna@privat.de' },
        ],
        organization: 'Neue AG',
      },
      card.raw,
    )
    const lines = outputLines(vcf)
    expect(vcf).not.toContain('anna@example.com')
    expect(vcf).not.toContain('_$!<Other>!$_')
    // item2 … item4 are still in use: the freed item1 is taken
    expect(lines).toContain('item1.EMAIL;TYPE=INTERNET:anna@privat.de')
    expect(lines).toContain('item1.X-ABLabel:Privat')
    expect(lines).toContain('item2.TEL:+49 30 222222')
    expect(lines).toContain('ORG:Neue AG;')
    const back = parseVcard(vcf)!
    expect(back.emails).toEqual([
      { type: 'work', value: 'anna.schmidt@beispiel.de' },
      { type: 'privat', value: 'anna@privat.de' },
    ])
    expect(back.organization).toBe('Neue AG')
  })

  it('converts a 2.1 card to 3.0 without losing its extras', () => {
    const card = parseVcard(OUTLOOK_21)!
    const vcf = serializeVcard(fieldsOf(card, 'new-uid'), card.raw)
    expect(vcf).not.toMatch(/QUOTED-PRINTABLE|CHARSET|VERSION:2\.1|BASE64/i)
    const lines = outputLines(vcf)
    expect(lines).toContain('N:Müller;Jörg;;Dr.;')
    expect(lines).toContain('ORG:Beispiel GmbH;Vertrieb')
    expect(lines).toContain('X-MS-IMADDRESS:joerg@im.example')
    expect(lines).toContain('X-MS-OL-DEFAULT-POSTAL-ADDRESS:2')
    expect(lines).toContain('LABEL;TYPE=WORK,PREF:Hauptstraße 5\\n10115 Berlin\\nDeutschland')
    expect(lines.some((l) => l.startsWith('X-MS-OL-DESIGN:<card'))).toBe(true)
    expect(lines).toContain(`PHOTO;ENCODING=b;TYPE=JPEG:${JPEG}`)
    expect(lines).toContain('UID:new-uid')
    expect(lines.filter((l) => l.startsWith('REV:'))).toHaveLength(1)
    expect(modeled(parseVcard(vcf))).toEqual({ ...modeled(card), uid: 'new-uid' })
  })

  it('keeps the department, middle names and honorifics when names change', () => {
    const card = parseVcard(OUTLOOK_21)!
    const lines = outputLines(
      serializeVcard(
        { ...fieldsOf(card), lastName: 'Meier', name: 'Dr. Jörg Meier', organization: 'Neu GmbH' },
        card.raw,
      ),
    )
    expect(lines).toContain('N:Meier;Jörg;;Dr.;')
    expect(lines).toContain('ORG:Neu GmbH;Vertrieb')
  })

  it('drops the stale LABEL once an address changes, and a removed photo', () => {
    const card = parseVcard(OUTLOOK_21)!
    const vcf = serializeVcard(
      {
        ...fieldsOf(card),
        addresses: [{ type: 'work', value: 'Neue Str. 1\n20095 Hamburg' }],
        photo: undefined,
      },
      card.raw,
    )
    expect(vcf).not.toContain('LABEL')
    expect(vcf).not.toContain('PHOTO')
    expect(outputLines(vcf)).toContain('ADR;TYPE=WORK:;;Neue Str. 1;Hamburg;;20095;')
  })

  it('carries over what it cannot model: remote photos, text birthdays, second titles', () => {
    const raw = crlf([
      'BEGIN:VCARD',
      'VERSION:4.0',
      'FN:Alt',
      'PHOTO:https://example.com/p.jpg',
      'BDAY;VALUE=text:circa 1800',
      'TITLE:Erster Titel',
      'TITLE:Zweiter Titel',
      'END:VCARD',
    ])
    const card = parseVcard(raw)!
    expect(card.birthday).toBe('')
    expect(card.jobTitle).toBe('Erster Titel')
    const lines = outputLines(serializeVcard({ ...fieldsOf(card, 'x'), jobTitle: 'Neu' }, raw))
    expect(lines).toContain('PHOTO:https://example.com/p.jpg')
    expect(lines).toContain('BDAY;VALUE=text:circa 1800')
    expect(lines).toContain('TITLE:Neu')
    expect(lines).toContain('TITLE:Zweiter Titel')
    expect(lines).not.toContain('TITLE:Erster Titel')
  })

  it('writes the preferred (first) value with PREF so other apps keep the order', () => {
    const card = parseVcard(V40)!
    const vcf = serializeVcard(fieldsOf(card), card.raw)
    const lines = outputLines(vcf)
    expect(lines).toContain('EMAIL;TYPE=INTERNET,HOME,PREF:emile.zola@example.org')
    expect(lines).toContain('EMAIL;TYPE=INTERNET,WORK:emile@example.fr')
    expect(lines).toContain('TEL;TYPE=CELL:+33-6-12-34-56-78')
    expect(lines).toContain('GENDER:M')
    expect(lines).toContain('KIND:individual')
    expect(modeled(parseVcard(vcf))).toEqual(modeled(card))
  })
})

describe('addresses and birthdays', () => {
  it('formats structured addresses and reads typed ones back', () => {
    const de = ['', '', 'Hauptstraße 5', 'Berlin', '', '10115', 'Deutschland']
    expect(formatAddress(de)).toBe('Hauptstraße 5\n10115 Berlin\nDeutschland')
    expect(parseAddressText(formatAddress(de))).toEqual(de)
    const us = ['', '', '1 Infinite Loop', 'Cupertino', 'CA', '95014', 'USA']
    expect(formatAddress(us)).toBe('1 Infinite Loop\nCupertino, CA 95014\nUSA')
    expect(parseAddressText(formatAddress(us))).toEqual(us)
    const nl = parseAddressText('Damrak 1\n1012 LG Amsterdam\nNoord-Holland\nNiederlande')
    expect(nl).toEqual(['', '', 'Damrak 1', 'Amsterdam', 'Noord-Holland', '1012 LG', 'Niederlande'])
    // no recognizable city line: everything stays, as the street
    expect(parseAddressText('Irgendwo im Nirgendwo\nbeim großen Baum')).toEqual([
      '',
      '',
      'Irgendwo im Nirgendwo\nbeim großen Baum',
      '',
      '',
      '',
      '',
    ])
  })

  it('normalizes birthdays', () => {
    expect(normalizeBirthday('19850412')).toBe('1985-04-12')
    expect(normalizeBirthday('1985-04-12T00:00:00Z')).toBe('1985-04-12')
    expect(normalizeBirthday('--0412')).toBe('--04-12')
    expect(normalizeBirthday('--04-12')).toBe('--04-12')
    expect(normalizeBirthday('1604-04-12', '1604')).toBe('--04-12')
    expect(normalizeBirthday('12.4.1985')).toBe('1985-04-12')
    expect(normalizeBirthday('1985-13-01')).toBe('')
    expect(normalizeBirthday('circa 1800')).toBe('')
  })
})
