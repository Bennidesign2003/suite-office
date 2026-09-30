// @vitest-environment jsdom
import { act, createElement, useState, type ReactElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AddressBookInfo,
  AddressSuggestion,
  Contact,
  ContactInput,
  PimApi,
  PimChange,
  PimSource,
  SourceKind,
} from '../src/shared/pim'

// written by another module; only its props matter here
vi.mock('../src/renderer/pim/SourceDialog', () => ({
  SourceDialog: (props: { kinds: SourceKind[]; source?: PimSource; onClose(): void }) =>
    createElement(
      'div',
      {
        'data-testid': 'source-dialog',
        'data-kinds': props.kinds.join(','),
        'data-source': props.source?.id ?? '',
      },
      createElement('button', { onClick: props.onClose }, 'close-source'),
    ),
}))

const { ContactsApp } = await import('../src/renderer/contacts/ContactsApp')
const { AddressInput } = await import('../src/renderer/components/AddressInput')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// ---- fixtures ----

const SOURCES: PimSource[] = [
  { id: 'local', kind: 'local', name: 'Auf diesem Computer', hasPassword: false },
  {
    id: 'dav1',
    kind: 'carddav',
    name: 'Nextcloud',
    url: 'https://cloud.example/remote.php/dav',
    user: 'anna',
    hasPassword: true,
    error: 'Anmeldung fehlgeschlagen (401)',
  },
  { id: 'cal', kind: 'caldav', name: 'Nur Kalender', hasPassword: true },
]

const BOOKS: AddressBookInfo[] = [
  { id: 'local:contacts', sourceId: 'local', name: 'Kontakte', readOnly: false },
  { id: 'dav1:shared', sourceId: 'dav1', name: 'Firma (geteilt)', readOnly: true },
]

function contact(p: Partial<Contact> & { uid: string; addressBookId: string }): Contact {
  return {
    id: `${p.addressBookId}|${p.uid}`,
    name: '',
    firstName: '',
    lastName: '',
    emails: [],
    phones: [],
    organization: '',
    jobTitle: '',
    birthday: '',
    addresses: [],
    note: '',
    readOnly: false,
    ...p,
  }
}

const ANNA = contact({
  uid: 'anna',
  addressBookId: 'local:contacts',
  name: 'Anna Schmidt',
  firstName: 'Anna',
  lastName: 'Schmidt',
  emails: [{ type: 'work', value: 'anna@firma.de' }],
  phones: [{ type: 'cell', value: '+49 (170) 123 4567' }],
  organization: 'Firma GmbH',
  jobTitle: 'Einkauf',
  birthday: '1985-04-12',
  addresses: [{ type: 'work', value: 'Hauptstr. 1\n10115 Berlin' }],
  note: 'Mag Kaffee',
})
const BERND = contact({
  uid: 'bernd',
  addressBookId: 'local:contacts',
  name: 'Schmidt, Bernd',
  emails: [{ type: '', value: 'bernd@x.de' }],
  phones: [{ type: 'fax', value: '030 999' }],
  birthday: '--04-12',
})
const PRAXIS = contact({
  uid: 'praxis',
  addressBookId: 'local:contacts',
  organization: 'Ärztehaus Mitte',
  phones: [{ type: 'work', value: '030 123' }],
})
const INFO = contact({
  uid: 'info',
  addressBookId: 'local:contacts',
  emails: [{ type: '', value: 'info@shop.de' }],
})
const ZOE = contact({
  uid: 'zoe',
  addressBookId: 'dav1:shared',
  name: 'Zoe Zander',
  emails: [{ type: 'work', value: 'zoe@firma.de' }],
  readOnly: true,
})

// ---- a fake window.pimApi ----

function fakeApi(overrides: Partial<Record<keyof PimApi, unknown>> = {}) {
  let changed: ((change: PimChange) => void) | null = null
  const store = [ANNA, BERND, PRAXIS, INFO, ZOE]
  const api = {
    listSources: vi.fn(async () => SOURCES),
    listAddressBooks: vi.fn(async () => BOOKS),
    listContacts: vi.fn(async (query?: string) => ({
      ok: true,
      value: query
        ? store.filter((c) => JSON.stringify(c).toLowerCase().includes(query.toLowerCase()))
        : [...store],
    })),
    saveContact: vi.fn(async (input: ContactInput) => {
      const saved = contact({
        ...input,
        uid: input.uid ?? 'new-uid',
        emails: input.emails ?? [],
        phones: input.phones ?? [],
        addresses: input.addresses ?? [],
      } as Contact)
      store.splice(0, store.length, ...store.filter((c) => c.id !== saved.id), saved)
      return { ok: true, value: saved }
    }),
    deleteContact: vi.fn(async () => ({ ok: true })),
    importVcf: vi.fn(async () => ({ ok: true, value: 3 })),
    exportVcf: vi.fn(async () => ({ ok: true, value: '/home/u/Kontakte.vcf' })),
    sync: vi.fn(async () => ({ ok: true })),
    removeSource: vi.fn(async () => undefined),
    suggestAddresses: vi.fn(async (): Promise<AddressSuggestion[]> => []),
    onChanged: vi.fn((handler: (change: PimChange) => void) => {
      changed = handler
      return () => {
        changed = null
      }
    }),
  }
  // overrides replace methods but keep the mock types the tests inspect
  Object.assign(api, overrides)
  ;(window as { pimApi?: unknown }).pimApi = api
  return { api, emit: (change: PimChange) => changed?.(change) }
}

// ---- DOM helpers ----

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  delete (window as { pimApi?: unknown }).pimApi
  vi.restoreAllMocks()
})

async function settle(ms = 0): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })
}

async function render(element: ReactElement): Promise<void> {
  await act(async () => root.render(element))
  await settle()
}

function all<E extends HTMLElement = HTMLElement>(selector: string): E[] {
  return Array.from(container.querySelectorAll<E>(selector))
}

function find<E extends HTMLElement = HTMLElement>(selector: string, text?: string | RegExp): E {
  const el = all<E>(selector).find((e) => {
    if (text === undefined) return true
    const content = (e.textContent ?? '').trim()
    return typeof text === 'string' ? content === text : text.test(content)
  })
  if (!el) throw new Error(`nothing matches ${selector} ${String(text ?? '')}`)
  return el
}

async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  await settle()
}

async function type(el: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function choose(el: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value)
    el.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

async function key(
  el: HTMLElement,
  name: string,
  init: KeyboardEventInit = {},
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent('keydown', {
    key: name,
    bubbles: true,
    cancelable: true,
    ...init,
  })
  await act(async () => {
    el.dispatchEvent(event)
  })
  return event
}

const rowNames = (): string[] => all('.ct-row .ct-row-name').map((e) => e.textContent ?? '')

// ---- ContactsApp ----

describe('ContactsApp', () => {
  it('lists contacts grouped by first letter with initials and a count', async () => {
    fakeApi()
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))

    expect(all('.ct-letter').map((e) => e.textContent)).toEqual(['A', 'I', 'S', 'Z'])
    expect(rowNames()).toEqual([
      'Anna Schmidt',
      'Ärztehaus Mitte',
      'info@shop.de',
      'Schmidt, Bernd',
      'Zoe Zander',
    ])
    expect(find('.ct-count').textContent).toContain('5 Kontakte')
    const initials = all('.ct-row .ct-avatar').map((e) => e.textContent)
    expect(initials).toEqual(['AS', 'ÄM', 'I', 'SB', 'ZZ'])
    // the same name always gets the same tone
    const tone = (i: number) => all('.ct-row .ct-avatar')[i]!.className.match(/ct-tone-\d/)?.[0]
    expect(tone(0)).toMatch(/^ct-tone-[1-8]$/)
  })

  it('groups address books by source and shows a sync error with account actions', async () => {
    fakeApi()
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))

    const names = all('.ct-source-name').map((e) => e.textContent)
    // calendar-only sources do not appear here
    expect(names).toEqual(['Auf diesem Computer', 'Nextcloud'])
    expect(find('.ct-source-error').textContent).toContain('Anmeldung fehlgeschlagen (401)')
    const localRow = all('.ct-source-row')[0]!
    expect(localRow.querySelectorAll('button')).toHaveLength(0)
    const davRow = all('.ct-source-row')[1]!
    expect(davRow.querySelectorAll('button')).toHaveLength(2)
    // the shared book is marked read-only
    expect(find('.ct-book', /Firma \(geteilt\)/).title).toContain('Schreibgeschützt')
  })

  it('shows a detail card and writes mail with a properly quoted recipient', async () => {
    fakeApi()
    const onWriteMail = vi.fn()
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail }))

    await click(find('.ct-row', /Anna Schmidt/))
    const card = find('.ct-card')
    expect(card.querySelector('h2')!.textContent).toBe('Anna Schmidt')
    expect(find('.ct-card-sub').textContent).toBe('Einkauf · Firma GmbH')
    expect(card.textContent).toContain('12. April 1985')
    expect(find('.ct-address').textContent).toBe('Hauptstr. 1\n10115 Berlin')
    expect(card.textContent).toContain('Mag Kaffee')
    const tel = card.querySelector<HTMLAnchorElement>('.ct-phone a')!
    expect(tel.getAttribute('href')).toBe('tel:+491701234567')
    expect(find('.ct-fields dt', 'Mobil')).toBeTruthy()

    await click(find('.ct-email', 'anna@firma.de'))
    expect(onWriteMail).toHaveBeenCalledWith('Anna Schmidt <anna@firma.de>')

    await click(find('.ct-row', /Schmidt, Bernd/))
    expect(find('.ct-card').textContent).toContain('12. April')
    expect(find('.ct-card').textContent).not.toContain('12. April 1985')
    await click(find('.ct-email', 'bernd@x.de'))
    expect(onWriteMail).toHaveBeenLastCalledWith('"Schmidt, Bernd" <bernd@x.de>')
  })

  it('disables editing for read-only address books', async () => {
    fakeApi()
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))
    await click(find('.ct-row', /Zoe Zander/))
    expect(find<HTMLButtonElement>('.ct-card-actions button', 'Bearbeiten').disabled).toBe(true)
    expect(find<HTMLButtonElement>('.ct-card-actions button', 'Löschen').disabled).toBe(true)
    expect(find('.ct-card-book').textContent).toContain('Schreibgeschützt')
  })

  it('filters by address book', async () => {
    fakeApi()
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))
    await click(find('.ct-book', /Firma \(geteilt\)/))
    expect(rowNames()).toEqual(['Zoe Zander'])
    expect(find('.ct-count').textContent).toBe('1 Kontakt · Firma (geteilt)')
    await click(find('.ct-book', /Alle Kontakte/))
    expect(rowNames()).toHaveLength(5)
  })

  it('debounces the search and asks the main process', async () => {
    const { api } = fakeApi()
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))
    expect(api.listContacts).toHaveBeenCalledTimes(1)

    const search = find<HTMLInputElement>('.ct-search input')
    await type(search, 'z')
    await type(search, 'zo')
    await type(search, 'zoe')
    await settle(50)
    expect(api.listContacts).toHaveBeenCalledTimes(1)
    await settle(250)
    expect(api.listContacts).toHaveBeenCalledTimes(2)
    expect(api.listContacts).toHaveBeenLastCalledWith('zoe')
    expect(rowNames()).toEqual(['Zoe Zander'])
  })

  it('drops a slow search answer that a newer one overtook', async () => {
    const slow: Array<() => void> = []
    const { api } = fakeApi()
    const all5 = await api.listContacts()
    api.listContacts.mockImplementation(async (query?: string) => {
      if (query === 'an') await new Promise<void>((resolve) => slow.push(resolve))
      return query === 'zoe'
        ? { ok: true, value: [ZOE] }
        : { ok: true, value: query ? [ANNA] : all5.value }
    })
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))
    const search = find<HTMLInputElement>('.ct-search input')
    await type(search, 'an')
    await settle(250)
    await type(search, 'zoe')
    await settle(250)
    expect(rowNames()).toEqual(['Zoe Zander'])
    slow.forEach((resolve) => resolve())
    await settle()
    expect(rowNames()).toEqual(['Zoe Zander'])
  })

  it('reloads when the main process reports a change', async () => {
    const { api, emit } = fakeApi()
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))
    const before = api.listContacts.mock.calls.length
    await act(async () => emit({ kind: 'contacts' }))
    await settle()
    expect(api.listContacts.mock.calls.length).toBe(before + 1)
    const sourcesBefore = api.listSources.mock.calls.length
    await act(async () => emit({ kind: 'sources' }))
    await settle()
    expect(api.listSources.mock.calls.length).toBe(sourcesBefore + 1)
    // calendar changes are none of this module's business
    await act(async () => emit({ kind: 'calendar' }))
    await settle()
    expect(api.listContacts.mock.calls.length).toBe(before + 1)
  })

  it('deletes after confirmation only', async () => {
    const { api } = fakeApi()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))
    await click(find('.ct-row', /Anna Schmidt/))
    await click(find('.ct-card-actions button', 'Löschen'))
    expect(confirm).toHaveBeenCalledWith('Kontakt „Anna Schmidt“ löschen?')
    expect(api.deleteContact).not.toHaveBeenCalled()

    confirm.mockReturnValue(true)
    await click(find('.ct-card-actions button', 'Löschen'))
    expect(api.deleteContact).toHaveBeenCalledWith('local:contacts', 'anna')
    // the next contact takes over the selection
    expect(find('.ct-row.selected').textContent).toContain('Ärztehaus Mitte')
  })

  it('moves through the list with the keyboard', async () => {
    fakeApi()
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))
    const list = find('.ct-list')
    await key(list, 'ArrowDown')
    expect(find('.ct-row.selected').textContent).toContain('Anna Schmidt')
    await key(list, 'ArrowDown')
    await key(list, 'ArrowDown')
    expect(find('.ct-row.selected').textContent).toContain('info@shop.de')
    await key(list, 'End')
    expect(find('.ct-row.selected').textContent).toContain('Zoe Zander')
    expect(list.getAttribute('aria-activedescendant')).toBe(find('.ct-row.selected').id)
    // Enter on a read-only contact does not open the editor
    await key(list, 'Enter')
    expect(all('.ct-editor')).toHaveLength(0)
  })

  it('imports into the only writable book and exports through a book menu', async () => {
    const { api } = fakeApi()
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))

    await click(find('.tool', /Importieren/))
    expect(api.importVcf).toHaveBeenCalledWith('local:contacts')
    expect(find('.toast').textContent).toBe('3 Kontakte importiert.')

    await click(find('.tool', /Exportieren/))
    expect(api.exportVcf).not.toHaveBeenCalled()
    await click(find('.dropdown button', 'Firma (geteilt)'))
    expect(api.exportVcf).toHaveBeenCalledWith('dav1:shared')
    expect(find('.toast').textContent).toBe('Gespeichert unter /home/u/Kontakte.vcf')
  })

  it('cannot import into a read-only book', async () => {
    fakeApi()
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))
    await click(find('.ct-book', /Firma \(geteilt\)/))
    expect(find<HTMLButtonElement>('.tool', /Importieren/).disabled).toBe(true)
  })

  it('syncs and reports a failure', async () => {
    const { api } = fakeApi({
      sync: vi.fn(async () => ({ ok: false, error: 'Nextcloud: Server nicht erreichbar' })),
    })
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))
    await click(find('.tool', /Aktualisieren/))
    expect(api.sync).toHaveBeenCalledWith()
    expect(find('.toast.toast-error').textContent).toContain('Server nicht erreichbar')
  })

  it('opens the source dialog for CardDAV only and removes an account after confirmation', async () => {
    const { api } = fakeApi()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))

    await click(find('.ct-add-book'))
    const dialog = find('[data-testid="source-dialog"]')
    expect(dialog.dataset.kinds).toBe('carddav')
    expect(dialog.dataset.source).toBe('')
    await click(find('button', 'close-source'))
    expect(all('[data-testid="source-dialog"]')).toHaveLength(0)

    await click(find('.ct-source-row button[title="Konto bearbeiten"]'))
    expect(find('[data-testid="source-dialog"]').dataset.source).toBe('dav1')
    await click(find('button', 'close-source'))

    await click(find('.ct-source-row button[title="Konto entfernen"]'))
    expect(api.removeSource).toHaveBeenCalledWith('dav1')
  })

  it('works without the PIM bridge', async () => {
    await render(createElement(ContactsApp, { lang: 'en', onWriteMail: () => undefined }))
    expect(container.textContent).toContain('Contacts are not available here.')
  })

  it('survives malformed contacts from the main process', async () => {
    fakeApi({
      listContacts: vi.fn(async () => ({
        ok: true,
        value: [
          { id: 'x|1', uid: '1', addressBookId: 'local:contacts', name: 'Kaputt' },
          { ...ANNA, photo: 'https://tracker.example/pixel.gif' },
        ],
      })),
    })
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))
    expect(rowNames()).toEqual(['Anna Schmidt', 'Kaputt'])
    // a remote photo URL is never loaded
    expect(all('img')).toHaveLength(0)
    await click(find('.ct-row', /Kaputt/))
    expect(find('.ct-card h2').textContent).toBe('Kaputt')
  })
})

// ---- ContactEditor (through ContactsApp) ----

describe('ContactEditor', () => {
  const editor = () => find('.ct-editor')
  const field = (label: string) =>
    find<HTMLLabelElement>('.ct-editor label.ct-ed-field', new RegExp(`^${label}`)).querySelector<
      HTMLInputElement | HTMLTextAreaElement
    >('input, textarea')!

  it('creates a contact with an automatic display name', async () => {
    const { api } = fakeApi()
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))
    await click(find('.tool', /Neuer Kontakt/))
    expect(editor().querySelector('h2')!.textContent).toBe('Neuer Kontakt')

    await type(field('Vorname'), 'Carla')
    await type(field('Nachname'), 'Weber')
    expect(field('Anzeigename').value).toBe('Carla Weber')
    const email = editor().querySelector<HTMLInputElement>('input[type="email"]')!
    await type(email, 'carla@weber.de')
    await type(editor().querySelector<HTMLInputElement>('input[type="tel"]')!, '0171 555')
    await type(field('Firma'), 'Weber KG')

    await click(find('.ct-editor button[type="submit"]'))
    expect(api.saveContact).toHaveBeenCalledTimes(1)
    const input = api.saveContact.mock.calls[0]![0]
    expect(input).toMatchObject({
      addressBookId: 'local:contacts',
      uid: undefined,
      name: 'Carla Weber',
      firstName: 'Carla',
      lastName: 'Weber',
      emails: [{ type: 'home', value: 'carla@weber.de' }],
      phones: [{ type: 'cell', value: '0171 555' }],
      organization: 'Weber KG',
      addresses: [],
      birthday: '',
    })
    expect(all('.ct-editor')).toHaveLength(0)
    expect(find('.ct-row.selected').textContent).toContain('Carla Weber')
  })

  it('keeps a display name the user typed', async () => {
    const { api } = fakeApi()
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))
    await click(find('.tool', /Neuer Kontakt/))
    await type(field('Vorname'), 'Carla')
    await type(field('Anzeigename'), 'Dr. C. Weber')
    await type(field('Nachname'), 'Weber')
    expect(field('Anzeigename').value).toBe('Dr. C. Weber')
    await key(editor(), 'Enter', { ctrlKey: true })
    await settle()
    expect(api.saveContact.mock.calls[0]![0].name).toBe('Dr. C. Weber')
  })

  it('requires a name or an email and rejects a broken address', async () => {
    const { api } = fakeApi()
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))
    await click(find('.tool', /Neuer Kontakt/))
    await click(find('.ct-editor button[type="submit"]'))
    expect(find('.ct-ed-error').textContent).toBe(
      'Bitte gib mindestens einen Namen oder eine E-Mail-Adresse an.',
    )
    await type(editor().querySelector<HTMLInputElement>('input[type="email"]')!, 'carla@weber')
    await click(find('.ct-editor button[type="submit"]'))
    expect(find('.ct-ed-error').textContent).toBe('„carla@weber“ ist keine gültige E-Mail-Adresse.')
    expect(api.saveContact).not.toHaveBeenCalled()
  })

  it('keeps year-less birthdays, unknown types and untouched fields when editing', async () => {
    const { api } = fakeApi()
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))
    await click(find('.ct-row', /Schmidt, Bernd/))
    await click(find('.ct-card-actions button', 'Bearbeiten'))
    expect(editor().querySelector('h2')!.textContent).toBe('Kontakt bearbeiten')
    // the display name differs from first + last: it stays as stored
    expect(field('Anzeigename').value).toBe('Schmidt, Bernd')
    expect(find('.ct-ed-hint').textContent).toContain('Gespeichert ohne Jahr: 12. April')
    const phoneType = editor().querySelectorAll<HTMLSelectElement>('.ct-ed-rows select')[1]!
    expect(phoneType.value).toBe('fax')

    await type(field('Notiz'), 'Neu')
    await click(find('.ct-editor button[type="submit"]'))
    const input = api.saveContact.mock.calls[0]![0]
    expect(input).toMatchObject({
      addressBookId: 'local:contacts',
      uid: 'bernd',
      name: 'Schmidt, Bernd',
      birthday: '--04-12',
      emails: [{ type: '', value: 'bernd@x.de' }],
      phones: [{ type: 'fax', value: '030 999' }],
      note: 'Neu',
    })
    expect(input.photo).toBeUndefined()
  })

  it('changes a row type and removes empty rows', async () => {
    const { api } = fakeApi()
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))
    await click(find('.ct-row', /Anna Schmidt/))
    await click(find('.ct-card-actions button', 'Bearbeiten'))
    await click(find('.ct-ed-add', /E-Mail-Adresse hinzufügen/))
    const emailTypes = editor().querySelectorAll<HTMLSelectElement>('.ct-ed-rows')[0]!
    await choose(emailTypes.querySelectorAll('select')[0]!, 'home')
    await click(find('.ct-editor button[type="submit"]'))
    const input = api.saveContact.mock.calls[0]![0]
    expect(input.emails).toEqual([{ type: 'home', value: 'anna@firma.de' }])
    expect(input.birthday).toBe('1985-04-12')
    expect(input.addresses).toEqual([{ type: 'work', value: 'Hauptstr. 1\n10115 Berlin' }])
  })

  it('closes on Escape, asking first when something changed', async () => {
    fakeApi()
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))
    await click(find('.tool', /Neuer Kontakt/))
    await key(field('Vorname'), 'Escape')
    expect(all('.ct-editor')).toHaveLength(0)
    expect(confirm).not.toHaveBeenCalled()

    await click(find('.tool', /Neuer Kontakt/))
    await type(field('Vorname'), 'X')
    await key(field('Vorname'), 'Escape')
    expect(confirm).toHaveBeenCalledWith('Änderungen an diesem Kontakt verwerfen?')
    expect(all('.ct-editor')).toHaveLength(1)
  })

  it('shows a save error and stays open', async () => {
    fakeApi({
      saveContact: vi.fn(async () => ({ ok: false, error: 'Der Server hat abgelehnt (412).' })),
    })
    await render(createElement(ContactsApp, { lang: 'de', onWriteMail: () => undefined }))
    await click(find('.tool', /Neuer Kontakt/))
    await type(field('Vorname'), 'Carla')
    await click(find('.ct-editor button[type="submit"]'))
    expect(find('.ct-ed-error').textContent).toBe('Der Server hat abgelehnt (412).')
    expect(find<HTMLButtonElement>('.ct-editor button[type="submit"]').disabled).toBe(false)
  })
})

// ---- AddressInput ----

function Host({
  initial,
  onValue,
  onParentKey,
}: {
  initial: string
  onValue?(value: string): void
  onParentKey?(key: string): void
}): ReactElement {
  const [value, setValue] = useState(initial)
  return createElement(
    'div',
    { onKeyDown: (e: { key: string }) => onParentKey?.(e.key) },
    createElement(AddressInput, {
      value,
      lang: 'de',
      ariaLabel: 'An',
      onChange: (next: string) => {
        setValue(next)
        onValue?.(next)
      },
    }),
  )
}

const SUGGESTIONS: AddressSuggestion[] = [
  { name: 'Anna Schmidt', email: 'anna@firma.de', kind: 'contact' },
  { name: 'Schmidt, Bernd', email: 'bernd@x.de', kind: 'recent' },
  { name: '', email: 'ann@y.de', kind: 'recent' },
]

describe('AddressInput', () => {
  const input = () => find<HTMLInputElement>('.addr-input input')
  const options = () => all('.addr-option')

  it('suggests after a short pause and inserts with the keyboard', async () => {
    const { api } = fakeApi({ suggestAddresses: vi.fn(async () => SUGGESTIONS) })
    const onValue = vi.fn()
    await render(createElement(Host, { initial: 'x@y.de, ', onValue }))
    await type(input(), 'x@y.de, an')
    expect(api.suggestAddresses).not.toHaveBeenCalled()
    await settle(160)
    expect(api.suggestAddresses).toHaveBeenCalledWith('an', 8)
    expect(options()).toHaveLength(3)
    expect(options()[0]!.textContent).toContain('Anna Schmidt')
    expect(options()[0]!.textContent).toContain('anna@firma.de')
    expect(options()[0]!.textContent).toContain('Kontakt')
    expect(options()[1]!.textContent).toContain('Zuletzt')
    expect(input().getAttribute('aria-expanded')).toBe('true')

    await key(input(), 'ArrowDown')
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true')
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[1]!.id)
    const enter = await key(input(), 'Enter')
    expect(enter.defaultPrevented).toBe(true)
    expect(onValue).toHaveBeenLastCalledWith('x@y.de, "Schmidt, Bernd" <bernd@x.de>, ')
    expect(options()).toHaveLength(0)
    expect(input().selectionStart).toBe(input().value.length)
  })

  it('wraps around with ArrowUp and inserts with Tab', async () => {
    fakeApi({ suggestAddresses: vi.fn(async () => SUGGESTIONS) })
    const onValue = vi.fn()
    await render(createElement(Host, { initial: '', onValue }))
    await type(input(), 'an')
    await settle(160)
    await key(input(), 'ArrowUp')
    expect(options()[2]!.getAttribute('aria-selected')).toBe('true')
    const tab = await key(input(), 'Tab')
    expect(tab.defaultPrevented).toBe(true)
    expect(onValue).toHaveBeenLastCalledWith('ann@y.de, ')
  })

  it('leaves Enter and Tab alone while no list is open', async () => {
    fakeApi()
    await render(createElement(Host, { initial: '' }))
    await type(input(), 'zz')
    await settle(160)
    expect(options()).toHaveLength(0)
    expect((await key(input(), 'Enter')).defaultPrevented).toBe(false)
    expect((await key(input(), 'Tab')).defaultPrevented).toBe(false)
  })

  it('inserts on click', async () => {
    fakeApi({ suggestAddresses: vi.fn(async () => SUGGESTIONS) })
    const onValue = vi.fn()
    await render(createElement(Host, { initial: '', onValue }))
    await type(input(), 'an')
    await settle(160)
    await click(options()[0]!)
    expect(onValue).toHaveBeenLastCalledWith('Anna Schmidt <anna@firma.de>, ')
  })

  it('closes on Escape without closing what surrounds it', async () => {
    fakeApi({ suggestAddresses: vi.fn(async () => SUGGESTIONS) })
    const onParentKey = vi.fn()
    await render(createElement(Host, { initial: '', onParentKey }))
    await type(input(), 'an')
    await settle(160)
    await key(input(), 'Escape')
    expect(options()).toHaveLength(0)
    expect(onParentKey).not.toHaveBeenCalledWith('Escape')
    // with the list closed, Escape reaches the dialog again
    await key(input(), 'Escape')
    expect(onParentKey).toHaveBeenCalledWith('Escape')
  })

  it('ignores an answer that arrives after a newer one', async () => {
    let releaseFirst: (list: AddressSuggestion[]) => void = () => undefined
    const suggest = vi.fn((query: string) =>
      query === 'a'
        ? new Promise<AddressSuggestion[]>((resolve) => (releaseFirst = resolve))
        : Promise.resolve([SUGGESTIONS[0]!]),
    )
    fakeApi({ suggestAddresses: suggest })
    await render(createElement(Host, { initial: '' }))
    await type(input(), 'a')
    await settle(160)
    await type(input(), 'an')
    await settle(160)
    expect(options().map((o) => o.textContent)).toEqual([expect.stringContaining('Anna Schmidt')])
    await act(async () => releaseFirst(SUGGESTIONS))
    await settle()
    expect(options()).toHaveLength(1)
  })

  it('does not suggest people already on the line', async () => {
    fakeApi({ suggestAddresses: vi.fn(async () => SUGGESTIONS) })
    await render(createElement(Host, { initial: '' }))
    await type(input(), 'Anna Schmidt <ANNA@firma.de>, an')
    await settle(160)
    expect(options().map((o) => o.textContent)).not.toContain(
      expect.stringContaining('anna@firma.de'),
    )
    expect(options()).toHaveLength(2)
  })

  it('closes after losing focus', async () => {
    fakeApi({ suggestAddresses: vi.fn(async () => SUGGESTIONS) })
    await render(createElement(Host, { initial: '' }))
    input().focus()
    await type(input(), 'an')
    await settle(160)
    expect(options()).toHaveLength(3)
    await act(async () => input().blur())
    await settle(200)
    expect(options()).toHaveLength(0)
  })

  it('is a plain input without the PIM bridge', async () => {
    const onValue = vi.fn()
    await render(createElement(Host, { initial: '', onValue }))
    await type(input(), 'a@b.de')
    await settle(160)
    expect(onValue).toHaveBeenLastCalledWith('a@b.de')
    expect(options()).toHaveLength(0)
    expect((await key(input(), 'Enter')).defaultPrevented).toBe(false)
  })

  it('survives a failing lookup', async () => {
    fakeApi({ suggestAddresses: vi.fn(async () => Promise.reject(new Error('gone'))) })
    await render(createElement(Host, { initial: '' }))
    await type(input(), 'an')
    await settle(160)
    expect(options()).toHaveLength(0)
  })
})
