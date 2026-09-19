import type { ReactNode } from 'react'
import type { AiProviderId } from '@genoffice/ai-provider'

// ── AI provider brand logo (settings → AI model pane) ─────────────────────
// One provider, one mark. Ollama's llama silhouette is drawn in currentColor
// rather than a brand color: it is chrome here, not a brand asset, so it has
// to stay legible in both themes (see CLAUDE.md theming rules).

const ollamaLogo = (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    {/* ears */}
    <path d="M7.4 2.2c.9 0 1.5 1.1 1.7 2.5.1.7.1 1.4 0 2-.5.2-1 .5-1.4.8-.5-.5-.9-1.2-1.2-2-.5-1.4-.4-2.6.3-3.1a1 1 0 01.6-.2zm9.2 0a1 1 0 01.6.2c.7.5.8 1.7.3 3.1-.3.8-.7 1.5-1.2 2-.4-.3-.9-.6-1.4-.8a7 7 0 010-2c.2-1.4.8-2.5 1.7-2.5z" />
    {/* head */}
    <path d="M12 6.6c3.2 0 5.8 2.2 5.8 4.9 0 .7-.2 1.4-.5 2 .9.8 1.5 1.9 1.7 3.1.2 1-.1 2-.7 2.8.3.5.4 1 .4 1.6 0 .4-.3.8-.8.8H6.1a.8.8 0 01-.8-.8c0-.6.1-1.1.4-1.6a3.8 3.8 0 01-.7-2.8c.2-1.2.8-2.3 1.7-3.1a4.4 4.4 0 01-.5-2c0-2.7 2.6-4.9 5.8-4.9zm-2 4.1a1.1 1.1 0 100 2.2 1.1 1.1 0 000-2.2zm4 0a1.1 1.1 0 100 2.2 1.1 1.1 0 000-2.2zm-2 3.6c-.9 0-1.6.5-1.6 1.1s.7 1.1 1.6 1.1 1.6-.5 1.6-1.1-.7-1.1-1.6-1.1z" />
  </svg>
)

const LOGOS: Record<AiProviderId, ReactNode> = {
  ollama: ollamaLogo,
}

/** Inline brand mark sized by the surrounding .set-provider-logo container. */
export function ProviderLogo({ id }: { id: string }) {
  return (
    <span className="set-provider-logo" aria-hidden="true">
      {LOGOS[id as AiProviderId] ?? ollamaLogo}
    </span>
  )
}
