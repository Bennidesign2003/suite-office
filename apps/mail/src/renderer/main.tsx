import { createRoot } from 'react-dom/client'
import '@genoffice/ui/tokens.css'
import './styles.css'
import App from './App'
import type { UiTheme } from '../shared/ipc'

function applyTheme(theme: UiTheme): void {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme')
  else document.documentElement.setAttribute('data-theme', theme)
}

void (async () => {
  const [lang, theme] = await Promise.all([
    window.mailApi.getLanguage().catch(() => 'de'),
    window.mailApi.getTheme().catch(() => 'system' as const),
  ])
  document.documentElement.lang = lang.slice(0, 2)
  applyTheme(theme)
  window.mailApi.onThemeChanged(applyTheme)
  createRoot(document.getElementById('root')!).render(<App initialLang={lang} />)
})()
