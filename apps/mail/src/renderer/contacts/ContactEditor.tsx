import { useMemo, useRef, useState, type ReactElement } from 'react'
import type { AddressBookInfo, Contact, ContactInput, LabeledValue } from '../../shared/pim'
import { IconClose, IconPlus } from '../components/icons'
import { isLikelyEmail } from './address-tokens'
import { contactsTranslator, formatBirthday, typeName, type ContactsStringKey } from './i18n'
import type { Translate } from '../calendar/types'
import './contacts.css'

interface Props {
  lang: string
  /** absent when creating */
  contact?: Contact
  /** the address books a new contact may go to (writable ones) */
  books: AddressBookInfo[]
  defaultBookId?: string
  onClose(): void
  onSaved(contact: Contact): void
}

interface Row extends LabeledValue {
  key: number
}

type RowKind = 'email' | 'phone' | 'address'

const TYPES: Record<RowKind, string[]> = {
  email: ['home', 'work', 'other'],
  phone: ['cell', 'home', 'work', 'other'],
  address: ['home', 'work', 'other'],
}

const NEW_ROW_TYPE: Record<RowKind, string> = { email: 'home', phone: 'cell', address: 'home' }

const PHOTO_MAX_PX = 256
const PHOTO_MAX_BYTES = 25 * 1024 * 1024

class PhotoError extends Error {
  constructor(readonly reason: 'tooLarge' | 'unreadable') {
    super(reason)
  }
}

/**
 * Scales a picked picture to at most `max` pixels on its longer side and
 * returns it as a JPEG data URL — small enough to travel inside a vCard.
 */
export async function resizePhoto(file: Blob, max = PHOTO_MAX_PX): Promise<string> {
  if (file.size > PHOTO_MAX_BYTES) throw new PhotoError('tooLarge')
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = () => reject(new PhotoError('unreadable'))
      image.src = url
    })
    const w = img.naturalWidth
    const h = img.naturalHeight
    if (!w || !h) throw new PhotoError('unreadable')
    const scale = Math.min(1, max / Math.max(w, h))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(w * scale))
    canvas.height = Math.max(1, Math.round(h * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new PhotoError('unreadable')
    // JPEG has no transparency: a transparent logo gets white instead of black
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
    const data = canvas.toDataURL('image/jpeg', 0.88)
    if (!data.startsWith('data:image/')) throw new PhotoError('unreadable')
    return data
  } finally {
    URL.revokeObjectURL(url)
  }
}

function autoName(first: string, last: string, organization: string): string {
  return (
    [first, last]
      .map((s) => s.trim())
      .filter(Boolean)
      .join(' ') || organization.trim()
  )
}

/** what a date input can show: "1985-04-12" (also from "19850412"), else '' */
function dateInputValue(birthday: string): string {
  const m = /^(\d{4})-?(\d{2})-?(\d{2})(?:T.*)?$/.exec(birthday.trim())
  return m ? `${m[1]}-${m[2]}-${m[3]}` : ''
}

/**
 * Creates or edits a contact. Fields the dialog does not show (and vCard
 * properties the app does not know) stay untouched on the server: only the
 * values below are sent back.
 */
export function ContactEditor({
  lang,
  contact,
  books,
  defaultBookId,
  onClose,
  onSaved,
}: Props): ReactElement {
  const t = useMemo(() => contactsTranslator(lang), [lang])
  const nextKey = useRef(0)
  const rows = (list: LabeledValue[] | undefined): Row[] =>
    (list ?? []).map((v) => ({ type: v.type ?? '', value: v.value ?? '', key: nextKey.current++ }))

  const [firstName, setFirstName] = useState(contact?.firstName ?? '')
  const [lastName, setLastName] = useState(contact?.lastName ?? '')
  const [organization, setOrganization] = useState(contact?.organization ?? '')
  const [jobTitle, setJobTitle] = useState(contact?.jobTitle ?? '')
  // the display name follows first + last name until the user types one
  const [name, setName] = useState(contact?.name ?? '')
  const [nameTouched, setNameTouched] = useState(() => {
    if (!contact?.name?.trim()) return false
    const derived = autoName(
      contact.firstName ?? '',
      contact.lastName ?? '',
      contact.organization ?? '',
    )
    return contact.name.trim() !== derived && contact.name.trim() !== contact.emails?.[0]?.value
  })
  const [emails, setEmails] = useState<Row[]>(() => {
    const list = rows(contact?.emails)
    return list.length ? list : rows([{ type: NEW_ROW_TYPE.email, value: '' }])
  })
  const [phones, setPhones] = useState<Row[]>(() => {
    const list = rows(contact?.phones)
    return list.length ? list : rows([{ type: NEW_ROW_TYPE.phone, value: '' }])
  })
  const [addresses, setAddresses] = useState<Row[]>(() => rows(contact?.addresses))
  const [birthday, setBirthday] = useState(contact?.birthday ?? '')
  const [note, setNote] = useState(contact?.note ?? '')
  const [photo, setPhoto] = useState<string | undefined>(contact?.photo)
  const [bookId, setBookId] = useState(
    contact?.addressBookId ??
      (books.some((b) => b.id === defaultBookId) ? defaultBookId : books[0]?.id) ??
      '',
  )
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)

  const displayName = nameTouched ? name : autoName(firstName, lastName, organization)
  // addresses the contact already had are not re-validated: an odd one from
  // another program must not block saving an unrelated change
  const knownEmails = useMemo(
    () => new Set((contact?.emails ?? []).map((e) => (e.value ?? '').trim())),
    [contact],
  )

  const snapshot = JSON.stringify([
    firstName,
    lastName,
    displayName,
    organization,
    jobTitle,
    emails.map((r) => [r.type, r.value]),
    phones.map((r) => [r.type, r.value]),
    addresses.map((r) => [r.type, r.value]),
    birthday,
    note,
    photo ?? '',
    bookId,
  ])
  const initial = useRef(snapshot)
  const dirty = snapshot !== initial.current

  const requestClose = (): void => {
    if (saving) return
    if (dirty && !window.confirm(t('discardConfirm'))) return
    onClose()
  }

  const clean = (list: Row[], multiline = false): LabeledValue[] =>
    list
      .map((r) => ({
        type: r.type,
        value: multiline
          ? r.value
              .replace(/\r\n?/g, '\n')
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean)
              .join('\n')
          : r.value.trim(),
      }))
      .filter((r) => r.value)

  const save = async (): Promise<void> => {
    if (saving) return
    const outEmails = clean(emails)
    const shownName = displayName.trim()
    if (!shownName && !outEmails.length) {
      setError(t('needNameOrEmail'))
      return
    }
    const bad = outEmails.find((e) => !knownEmails.has(e.value) && !isLikelyEmail(e.value))
    if (bad) {
      setError(t('invalidEmail', { email: bad.value }))
      return
    }
    if (!bookId) {
      setError(t('noWritableBook'))
      return
    }
    const api = window.pimApi
    if (!api) {
      setError(t('unavailable'))
      return
    }
    const input: ContactInput = {
      addressBookId: bookId,
      uid: contact?.uid,
      // a vCard needs a formatted name; the address stands in when there is none
      name: shownName || outEmails[0]!.value,
      firstName: firstName.trim(),
      lastName: lastName.trim(),
      emails: outEmails,
      phones: clean(phones),
      organization: organization.trim(),
      jobTitle: jobTitle.trim(),
      birthday: birthday.trim(),
      addresses: clean(addresses, true),
      note: note.replace(/\r\n?/g, '\n').trim(),
      // undefined when there never was one; '' when the user removed it
      photo,
    }
    setSaving(true)
    setError('')
    try {
      const r = await api.saveContact(input)
      if (!r.ok || !r.value) {
        setError(r.error || t('errorPrefix'))
        setSaving(false)
        return
      }
      onSaved(r.value)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSaving(false)
    }
  }

  const pickPhoto = async (file: File | undefined): Promise<void> => {
    if (!file) return
    setError('')
    try {
      setPhoto(await resizePhoto(file))
    } catch (err) {
      setError(
        err instanceof PhotoError && err.reason === 'tooLarge'
          ? t('photoTooLarge')
          : t('photoError'),
      )
    }
  }

  const title = contact ? t('editorEdit') : t('editorNew')
  const shownPhoto = photo && /^data:image\//i.test(photo) ? photo : ''
  const dateValue = dateInputValue(birthday)
  // "--04-12" (no year) and other forms a date input cannot show are kept as
  // stored unless the user picks a date or removes them
  const keptBirthday = birthday.trim() && !dateValue ? birthday.trim() : ''

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && requestClose()}
    >
      <form
        className="modal ct-editor"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        noValidate
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            requestClose()
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault()
            void save()
          }
        }}
      >
        <h2>{title}</h2>
        <div className="ct-ed-head">
          <div className="ct-ed-photo">
            {shownPhoto ? (
              <img className="ct-avatar ct-avatar-lg" src={shownPhoto} alt={t('photo')} />
            ) : (
              <span className="ct-avatar ct-avatar-lg ct-ed-nophoto" aria-hidden>
                <IconPlus />
              </span>
            )}
            <button type="button" className="link-btn" onClick={() => fileInput.current?.click()}>
              {shownPhoto ? t('photoChange') : t('photoChoose')}
            </button>
            {shownPhoto && (
              <button type="button" className="link-btn" onClick={() => setPhoto('')}>
                {t('photoRemove')}
              </button>
            )}
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0]
                // the same file picked twice must fire change again
                e.target.value = ''
                void pickPhoto(file)
              }}
            />
          </div>
          <div className="ct-ed-grid">
            <label className="ct-ed-field">
              <span>{t('firstName')}</span>
              <input value={firstName} autoFocus onChange={(e) => setFirstName(e.target.value)} />
            </label>
            <label className="ct-ed-field">
              <span>{t('lastName')}</span>
              <input value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </label>
            <label className="ct-ed-field ct-ed-wide">
              <span>{t('displayName')}</span>
              <input
                value={displayName}
                onChange={(e) => {
                  setName(e.target.value)
                  // emptied: follow first + last name again
                  setNameTouched(e.target.value.trim() !== '')
                }}
              />
            </label>
            <label className="ct-ed-field">
              <span>{t('organization')}</span>
              <input value={organization} onChange={(e) => setOrganization(e.target.value)} />
            </label>
            <label className="ct-ed-field">
              <span>{t('jobTitle')}</span>
              <input value={jobTitle} onChange={(e) => setJobTitle(e.target.value)} />
            </label>
          </div>
        </div>

        <RowSection
          t={t}
          kind="email"
          title={t('email')}
          addLabel={t('addEmail')}
          rows={emails}
          onChange={setEmails}
          nextKey={() => nextKey.current++}
        />
        <RowSection
          t={t}
          kind="phone"
          title={t('phone')}
          addLabel={t('addPhone')}
          rows={phones}
          onChange={setPhones}
          nextKey={() => nextKey.current++}
        />
        <RowSection
          t={t}
          kind="address"
          title={t('address')}
          addLabel={t('addAddress')}
          rows={addresses}
          onChange={setAddresses}
          nextKey={() => nextKey.current++}
        />

        <div className="ct-ed-pair">
          <label className="ct-ed-field">
            <span>{t('birthday')}</span>
            <input type="date" value={dateValue} onChange={(e) => setBirthday(e.target.value)} />
          </label>
          {!contact && books.length > 0 ? (
            <label className="ct-ed-field">
              <span>{t('addressBook')}</span>
              <select
                value={bookId}
                onChange={(e) => setBookId(e.target.value)}
                disabled={books.length < 2}
              >
                {books.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span />
          )}
        </div>
        {keptBirthday && (
          <p className="ct-ed-hint">
            {keptBirthday.startsWith('--')
              ? t('birthdayNoYear', { date: formatBirthday(keptBirthday, lang) })
              : t('birthdayStored', { date: keptBirthday })}{' '}
            <button
              type="button"
              className="icon-btn ct-ed-inline"
              title={t('removeRow')}
              aria-label={t('removeRow')}
              onClick={() => setBirthday('')}
            >
              <IconClose />
            </button>
          </p>
        )}

        <label className="ct-ed-field ct-ed-section">
          <span>{t('note')}</span>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        {error && (
          <p className="ct-ed-error" role="alert">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <span className="spacer" />
          <button type="button" className="btn" onClick={requestClose} disabled={saving}>
            {t('cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? t('saving') : t('save')}
          </button>
        </div>
      </form>
    </div>
  )
}

function RowSection({
  t,
  kind,
  title,
  addLabel,
  rows,
  onChange,
  nextKey,
}: {
  t: Translate<ContactsStringKey>
  kind: RowKind
  title: string
  addLabel: string
  rows: Row[]
  onChange(rows: Row[]): void
  nextKey(): number
}): ReactElement {
  const update = (key: number, patch: Partial<LabeledValue>): void =>
    onChange(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const base = TYPES[kind]
  return (
    <fieldset className="ct-ed-section ct-ed-rows">
      <legend>{title}</legend>
      {rows.map((row) => {
        // '' (no TYPE) reads as "other"; a type we do not offer stays selectable
        // so saving never rewrites it
        const selected = row.type === '' ? 'other' : row.type
        const options = base.includes(selected) ? base : [...base, selected]
        return (
          <div key={row.key} className={`ct-ed-row${kind === 'address' ? ' ct-ed-row-top' : ''}`}>
            <select
              aria-label={`${title}: ${t('typeLabel')}`}
              value={selected}
              onChange={(e) => update(row.key, { type: e.target.value })}
            >
              {options.map((type) => (
                <option key={type} value={type}>
                  {typeName(t, type) || type}
                </option>
              ))}
            </select>
            {kind === 'address' ? (
              <textarea
                rows={3}
                aria-label={title}
                placeholder={t('addressPlaceholder')}
                value={row.value}
                onChange={(e) => update(row.key, { value: e.target.value })}
              />
            ) : (
              <input
                type={kind === 'email' ? 'email' : 'tel'}
                aria-label={title}
                value={row.value}
                spellCheck={false}
                onChange={(e) => update(row.key, { value: e.target.value })}
              />
            )}
            <button
              type="button"
              className="icon-btn"
              title={t('removeRow')}
              aria-label={t('removeRow')}
              onClick={() => onChange(rows.filter((r) => r.key !== row.key))}
            >
              <IconClose />
            </button>
          </div>
        )
      })}
      <button
        type="button"
        className="link-btn ct-ed-add"
        onClick={() => onChange([...rows, { type: NEW_ROW_TYPE[kind], value: '', key: nextKey() }])}
      >
        <IconPlus /> {addLabel}
      </button>
    </fieldset>
  )
}
