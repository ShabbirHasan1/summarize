import { load } from 'cheerio'

const COMMENT_PATTERN = /<!--[\s\S]*?-->/g
const STYLE_SPLIT_PATTERN = /;/

type StyleMap = Record<string, string>

function parseStyle(style: string): StyleMap {
  const map: StyleMap = {}
  for (const part of style.split(STYLE_SPLIT_PATTERN)) {
    const trimmed = part.trim()
    if (!trimmed) continue
    const colon = trimmed.indexOf(':')
    if (colon === -1) continue
    const key = trimmed.slice(0, colon).trim().toLowerCase()
    const value = trimmed
      .slice(colon + 1)
      .trim()
      .toLowerCase()
    if (!key) continue
    map[key] = value
  }
  return map
}

function parseCssNumber(value: string | undefined): number | null {
  if (!value) return null
  const match = value.trim().match(/^(-?\d*\.?\d+)/)
  if (!match) return null
  const parsed = Number.parseFloat(match[1] ?? '')
  return Number.isFinite(parsed) ? parsed : null
}

function isHiddenByStyle(style: string): boolean {
  const normalized = style.toLowerCase()
  if (/display\s*:\s*none/.test(normalized)) return true
  if (/visibility\s*:\s*hidden/.test(normalized)) return true
  if (/opacity\s*:\s*0(?:\.0+)?(?:\s|;|$)/.test(normalized)) return true
  if (/font-size\s*:\s*0(?:\.0+)?(?:[a-z%]+)?/.test(normalized)) return true
  if (/clip-path\s*:\s*inset\(\s*100%/i.test(normalized)) return true
  if (
    /clip\s*:\s*rect\(\s*0(?:px)?\s*,\s*0(?:px)?\s*,\s*0(?:px)?\s*,\s*0(?:px)?\s*\)/i.test(
      normalized
    )
  ) {
    return true
  }
  if (/transform\s*:\s*scale\(\s*0(?:\s*,\s*0)?\s*\)/i.test(normalized)) return true

  const styles = parseStyle(normalized)
  const width = parseCssNumber(styles.width)
  const height = parseCssNumber(styles.height)
  const overflow = styles.overflow ?? ''
  if (width === 0 && height === 0 && overflow.startsWith('hidden')) return true

  const textIndent = parseCssNumber(styles['text-indent'])
  if (textIndent !== null && textIndent <= -999) return true

  const position = styles.position
  if (position === 'absolute' || position === 'fixed') {
    const left = parseCssNumber(styles.left)
    const top = parseCssNumber(styles.top)
    if (left !== null && left <= -999) return true
    if (top !== null && top <= -999) return true
  }

  return false
}

function shouldStripElement(
  tagName: string,
  style: string | undefined,
  attributes: StyleMap
): boolean {
  if (tagName === 'template') return true
  if (tagName === 'script') return true
  if (tagName === 'style') return true
  if (tagName === 'noscript') return true
  if (tagName === 'svg') return true
  if (tagName === 'canvas') return true
  if (tagName === 'iframe') return true
  if (tagName === 'object') return true
  if (tagName === 'embed') return true

  if ('hidden' in attributes) return true

  const ariaHidden = attributes['aria-hidden']
  if (ariaHidden === 'true' || ariaHidden === '1') return true

  if (tagName === 'input' && attributes.type === 'hidden') return true

  if (style && isHiddenByStyle(style)) return true

  return false
}

export function stripHiddenHtml(html: string): string {
  if (!html) return html
  const withoutComments = html.replace(COMMENT_PATTERN, '')
  const $ = load(withoutComments)

  $('*').each((_, element) => {
    if (!('tagName' in element) || typeof element.tagName !== 'string') return
    const tagName = element.tagName.toLowerCase()
    const attribs = 'attribs' in element && element.attribs ? element.attribs : {}
    const attributes: StyleMap = {}
    for (const [key, value] of Object.entries(attribs)) {
      attributes[key.toLowerCase()] = value?.toLowerCase?.() ?? ''
    }
    const style = attributes.style
    if (shouldStripElement(tagName, style, attributes)) {
      $(element).remove()
    }
  })

  return $.root().html() ?? ''
}
