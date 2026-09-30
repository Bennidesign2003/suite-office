import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactElement,
} from 'react'
import type { AddressSuggestion, PimApi } from '../../shared/pim'
import {
  currentToken,
  formatRecipient,
  replaceToken,
  splitRecipients,
} from '../contacts/address-tokens'
import { contactsTranslator } from '../contacts/i18n'
import '../contacts/contacts.css'

interface Props {
  value: string
  onChange(value: string): void
  lang: string
  placeholder?: string
  autoFocus?: boolean
  ariaLabel?: string
}

const DEBOUNCE_MS = 120
const LIMIT = 8
// long enough for a click on a suggestion to land before the list goes away
const BLUR_CLOSE_MS = 150

/** the browser build may run without the PIM bridge: then this is a plain input */
function pimApi(): PimApi | undefined {
  return typeof window === 'undefined' ? undefined : (window as { pimApi?: PimApi }).pimApi
}

function addressOf(recipient: string): string {
  const angled = /<([^<>]*)>\s*$/.exec(recipient)
  return (angled ? angled[1]! : recipient).trim().toLowerCase()
}

/**
 * A recipient line (To/Cc/Bcc, attendees) that completes names and addresses
 * from the address books and from people the user wrote to before.
 */
export function AddressInput({
  value,
  onChange,
  lang,
  placeholder,
  autoFocus,
  ariaLabel,
}: Props): ReactElement {
  const t = useMemo(() => contactsTranslator(lang), [lang])
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const [items, setItems] = useState<AddressSuggestion[]>([])
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  // every lookup takes a number; an answer to an older one is dropped
  const request = useRef(0)
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingCaret = useRef<{ value: string; caret: number } | null>(null)

  useEffect(
    () => () => {
      request.current++
      clearTimeout(debounce.current)
      clearTimeout(blurTimer.current)
    },
    [],
  )

  // after inserting a suggestion the caret goes behind it, once the parent
  // has rendered the new value
  useLayoutEffect(() => {
    const pending = pendingCaret.current
    const input = inputRef.current
    if (!pending || !input || pending.value !== value) return
    pendingCaret.current = null
    input.setSelectionRange(pending.caret, pending.caret)
  }, [value])

  useEffect(() => {
    if (!open) return
    const option = listRef.current?.children[active] as HTMLElement | undefined
    option?.scrollIntoView?.({ block: 'nearest' })
  }, [active, open])

  const close = (): void => {
    request.current++
    clearTimeout(debounce.current)
    setOpen(false)
    setItems([])
  }

  const lookup = (text: string, caret: number, delay = DEBOUNCE_MS): void => {
    clearTimeout(debounce.current)
    const api = pimApi()
    const token = currentToken(text, caret)
    // an opening quote of "Last, First" is not part of the name
    const query = token.text.replace(/^["'<]+/, '').trim()
    if (!api || !query) {
      close()
      return
    }
    const ticket = ++request.current
    debounce.current = setTimeout(() => {
      void Promise.resolve()
        .then(() => api.suggestAddresses(query, LIMIT))
        .then(
          (list) => {
            if (ticket !== request.current) return
            // people already on the line are not suggested a second time
            const others = text.slice(0, token.start) + text.slice(token.end)
            const taken = new Set(splitRecipients(others).map(addressOf))
            const fresh = (Array.isArray(list) ? list : []).filter(
              (s) =>
                s && typeof s.email === 'string' && s.email && !taken.has(s.email.toLowerCase()),
            )
            setItems(fresh)
            setActive(0)
            setOpen(fresh.length > 0)
          },
          () => {
            if (ticket === request.current) {
              setOpen(false)
              setItems([])
            }
          },
        )
    }, delay)
  }

  const insert = (suggestion: AddressSuggestion): void => {
    const caret = inputRef.current?.selectionStart ?? value.length
    const token = currentToken(value, caret)
    const next = replaceToken(
      value,
      token,
      formatRecipient(suggestion.name ?? '', suggestion.email),
    )
    close()
    pendingCaret.current = { value: next, caret: next.length - (value.length - token.end) }
    onChange(next)
    inputRef.current?.focus()
  }

  const visible = open && items.length > 0 && value.trim() !== ''

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.nativeEvent.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (visible) {
        e.preventDefault()
        const step = e.key === 'ArrowDown' ? 1 : -1
        setActive((i) => (i + step + items.length) % items.length)
      } else if (e.key === 'ArrowDown') {
        // ArrowDown asks for suggestions right away, like Outlook
        const caret = e.currentTarget.selectionStart ?? value.length
        if (currentToken(value, caret).text) {
          e.preventDefault()
          lookup(value, caret, 0)
        }
      }
      return
    }
    if (!visible) return
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
    if ((e.key === 'Enter' || e.key === 'Tab') && plain) {
      e.preventDefault()
      insert(items[active] ?? items[0]!)
    } else if (e.key === 'Escape') {
      // closes only the list, not the dialog or composer around it
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  return (
    <div className="addr-input">
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        aria-label={ariaLabel}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={visible}
        aria-controls={visible ? listId : undefined}
        aria-activedescendant={visible ? `${listId}-${active}` : undefined}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          const next = e.target.value
          onChange(next)
          lookup(next, e.target.selectionStart ?? next.length)
        }}
        onKeyDown={onKeyDown}
        onFocus={() => clearTimeout(blurTimer.current)}
        onBlur={() => {
          clearTimeout(blurTimer.current)
          blurTimer.current = setTimeout(close, BLUR_CLOSE_MS)
        }}
      />
      {visible && (
        <ul
          ref={listRef}
          id={listId}
          role="listbox"
          className="addr-suggest"
          aria-label={t('suggestions')}
          // keeps the focus (and the caret) in the input while clicking
          onMouseDown={(e) => e.preventDefault()}
        >
          {items.map((s, i) => (
            <li
              key={`${s.email}\n${i}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              className={`addr-option${i === active ? ' active' : ''}`}
              onMouseMove={() => i !== active && setActive(i)}
              onClick={(e) => {
                // inside the composer's <label>: no second click on the input
                e.preventDefault()
                insert(s)
              }}
            >
              <span className="addr-option-text">
                <span className="addr-option-name">{s.name || s.email}</span>
                {s.name && <span className="addr-option-email">{s.email}</span>}
              </span>
              <span className="addr-option-kind">
                {s.kind === 'contact' ? t('suggestContact') : t('suggestRecent')}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
