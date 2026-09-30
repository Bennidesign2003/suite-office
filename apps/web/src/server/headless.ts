import { existsSync, readdirSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core'

/**
 * Hidden BrowserWindows (PDF export, print layout, html → docx measuring,
 * slide rasterizing …) need a real rendering engine on the server side: the
 * user's browser cannot hand back a PDF or pixels of a page it never shows.
 * They run in a headless Chromium driven over CDP, launched on first use.
 */

let browserPromise: Promise<Browser> | null = null

function candidatePaths(): string[] {
  const out: string[] = []
  if (process.env.SUITE_CHROMIUM) out.push(process.env.SUITE_CHROMIUM)
  const pwRoot = process.env.PLAYWRIGHT_BROWSERS_PATH
  if (pwRoot && existsSync(pwRoot)) {
    out.push(join(pwRoot, 'chromium'))
    for (const entry of safeReaddir(pwRoot)) {
      if (!entry.startsWith('chromium')) continue
      out.push(
        join(pwRoot, entry, 'chrome-linux', 'chrome'),
        join(pwRoot, entry, 'chrome-linux64', 'chrome'),
        join(pwRoot, entry, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
        join(pwRoot, entry, 'chrome-win', 'chrome.exe'),
      )
    }
  }
  if (process.platform === 'darwin') {
    out.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    )
  } else if (process.platform === 'win32') {
    for (const base of [
      process.env['PROGRAMFILES'],
      process.env['PROGRAMFILES(X86)'],
      process.env.LOCALAPPDATA,
    ]) {
      if (!base) continue
      out.push(
        join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(base, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      )
    }
  } else {
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      for (const name of [
        'google-chrome',
        'google-chrome-stable',
        'chromium',
        'chromium-browser',
      ]) {
        out.push(join(dir, name))
      }
    }
  }
  return out
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

async function launch(): Promise<Browser> {
  const { chromium } = await import('playwright-core')
  const paths = candidatePaths()
  try {
    const bundled = chromium.executablePath()
    if (bundled) paths.splice(1, 0, bundled)
  } catch {
    // playwright-core without a downloaded browser
  }
  const executablePath = paths.find((p) => p && existsSync(p))
  if (!executablePath) {
    throw new Error(
      'Für PDF-Export und Druck braucht der Web-Modus einen Chromium-basierten Browser ' +
        '(Chrome, Chromium oder Edge). Pfad über SUITE_CHROMIUM angeben.',
    )
  }
  return chromium.launch({
    executablePath,
    headless: true,
    args: [
      '--allow-file-access-from-files',
      '--disable-gpu',
      '--no-sandbox',
      '--font-render-hinting=none',
    ],
  })
}

export function headlessBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = launch().catch((err) => {
      browserPromise = null
      throw err
    })
  }
  return browserPromise
}

export async function closeHeadless(): Promise<void> {
  const pending = browserPromise
  browserPromise = null
  if (pending) await pending.then((b) => b.close()).catch(() => undefined)
}

export interface HeadlessOptions {
  width: number
  height: number
  javascript: boolean
  onLoad: () => void
  onDomReady: () => void
  onFail: (error: string) => void
}

/** Electron's PrintToPDFOptions, reduced to what the editors pass */
export interface ElectronPdfOptions {
  landscape?: boolean
  displayHeaderFooter?: boolean
  printBackground?: boolean
  scale?: number
  pageSize?: string | { width: number; height: number }
  margins?: {
    top?: number
    bottom?: number
    left?: number
    right?: number
    marginType?: 'default' | 'none' | 'printableArea' | 'custom'
  }
  pageRanges?: string
  headerTemplate?: string
  footerTemplate?: string
  preferCSSPageSize?: boolean
  generateTaggedPDF?: boolean
  generateDocumentOutline?: boolean
}

/** inches, as Chromium's printToPDF takes them */
const PAPER: Record<string, [number, number]> = {
  a0: [33.1, 46.8],
  a1: [23.4, 33.1],
  a2: [16.54, 23.4],
  a3: [11.7, 16.54],
  a4: [8.27, 11.7],
  a5: [5.83, 8.27],
  a6: [4.13, 5.83],
  letter: [8.5, 11],
  legal: [8.5, 14],
  tabloid: [11, 17],
  ledger: [17, 11],
}

export function cdpPdfParams(options: ElectronPdfOptions = {}): Record<string, unknown> {
  const params: Record<string, unknown> = {
    landscape: !!options.landscape,
    displayHeaderFooter: !!options.displayHeaderFooter,
    printBackground: !!options.printBackground,
    scale: options.scale ?? 1,
    preferCSSPageSize: !!options.preferCSSPageSize,
    transferMode: 'ReturnAsBase64',
  }
  const size = options.pageSize ?? 'Letter'
  if (typeof size === 'string') {
    const paper = PAPER[size.toLowerCase()] ?? PAPER.letter!
    params.paperWidth = paper[0]
    params.paperHeight = paper[1]
  } else {
    params.paperWidth = size.width
    params.paperHeight = size.height
  }
  const m = options.margins
  if (m?.marginType === 'none') {
    Object.assign(params, { marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0 })
  } else if (m && m.marginType !== 'default' && m.marginType !== 'printableArea') {
    params.marginTop = m.top ?? 0.4
    params.marginBottom = m.bottom ?? 0.4
    params.marginLeft = m.left ?? 0.4
    params.marginRight = m.right ?? 0.4
  } else {
    Object.assign(params, { marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4 })
  }
  if (options.pageRanges) params.pageRanges = options.pageRanges
  if (options.headerTemplate !== undefined) params.headerTemplate = options.headerTemplate
  if (options.footerTemplate !== undefined) params.footerTemplate = options.footerTemplate
  if (options.generateTaggedPDF !== undefined) params.generateTaggedPDF = options.generateTaggedPDF
  if (options.generateDocumentOutline !== undefined) {
    params.generateDocumentOutline = options.generateDocumentOutline
  }
  return params
}

export class HeadlessPage {
  private constructor(
    private readonly context: BrowserContext,
    readonly page: Page,
    private readonly cdp: CDPSession,
  ) {}

  static async open(options: HeadlessOptions): Promise<HeadlessPage> {
    const browser = await headlessBrowser()
    const context = await browser.newContext({
      viewport: {
        width: Math.max(1, Math.round(options.width)),
        height: Math.max(1, Math.round(options.height)),
      },
      javaScriptEnabled: options.javascript,
      ignoreHTTPSErrors: true,
    })
    const page = await context.newPage()
    const cdp = await context.newCDPSession(page)
    page.on('load', options.onLoad)
    page.on('domcontentloaded', options.onDomReady)
    page.on('pageerror', (err) => {
      if (process.env.SUITE_WEB_DEBUG) console.warn('[web][headless] page error:', err.message)
    })
    return new HeadlessPage(context, page, cdp)
  }

  async goto(url: string): Promise<void> {
    await this.page.goto(url, { waitUntil: 'load', timeout: 120_000 })
  }

  async setSize(width: number, height: number): Promise<void> {
    await this.page.setViewportSize({
      width: Math.max(1, Math.round(width)),
      height: Math.max(1, Math.round(height)),
    })
  }

  async evaluate(code: string): Promise<unknown> {
    const result = (await this.cdp.send('Runtime.evaluate', {
      expression: code,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true,
    })) as {
      result: { value?: unknown }
      exceptionDetails?: { text: string; exception?: { description?: string } }
    }
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
      )
    }
    return result.result.value
  }

  async pdf(options: ElectronPdfOptions): Promise<Buffer> {
    const { data } = (await this.cdp.send('Page.printToPDF', cdpPdfParams(options))) as {
      data: string
    }
    return Buffer.from(data, 'base64')
  }

  async capture(rect?: { x: number; y: number; width: number; height: number }): Promise<Buffer> {
    const { data } = (await this.cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
      ...(rect ? { clip: { ...rect, scale: 1 } } : {}),
    })) as { data: string }
    return Buffer.from(data, 'base64')
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined)
  }
}

/** Print a DOM snapshot taken in the user's browser (see client/snapshot.ts). */
export async function pdfFromSnapshot(
  html: string,
  size: { width: number; height: number },
  options: ElectronPdfOptions,
): Promise<Buffer> {
  const page = await HeadlessPage.open({
    width: size.width,
    height: size.height,
    // the snapshot has no scripts left; setContent itself needs a script context
    javascript: true,
    onLoad: () => undefined,
    onDomReady: () => undefined,
    onFail: () => undefined,
  })
  try {
    await page.page.setContent(html, { waitUntil: 'load', timeout: 120_000 })
    await page.page.evaluate(() => document.fonts.ready.then(() => undefined))
    return await page.pdf(options)
  } finally {
    await page.close()
  }
}
