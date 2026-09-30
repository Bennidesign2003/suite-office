/**
 * A self-contained copy of the page as it looks right now, for
 * webContents.printToPDF / capturePage on a page that lives in the user's
 * browser: the server renders it in headless Chromium. Script-built styles
 * (CSSOM rules, adopted sheets), canvas pixels, form values and blob: images
 * are baked in; scripts are dropped.
 */

function sheetText(sheet: CSSStyleSheet): string | null {
  try {
    const rules = Array.from(sheet.cssRules, (r) => r.cssText).join('\n')
    const media = sheet.media?.mediaText
    return media ? `@media ${media} {\n${rules}\n}` : rules
  } catch {
    return null
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

export async function takeSnapshot(): Promise<{ html: string; width: number; height: number }> {
  const doc = document
  const clone = doc.documentElement.cloneNode(true) as HTMLElement

  // canvases, matched by document order
  const liveCanvases = Array.from(doc.querySelectorAll('canvas'))
  const clonedCanvases = Array.from(clone.querySelectorAll('canvas'))
  clonedCanvases.forEach((canvas, i) => {
    const live = liveCanvases[i]
    if (!live) return
    let data: string
    try {
      data = live.toDataURL('image/png')
    } catch {
      return
    }
    const img = doc.createElement('img')
    img.src = data
    for (const attr of Array.from(canvas.attributes)) {
      if (attr.name !== 'width' && attr.name !== 'height') img.setAttribute(attr.name, attr.value)
    }
    const rect = live.getBoundingClientRect()
    if (!canvas.getAttribute('style')?.includes('width')) {
      img.style.width = `${rect.width}px`
      img.style.height = `${rect.height}px`
    }
    canvas.replaceWith(img)
  })

  // form state lives in properties, not attributes
  const liveFields = Array.from(doc.querySelectorAll('input, textarea, select'))
  Array.from(clone.querySelectorAll('input, textarea, select')).forEach((field, i) => {
    const live = liveFields[i] as
      HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | undefined
    if (!live) return
    if (field instanceof HTMLTextAreaElement)
      field.textContent = (live as HTMLTextAreaElement).value
    else if (field instanceof HTMLSelectElement) {
      Array.from(field.options).forEach((o, j) => {
        if (j === (live as HTMLSelectElement).selectedIndex) o.setAttribute('selected', '')
        else o.removeAttribute('selected')
      })
    } else if (field instanceof HTMLInputElement) {
      const input = live as HTMLInputElement
      if (input.type === 'checkbox' || input.type === 'radio') {
        if (input.checked) field.setAttribute('checked', '')
        else field.removeAttribute('checked')
      } else field.setAttribute('value', input.value)
    }
  })

  // blob: URLs die with this document
  const blobImages = Array.from(clone.querySelectorAll('img[src^="blob:"]')) as HTMLImageElement[]
  await Promise.all(
    blobImages.map(async (img) => {
      try {
        const blob = await (await fetch(img.getAttribute('src')!)).blob()
        img.setAttribute('src', await blobToDataUrl(blob))
      } catch {
        // leave it broken
      }
    }),
  )

  for (const el of Array.from(clone.querySelectorAll('script, link[rel="modulepreload"], iframe')))
    el.remove()

  // stylesheets: the CSSOM is the truth (rules inserted by script never reach the markup)
  const styles: string[] = []
  const sheetOwners = new Set<Node>()
  for (const sheet of Array.from(doc.styleSheets)) {
    const text = sheetText(sheet as CSSStyleSheet)
    if (text === null) continue
    styles.push(text)
    if (sheet.ownerNode) sheetOwners.add(sheet.ownerNode)
  }
  for (const sheet of doc.adoptedStyleSheets ?? []) {
    const text = sheetText(sheet)
    if (text !== null) styles.push(text)
  }
  // drop the originals whose rules were captured; keep cross-origin links as they are
  const liveStyleNodes = Array.from(doc.querySelectorAll('style, link[rel="stylesheet"]'))
  Array.from(clone.querySelectorAll('style, link[rel="stylesheet"]')).forEach((node, i) => {
    const live = liveStyleNodes[i]
    if (live && sheetOwners.has(live)) node.remove()
  })

  const head =
    clone.querySelector('head') ?? clone.insertBefore(doc.createElement('head'), clone.firstChild)
  const base = doc.createElement('base')
  base.href = location.href
  head.insertBefore(base, head.firstChild)
  const style = doc.createElement('style')
  style.textContent = styles.join('\n')
  head.appendChild(style)

  // scroll containers print from the top; the page itself must not clip
  const html = '<!doctype html>\n' + clone.outerHTML
  return { html, width: innerWidth, height: innerHeight }
}
