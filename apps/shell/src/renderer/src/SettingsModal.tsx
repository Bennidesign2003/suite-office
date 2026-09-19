import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import {
  AI_CUSTOM_FONT_MAX_PX,
  AI_CUSTOM_FONT_MIN_PX,
  DEFAULT_AI_PANEL_PREFS,
  Dropdown,
  aiPanelFontPx,
  clampAiCustomFontSize,
} from '@genoffice/ui'
import type { AiFontSize, AiPanelPrefs, AiPanelSide } from '@genoffice/ui'
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  MAX_MAX_OUTPUT_TOKENS,
  MIN_MAX_OUTPUT_TOKENS,
  OLLAMA_DEFAULT_HOST,
  clampMaxOutputTokens,
} from '@genoffice/ai-provider/browser'
import type {
  AiSearchProviderMeta,
  AiSearchSettings,
  AiSettings,
  OllamaCatalog,
} from '@genoffice/ai-provider'
import { useI18n } from './locale'
import type { StringKey, TFunc } from './locale'
import type { UiTheme } from '../../shared/home-api'
import { ProviderLogo } from './provider-logos'
import { IntegrationsPane, skillUpdateDue } from './IntegrationsPane'
import './settings.css'

// ── Settings modal (opened from the account menu) ─────────
// Genspark-style two-pane dialog: section nav on the left, fields on the right.
// All values go through the existing home IPC; nothing is stored locally.

// sorted by ISO 639 language code — native-script labels have no natural
// shared alphabet, so the code is the ordering key
const LANG_OPTIONS = [
  { value: 'ar', label: 'العربية' },
  { value: 'cs', label: 'Čeština' },
  { value: 'de', label: 'Deutsch' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'fr', label: 'Français' },
  { value: 'he', label: 'עברית' },
  { value: 'hi', label: 'हिन्दी' },
  { value: 'id', label: 'Bahasa Indonesia' },
  { value: 'it', label: 'Italiano' },
  { value: 'ja', label: '日本語' },
  { value: 'ko', label: '한국어' },
  { value: 'ms', label: 'Bahasa Melayu' },
  { value: 'nl', label: 'Nederlands' },
  { value: 'pl', label: 'Polski' },
  { value: 'pt', label: 'Português' },
  { value: 'ru', label: 'Русский' },
  { value: 'th', label: 'ไทย' },
  { value: 'zh', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
] as const

// GenMail's option order: follow-system first, then the manual picks
const THEME_OPTIONS = [
  { value: 'system', labelKey: 'themeSystem' },
  { value: 'light', labelKey: 'themeLight' },
  { value: 'dark', labelKey: 'themeDark' },
] as const satisfies readonly { value: UiTheme; labelKey: StringKey }[]

const AI_FONT_SIZE_OPTIONS = [
  { value: 'default', labelKey: 'aiFontSizeDefault' },
  { value: 'large', labelKey: 'aiFontSizeLarge' },
  { value: 'xlarge', labelKey: 'aiFontSizeXLarge' },
  { value: 'custom', labelKey: 'aiFontSizeCustom' },
] as const satisfies readonly { value: AiFontSize; labelKey: StringKey }[]

const CHANNEL_OPTIONS = [
  { value: 'stable', labelKey: 'channelStable' },
  { value: 'beta', labelKey: 'channelBeta' },
] as const satisfies readonly { value: 'stable' | 'beta'; labelKey: StringKey }[]

/** GitHub-style abbreviated stargazer count (2591 → "2.6k") — the number is
 * social proof, not a metric; the cached/exact value would only look stale */
function formatStars(n: number): string {
  if (n < 1000) return String(n)
  const k = n / 1000
  return `${k >= 100 ? Math.round(k) : (Math.round(k * 10) / 10).toString().replace(/\.0$/, '')}k`
}

/** px stepper for the custom AI panel text size; in-range values apply live,
 * out-of-range or partial input is clamped on blur */
function CustomFontSizeInput({
  value,
  label,
  onCommit,
}: {
  value: number
  label: string
  onCommit: (px: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  const [editing, setEditing] = useState(false)
  const shown = editing ? draft : String(value)
  const commit = (raw: string) => {
    const px = clampAiCustomFontSize(raw)
    if (px !== null && px !== value) onCommit(px)
  }
  return (
    <label className="set-num">
      <input
        type="number"
        className="set-input set-num-input"
        aria-label={label}
        min={AI_CUSTOM_FONT_MIN_PX}
        max={AI_CUSTOM_FONT_MAX_PX}
        step={1}
        value={shown}
        onFocus={() => {
          setDraft(String(value))
          setEditing(true)
        }}
        onChange={(e) => {
          setDraft(e.target.value)
          const n = Number(e.target.value)
          if (Number.isInteger(n) && n >= AI_CUSTOM_FONT_MIN_PX && n <= AI_CUSTOM_FONT_MAX_PX) {
            onCommit(n)
          }
        }}
        onBlur={() => {
          commit(draft)
          setEditing(false)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
        }}
      />
      <span className="set-num-unit">px</span>
    </label>
  )
}

type SectionId = 'aiModel' | 'aiMedia' | 'general' | 'integrations' | 'about'

const SECTIONS: readonly { id: SectionId; labelKey: StringKey }[] = [
  { id: 'aiModel', labelKey: 'setSecAiModel' },
  { id: 'aiMedia', labelKey: 'setSecAiMedia' },
  { id: 'general', labelKey: 'setSecGeneral' },
  { id: 'integrations', labelKey: 'setSecIntegrations' },
  { id: 'about', labelKey: 'setSecAbout' },
]

function SectionIcon({ id }: { id: SectionId }) {
  if (id === 'aiModel') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M8 1.8 9.5 6l4.2 1.5L9.5 9 8 13.2 6.5 9 2.3 7.5 6.5 6 8 1.8Z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
        <path
          d="M12.8 11.2v3M11.3 12.7h3"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    )
  }
  if (id === 'aiMedia') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
        <path
          d="M2.5 11.5 6 8l2.5 2.5L10.5 9l3 2.8"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        <circle cx="10.5" cy="6" r="1.1" fill="currentColor" />
      </svg>
    )
  }
  if (id === 'integrations') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M5.5 2v3M10.5 2v3M4 5h8v2.5a4 4 0 0 1-8 0V5ZM8 11.5V14"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
  if (id === 'general') {
    return (
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path
          d="M2 5h8M13 5h1M2 11h1M6 11h8"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
        <circle cx="11.5" cy="5" r="1.7" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="4.5" cy="11" r="1.7" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    )
  }
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6.3" stroke="currentColor" strokeWidth="1.3" />
      <path d="M8 7.4v3.4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      <circle cx="8" cy="5.1" r="0.8" fill="currentColor" />
    </svg>
  )
}

/** label-over-value field row with an optional right-aligned action */
function Field({
  label,
  value,
  valueTitle,
  action,
}: {
  label: string
  value: string
  valueTitle?: string
  action?: ReactNode
}) {
  return (
    <div className="set-field">
      <div className="set-field-text">
        <div className="set-field-label">{label}</div>
        <div className="set-field-value" data-tip={valueTitle}>
          {value}
        </div>
      </div>
      {action}
    </div>
  )
}

/**
 * AI model pane. There is one provider — a local Ollama daemon — so the pane
 * is about the daemon, not about choosing a vendor: where it listens, whether
 * it answers, and which of the models it actually serves to use.
 *
 * The model list is never hardcoded. It comes from the daemon each time the
 * pane opens (and on Refresh), because what is installed is a property of this
 * machine and changes whenever the user runs `ollama pull`.
 */
function AiModelPane({ t }: { t: TFunc }) {
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [catalog, setCatalog] = useState<OllamaCatalog | null>(null)
  const [probing, setProbing] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  /** free-typed value of the output-cap field; committed (and clamped) on blur */
  const [maxTokensDraft, setMaxTokensDraft] = useState<string | null>(null)

  const probe = useCallback(async () => {
    setProbing(true)
    try {
      setCatalog((await window.aiOffice.ollamaStatus?.()) ?? null)
    } finally {
      setProbing(false)
    }
  }, [])

  useEffect(() => {
    let alive = true
    void window.aiOffice.getAiSettings?.().then((s) => {
      if (alive && s) setSettings(s)
    })
    void probe()
    return () => {
      alive = false
    }
  }, [probe])

  if (!settings) return null
  const config = settings.providers.ollama
  const installed = catalog?.models ?? []
  const selected = installed.find((m) => m.name === config.model)

  const touch = () => {
    setDirty(true)
    setSaved(false)
    setTestResult(null)
  }
  const updateConfig = (patch: Partial<typeof config>) => {
    setSettings({ ...settings, providers: { ollama: { ...config, ...patch } } })
    touch()
  }
  /** Commit the output-cap input: clamp what was typed and drop a no-op edit */
  const commitMaxTokens = () => {
    if (maxTokensDraft === null) return
    setMaxTokensDraft(null)
    const next = clampMaxOutputTokens(Number.parseInt(maxTokensDraft, 10))
    if (next === (settings.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS)) return
    setSettings({ ...settings, maxOutputTokens: next })
    touch()
  }
  const save = () => {
    window.aiOffice
      .setAiSettings?.(settings)
      .then(() => {
        setDirty(false)
        setSaved(true)
      })
      .catch((error) => {
        window.alert(error instanceof Error ? error.message : String(error))
      })
  }
  const test = () => {
    setTesting(true)
    setTestResult(null)
    window.aiOffice
      .testAiSettings?.(settings)
      .then((r) => setTestResult(r ?? { ok: false }))
      .catch((error) =>
        setTestResult({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      )
      .finally(() => setTesting(false))
  }

  /** "9.7B · Q4_K_M · vision, tools" — what the daemon reports, so the pick is informed */
  const modelDetail = (name: string): string => {
    const m = installed.find((entry) => entry.name === name)
    if (!m) return name
    const parts = [m.parameterSize, m.quantization].filter(Boolean)
    const caps = [m.vision && 'vision', m.tools && 'tools', m.thinking && 'thinking'].filter(
      Boolean,
    ) as string[]
    if (caps.length) parts.push(caps.join(', '))
    return parts.length ? `${name} — ${parts.join(' · ')}` : name
  }

  return (
    <>
      <h3 className="set-pane-title">{t('setSecAiModel')}</h3>
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <div className="set-field-label">{t('setAiDaemon')}</div>
            <div className="set-field-desc">
              {catalog?.reachable
                ? t('setAiDaemonUp', {
                    version: catalog.version ?? '',
                    n: String(catalog.models.length),
                  })
                : (catalog?.error ?? t('setAiDaemonDown'))}
            </div>
          </div>
        </div>
        <button className="set-btn" disabled={probing} onClick={() => void probe()}>
          {t('setAiRefreshModels')}
        </button>
      </div>
      <div className="set-field-desc set-ai-note">{t('setAiLocalHint')}</div>
      <div className="set-field">
        <div className="set-field-text">
          <label className="set-field-label">{t('setAiModelId')}</label>
        </div>
        {installed.length > 0 ? (
          <Dropdown
            className="set-dd"
            value={config.model}
            ariaLabel={t('setAiModelId')}
            options={installed.map((m) => ({ value: m.name, label: modelDetail(m.name) }))}
            onPick={(m) => updateConfig({ model: m })}
          />
        ) : (
          // a stopped daemon must not erase a model the user already picked
          <input
            id="set-ai-model"
            className="set-input"
            type="text"
            value={config.model}
            placeholder="llama3.2"
            spellCheck={false}
            onChange={(e) => updateConfig({ model: e.target.value })}
          />
        )}
      </div>
      {catalog?.reachable && installed.length === 0 && (
        <div className="set-field-desc set-ai-note">{t('setAiNoModels')}</div>
      )}
      {selected && !selected.tools && (
        // the agent loop is built on tool calls; a chat-only model silently
        // turns every "edit this document" request into prose
        <div className="set-field-desc set-ai-note">{t('setAiModelNoTools')}</div>
      )}
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <label className="set-field-label" htmlFor="set-ai-base-url">
              {t('setAiBaseUrl')}
            </label>
            <div className="set-field-desc">{t('setAiBaseUrlHint')}</div>
          </div>
        </div>
        <input
          id="set-ai-base-url"
          className="set-input"
          type="text"
          value={config.baseUrl ?? ''}
          placeholder={OLLAMA_DEFAULT_HOST}
          spellCheck={false}
          onChange={(e) => updateConfig({ baseUrl: e.target.value.trim() })}
          onBlur={() => void probe()}
        />
      </div>
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <label className="set-field-label" htmlFor="set-ai-key">
              {t('setAiApiKey')}
            </label>
            <div className="set-field-desc">{t('setAiKeyHint')}</div>
          </div>
        </div>
        <input
          id="set-ai-key"
          className="set-input"
          type="password"
          value={config.apiKey}
          placeholder={t('setAiKeyOptional')}
          spellCheck={false}
          autoComplete="off"
          onChange={(e) => updateConfig({ apiKey: e.target.value.trim() })}
        />
      </div>
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <label className="set-field-label" htmlFor="set-ai-max-tokens">
              {t('setAiMaxTokens')}
            </label>
            <div className="set-field-desc">{t('setAiMaxTokensDesc')}</div>
          </div>
        </div>
        <input
          id="set-ai-max-tokens"
          className="set-input"
          type="number"
          min={MIN_MAX_OUTPUT_TOKENS}
          max={MAX_MAX_OUTPUT_TOKENS}
          step={1024}
          value={maxTokensDraft ?? String(settings.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS)}
          onChange={(e) => setMaxTokensDraft(e.target.value)}
          onBlur={commitMaxTokens}
        />
      </div>
      <div className="set-pane-footer">
        <AiStatusPill
          status={
            testing
              ? { kind: 'testing', text: t('setAiTesting') }
              : testResult
                ? testResult.ok
                  ? { kind: 'ok', text: t('setAiTestOk') }
                  : { kind: 'err', text: testResult.error || t('setAiTestFail') }
                : saved
                  ? { kind: 'ok', text: t('setAiSaved') }
                  : null
          }
        />
        <button className="set-btn" disabled={testing} onClick={test}>
          {t('setAiTest')}
        </button>
        <button className="set-btn primary" disabled={!dirty} onClick={save}>
          {t('setAiSave')}
        </button>
      </div>
    </>
  )
}

/**
 * Media & search pane. Two things are left to configure here:
 *
 *  - the vision model `analyze_media` reads images with. It runs on the same
 *    local daemon as chat, so there is no provider to pick — only which of the
 *    installed models to use, and leaving it empty reuses the chat model.
 *  - the web-search backend, which is the one part of Suite that can leave the
 *    machine. The keyless chain is the default; Serper and Tavily are opt-in.
 *
 * Image generation has no block because Ollama has no image-output endpoint,
 * and video analysis has none because local vision models read stills.
 */
function AiMediaPane({ t }: { t: TFunc }) {
  const [searchCatalog] = useState<AiSearchProviderMeta[]>(
    () => window.aiOffice.getAiSearchProviders?.() ?? [],
  )
  const [settings, setSettings] = useState<AiSettings | null>(null)
  const [catalog, setCatalog] = useState<OllamaCatalog | null>(null)
  const [dirty, setDirty] = useState(false)
  const [saved, setSaved] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)

  useEffect(() => {
    let alive = true
    void window.aiOffice.getAiSettings?.().then((s) => {
      if (alive && s) setSettings(s)
    })
    void window.aiOffice.ollamaStatus?.().then((c) => {
      if (alive) setCatalog(c)
    })
    return () => {
      alive = false
    }
  }, [])

  if (!settings?.media || !settings.search) return null
  const media = settings.media
  const search = settings.search
  const mediaConfig = media.providers.ollama
  // only a vision model can answer about an image; offering the rest invites a
  // confusing "this model cannot see" failure at tool time
  const visionModels = (catalog?.models ?? []).filter((m) => m.vision)

  const touch = () => {
    setDirty(true)
    setSaved(false)
    setTestResult(null)
  }
  const setAnalysisModel = (model: string) => {
    setSettings({
      ...settings,
      media: { ...media, providers: { ollama: { ...mediaConfig, analysisModel: model } } },
    })
    touch()
  }
  const setSearchProvider = (provider: AiSearchSettings['provider']) => {
    setSettings({ ...settings, search: { ...search, provider } })
    touch()
  }
  const setSearchKey = (apiKey: string) => {
    if (search.provider === 'free') return
    setSettings({
      ...settings,
      search: {
        ...search,
        providers: { ...search.providers, [search.provider]: { apiKey } },
      },
    })
    touch()
  }
  const save = () => {
    window.aiOffice
      .setAiSettings?.(settings)
      .then(() => {
        setDirty(false)
        setSaved(true)
      })
      .catch((error) => window.alert(error instanceof Error ? error.message : String(error)))
  }
  const test = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await window.aiOffice.testAiSearchSettings?.({
        provider: search.provider,
        apiKey: search.provider === 'free' ? '' : search.providers[search.provider].apiKey,
      })
      setTestResult(r ?? { ok: false })
    } catch (error) {
      setTestResult({ ok: false, error: error instanceof Error ? error.message : String(error) })
    } finally {
      setTesting(false)
    }
  }

  const searchMeta = searchCatalog.find((m) => m.id === search.provider)

  return (
    <>
      <h3 className="set-pane-title">{t('setSecAiMedia')}</h3>
      <div className="set-field">
        <div className="set-field-text">
          <div className="set-field-stack">
            <label className="set-field-label">{t('setAiAnalysisModel')}</label>
            <div className="set-field-desc">{t('setAiAnalysisModelHint')}</div>
          </div>
        </div>
        {visionModels.length > 0 ? (
          <Dropdown
            className="set-dd"
            value={mediaConfig.analysisModel}
            ariaLabel={t('setAiAnalysisModel')}
            options={[
              { value: '', label: t('setAiAnalysisSameAsChat') },
              ...visionModels.map((m) => ({ value: m.name, label: m.name })),
            ]}
            onPick={setAnalysisModel}
          />
        ) : (
          <input
            className="set-input"
            type="text"
            value={mediaConfig.analysisModel}
            placeholder={t('setAiAnalysisSameAsChat')}
            spellCheck={false}
            onChange={(e) => setAnalysisModel(e.target.value.trim())}
          />
        )}
      </div>
      <div className="set-field">
        <div className="set-field-text">
          <label className="set-field-label">{t('setAiCapSearch')}</label>
        </div>
        <Dropdown
          className="set-dd"
          value={search.provider}
          ariaLabel={t('setAiCapSearch')}
          options={searchCatalog.map((m) => ({ value: m.id, label: m.label }))}
          onPick={(v) => setSearchProvider(v as AiSearchSettings['provider'])}
        />
      </div>
      {search.provider !== 'free' && (
        <div className="set-field">
          <div className="set-field-text">
            <div className="set-field-stack">
              <label className="set-field-label" htmlFor="set-search-key">
                {t('setAiApiKey')}
              </label>
              <div className="set-field-desc">{t('setAiKeyHint')}</div>
            </div>
          </div>
          <input
            id="set-search-key"
            className="set-input"
            type="password"
            value={search.providers[search.provider].apiKey}
            placeholder={searchMeta?.keyPlaceholder ?? 'API Key'}
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setSearchKey(e.target.value.trim())}
          />
        </div>
      )}
      <div className="set-pane-footer">
        <AiStatusPill
          status={
            testing
              ? { kind: 'testing', text: t('setAiTesting') }
              : testResult
                ? testResult.ok
                  ? { kind: 'ok', text: t('setAiTestOk') }
                  : { kind: 'err', text: testResult.error || t('setAiTestFail') }
                : saved
                  ? { kind: 'ok', text: t('setAiSaved') }
                  : null
          }
        />
        <button className="set-btn" disabled={testing} onClick={() => void test()}>
          {t('setAiTest')}
        </button>
        <button className="set-btn primary" disabled={!dirty} onClick={save}>
          {t('setAiSave')}
        </button>
      </div>
    </>
  )
}

interface AiStatus {
  kind: 'testing' | 'ok' | 'err'
  text: string
}

/** colored feedback pill in the AI pane footer: spinner while testing, then success/error */
function AiStatusPill({ status }: { status: AiStatus | null }) {
  if (!status) return null
  return (
    <span
      className={`set-ai-status ${status.kind}`}
      role="status"
      // error text (HTTP body, network message) can be long — full text via native tooltip
      title={status.kind === 'err' ? status.text : undefined}
    >
      {status.kind === 'testing' ? (
        <span className="set-ai-spin" aria-hidden="true" />
      ) : status.kind === 'ok' ? (
        <svg
          className="set-ai-status-icon"
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="6.3" fill="currentColor" opacity="0.16" />
          <path
            d="M4.2 7.3l1.9 1.9 3.7-4.3"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      ) : (
        <svg
          className="set-ai-status-icon"
          width="14"
          height="14"
          viewBox="0 0 14 14"
          aria-hidden="true"
        >
          <circle cx="7" cy="7" r="6.3" fill="currentColor" opacity="0.16" />
          <path d="M7 3.8v3.9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="7" cy="10.1" r="1" fill="currentColor" />
        </svg>
      )}
      <span className="set-ai-status-text">{status.text}</span>
    </span>
  )
}

export interface SettingsModalProps {
  onClose: () => void
  /** an installed skill is older than the bundled one: dot on the Integrations entry */
  skillUpdateDue?: boolean
  onSkillUpdateDue?: (due: boolean) => void
}

export function SettingsModal({
  onClose,
  skillUpdateDue: updateDue = false,
  onSkillUpdateDue,
}: SettingsModalProps) {
  const { lang, setLang, t } = useI18n()
  const [section, setSection] = useState<SectionId>('aiModel')
  const [theme, setTheme] = useState<UiTheme>('system')
  const [saveDir, setSaveDir] = useState('')
  const [analyticsOn, setAnalyticsOn] = useState(true)
  const [analyticsSaving, setAnalyticsSaving] = useState(false)
  const [autoSaveOn, setAutoSaveOn] = useState(false)
  const [aiPrefs, setAiPrefs] = useState<AiPanelPrefs>(DEFAULT_AI_PANEL_PREFS)
  const [channel, setChannel] = useState<'stable' | 'beta'>('stable')
  const [appVersion, setAppVersion] = useState('')
  const [githubStars, setGithubStars] = useState<number | null>(null)

  useEffect(() => {
    let alive = true
    void window.aiOffice.getTheme?.().then((th) => {
      if (alive) setTheme(th)
    })
    void window.aiOffice.getDefaultSaveDir?.().then((dir) => {
      if (alive && dir) setSaveDir(dir)
    })
    void window.aiOffice.getAnalyticsEnabled?.().then((on) => {
      if (alive) setAnalyticsOn(on !== false)
    })
    void window.aiOffice.getAutoSaveDefault?.().then((v) => {
      if (alive) setAutoSaveOn(v.on)
    })
    void window.aiOffice.getAiPanelPrefs?.().then((prefs) => {
      if (alive) setAiPrefs(prefs)
    })
    void window.aiOffice.getUpdateChannel?.().then((ch) => {
      if (alive) setChannel(ch)
    })
    void window.aiOffice.getAppVersion?.().then((v) => {
      if (alive && v) setAppVersion(v)
    })
    void window.aiOffice.githubStars?.().then((n) => {
      if (alive && n !== null) setGithubStars(n)
    })
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [onClose])

  const applyTheme = (next: UiTheme) => {
    setTheme(next)
    void window.aiOffice.setTheme(next)
    if (next === 'system') document.documentElement.removeAttribute('data-theme')
    else document.documentElement.setAttribute('data-theme', next)
  }

  const updateAiPrefs = (patch: Partial<AiPanelPrefs>) => {
    setAiPrefs((prev) => ({ ...prev, ...patch }))
    void window.aiOffice.setAiPanelPrefs(patch).then(setAiPrefs)
  }

  const changeSaveDir = () => {
    void window.aiOffice.pickDefaultSaveDir?.().then((dir) => {
      if (dir) setSaveDir(dir)
    })
  }

  return (
    <div
      className="set-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="set-dialog" role="dialog" aria-modal="true" aria-label={t('settings')}>
        <div className="set-header">
          <h2 className="set-title">{t('settings')}</h2>
          <button className="set-close" onClick={onClose} aria-label={t('cancel')}>
            <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
              <path
                d="M2 2l10 10M12 2L2 12"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
        <div className="set-body">
          <nav className="set-nav" aria-label={t('settings')}>
            {SECTIONS.map((s) => (
              <button
                key={s.id}
                className={`set-nav-item${section === s.id ? ' active' : ''}`}
                aria-current={section === s.id}
                onClick={() => setSection(s.id)}
              >
                <SectionIcon id={s.id} />
                {t(s.labelKey)}
                {s.id === 'integrations' && updateDue && (
                  <span className="set-nav-dot" role="img" aria-label={t('intgUpdateDue')} />
                )}
              </button>
            ))}
          </nav>
          <div className="set-pane">
            {section === 'aiModel' && <AiModelPane t={t} />}
            {section === 'aiMedia' && <AiMediaPane t={t} />}
            {section === 'general' && (
              <>
                <h3 className="set-pane-title">{t('setSecGeneral')}</h3>
                <div className="set-field">
                  <div className="set-field-text">
                    <label className="set-field-label">{t('language')}</label>
                  </div>
                  <Dropdown
                    className="set-dd"
                    value={lang}
                    ariaLabel={t('language')}
                    options={LANG_OPTIONS.map((opt) => ({ value: opt.value, label: opt.label }))}
                    onPick={(v) => setLang(v as typeof lang)}
                  />
                </div>
                <div className="set-field">
                  <div className="set-field-text">
                    <label className="set-field-label">{t('theme')}</label>
                  </div>
                  <Dropdown
                    className="set-dd"
                    value={theme}
                    ariaLabel={t('theme')}
                    options={THEME_OPTIONS.map((opt) => ({
                      value: opt.value,
                      label: t(opt.labelKey),
                    }))}
                    onPick={(v) => applyTheme(v as UiTheme)}
                  />
                </div>
                <div className="set-field">
                  <div className="set-field-text">
                    <label className="set-field-label">{t('setAiPanelSide')}</label>
                  </div>
                  <Dropdown
                    className="set-dd"
                    value={aiPrefs.side}
                    ariaLabel={t('setAiPanelSide')}
                    options={[
                      { value: 'left', label: t('aiPanelSideLeft') },
                      { value: 'right', label: t('aiPanelSideRight') },
                    ]}
                    onPick={(side) => updateAiPrefs({ side: side as AiPanelSide })}
                  />
                </div>
                <div className="set-field">
                  <div className="set-field-text">
                    <label className="set-field-label">{t('setAiFontSize')}</label>
                  </div>
                  {aiPrefs.fontSize === 'custom' && (
                    <CustomFontSizeInput
                      value={aiPrefs.customFontSize}
                      label={t('aiFontSizeCustom')}
                      onCommit={(px) => updateAiPrefs({ customFontSize: px })}
                    />
                  )}
                  <Dropdown
                    className="set-dd"
                    value={aiPrefs.fontSize}
                    ariaLabel={t('setAiFontSize')}
                    options={AI_FONT_SIZE_OPTIONS.map((opt) => ({
                      value: opt.value,
                      label: t(opt.labelKey),
                    }))}
                    onPick={(v) => {
                      const fontSize = v as AiFontSize
                      // start the custom size from the preset being left so nothing jumps
                      updateAiPrefs(
                        fontSize === 'custom' && aiPrefs.fontSize !== 'custom'
                          ? { fontSize, customFontSize: aiPanelFontPx(aiPrefs) }
                          : { fontSize },
                      )
                    }}
                  />
                </div>
                <div className="set-field">
                  <div className="set-field-text">
                    <div className="set-field-stack">
                      <div className="set-field-label">{t('setAiSpellcheck')}</div>
                      <div className="set-field-desc">{t('setAiSpellcheckDesc')}</div>
                    </div>
                  </div>
                  <button
                    className="set-switch"
                    role="switch"
                    aria-checked={aiPrefs.spellcheck}
                    aria-label={t('setAiSpellcheck')}
                    onClick={() => updateAiPrefs({ spellcheck: !aiPrefs.spellcheck })}
                  />
                </div>
                <Field
                  label={t('saveLocation')}
                  value={saveDir || '—'}
                  valueTitle={saveDir}
                  action={
                    <button className="set-btn" onClick={changeSaveDir}>
                      {t('setChange')}
                    </button>
                  }
                />
                <div className="set-field">
                  <div className="set-field-text">
                    <div className="set-field-stack">
                      <div className="set-field-label">{t('setAutoSave')}</div>
                      <div className="set-field-desc">{t('setAutoSaveDesc')}</div>
                    </div>
                  </div>
                  <button
                    className="set-switch"
                    role="switch"
                    aria-checked={autoSaveOn}
                    aria-label={t('setAutoSave')}
                    onClick={() => {
                      const next = !autoSaveOn
                      setAutoSaveOn(next)
                      void window.aiOffice.setAutoSaveDefault?.(next).catch(() => {})
                    }}
                  />
                </div>
                <div className="set-field">
                  <div className="set-field-text">
                    <div className="set-field-stack">
                      <div className="set-field-label">{t('setAnalytics')}</div>
                      <div className="set-field-desc">{t('setAnalyticsDesc')}</div>
                    </div>
                  </div>
                  <button
                    className="set-switch"
                    role="switch"
                    aria-checked={analyticsOn}
                    aria-label={t('setAnalytics')}
                    disabled={analyticsSaving}
                    onClick={() => {
                      const next = !analyticsOn
                      setAnalyticsSaving(true)
                      void window.aiOffice
                        .setAnalyticsEnabled(next)
                        .then((persisted) => {
                          if (persisted) setAnalyticsOn(next)
                        })
                        .catch(() => {})
                        .finally(() => setAnalyticsSaving(false))
                    }}
                  />
                </div>
              </>
            )}
            {section === 'integrations' && (
              <IntegrationsPane t={t} onStatus={(st) => onSkillUpdateDue?.(skillUpdateDue(st))} />
            )}
            {section === 'about' && (
              <>
                <h3 className="set-pane-title">{t('setSecAbout')}</h3>
                <Field label={t('versionLabel')} value={appVersion || '—'} />
                <div className="set-field">
                  <div className="set-field-text">
                    <label className="set-field-label">{t('updateChannel')}</label>
                  </div>
                  <Dropdown
                    className="set-dd"
                    value={channel}
                    ariaLabel={t('updateChannel')}
                    options={CHANNEL_OPTIONS.map((opt) => ({
                      value: opt.value,
                      label: t(opt.labelKey),
                    }))}
                    onPick={(v) => {
                      const next = v === 'beta' ? 'beta' : 'stable'
                      setChannel(next)
                      void window.aiOffice.setUpdateChannel(next)
                    }}
                  />
                </div>
                <Field
                  label={t('setGithub')}
                  value={
                    githubStars === null
                      ? 'github.com/genspark-ai/genoffice'
                      : `github.com/genspark-ai/genoffice · ★ ${formatStars(githubStars)}`
                  }
                  action={
                    <button
                      className="set-btn"
                      onClick={() => void window.aiOffice.openGitHubRepo?.()}
                    >
                      {t('starOnGitHub')}
                    </button>
                  }
                />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
