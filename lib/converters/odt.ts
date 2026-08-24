// Extracts ODT (OpenDocument Text) content as semantic HTML — preserving
// headings, paragraphs, bold/italic/underline (resolved from ODF character
// styles), tables, and lists — instead of flattening everything to
// tab/newline-delimited plain text.
//
// That flattened text used to get fed straight into a "wrap every
// double-newline-separated chunk in a <p>" step. Two things went wrong
// with that: (1) headings and paragraphs were indistinguishable (both are
// just <text:p>/<text:h> elements pulled down to plain strings, so every
// heading became a plain paragraph everywhere), and (2) because sibling
// blocks were joined by a single '\n' rather than '\n\n', a table sitting
// between two paragraphs in the source could end up merged into the SAME
// <p> as the surrounding prose, with no table markup at all — a document
// with "Intro / table / Outro" could render as one paragraph of Intro,
// tab-separated cell text, and Outro all run together.
//
// The semantic HTML this produces instead flows into the (already fixed)
// shared htmlToPdfBlob / htmlToDocxBlob / turndown pipeline, so real
// <table>, <h1>-<h6>, <strong>, <em>, <u>, and <ul> markup here fixes ODT
// fidelity across all four downstream targets (html/pdf/docx/md) at once.
//
// Scope note: character formatting is resolved from ODF "automatic styles"
// (style:style elements found directly in content.xml), which is how
// office suites represent direct/ad-hoc formatting (select text, click
// Bold). Formatting that comes ONLY from a named style's inheritance chain
// defined in the separate styles.xml part (e.g. a paragraph style whose
// bold-ness is inherited rather than directly set) isn't resolved — a
// reasonable, bounded scope that covers the common case without pulling in
// full ODF style-cascade resolution.

const ODF_NS = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  style: 'urn:oasis:names:tc:opendocument:xmlns:style:1.0',
  fo: 'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0',
}

function parseOdtXml(xmlText: string): Document {
  const doc = new DOMParser().parseFromString(xmlText, 'application/xml')
  if (doc.querySelector('parsererror')) throw new Error('Not a valid ODT file — content.xml failed to parse')
  return doc
}

// ── Whitespace materialization (plain-text extraction path) ─────────────────
// Replaces ODT's dedicated whitespace elements (line breaks, tabs, runs of
// spaces) with real text nodes in place, so a plain `.textContent` read
// afterwards naturally includes them at the right position. Operates on a
// clone so the source tree used elsewhere is left untouched.
function materializeOdtWhitespace(root: Element, lineBreak: string): void {
  const doc = root.ownerDocument
  for (const el of Array.from(root.getElementsByTagNameNS(ODF_NS.text, 'line-break')))
    el.replaceWith(doc.createTextNode(lineBreak))
  for (const el of Array.from(root.getElementsByTagNameNS(ODF_NS.text, 'tab')))
    el.replaceWith(doc.createTextNode('\t'))
  for (const el of Array.from(root.getElementsByTagNameNS(ODF_NS.text, 's'))) {
    const count = parseInt(el.getAttributeNS(ODF_NS.text, 'c') ?? '1', 10)
    el.replaceWith(doc.createTextNode(' '.repeat(Number.isFinite(count) && count > 0 ? count : 1)))
  }
}

function odtParagraphText(el: Element): string {
  const clone = el.cloneNode(true) as Element
  materializeOdtWhitespace(clone, '\n')
  return (clone.textContent ?? '').trim()
}

function odtTableText(tableEl: Element): string {
  const rows = Array.from(tableEl.getElementsByTagNameNS(ODF_NS.table, 'table-row'))
  const lines = rows.map((row) => {
    const cells = Array.from(row.getElementsByTagNameNS(ODF_NS.table, 'table-cell'))
    const cellTexts = cells.map((cell) => {
      const clone = cell.cloneNode(true) as Element
      materializeOdtWhitespace(clone, ' ')
      return (clone.textContent ?? '').replace(/\s+/g, ' ').trim()
    })
    return cellTexts.join('\t')
  })
  return lines.join('\n')
}

function walkOdtBody(node: Element, out: string[]): void {
  for (const child of Array.from(node.children)) {
    const ns = child.namespaceURI
    const local = child.localName
    if (ns === ODF_NS.text && (local === 'p' || local === 'h')) {
      out.push(odtParagraphText(child))
    } else if (ns === ODF_NS.table && local === 'table') {
      out.push(odtTableText(child))
    } else {
      walkOdtBody(child, out)
    }
  }
}

export async function odtToText(buffer: ArrayBuffer): Promise<string> {
  const { unzipSync } = await import('fflate')
  const files = unzipSync(new Uint8Array(buffer))
  const contentXml = files['content.xml']
  if (!contentXml) throw new Error('Not a valid ODT file — content.xml not found')
  const doc = parseOdtXml(new TextDecoder().decode(contentXml))

  const body = doc.getElementsByTagNameNS(ODF_NS.office, 'text')[0] ?? doc.documentElement
  const out: string[] = []
  walkOdtBody(body, out)
  return out
    .join('\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── Character-style resolution (bold/italic/underline) ──────────────────────

interface OdtCharStyle {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
}

// Reads every style:style definition's text-properties (found directly in
// content.xml's automatic-styles — this is how office suites represent
// direct/ad-hoc character formatting) into a name -> {bold, italic,
// underline} map, so a <text:span text:style-name="..."> can be resolved
// to real formatting instead of being treated as plain text.
function parseOdtCharStyles(doc: Document): Map<string, OdtCharStyle> {
  const map = new Map<string, OdtCharStyle>()
  const styleEls = doc.getElementsByTagNameNS(ODF_NS.style, 'style')
  for (const styleEl of Array.from(styleEls)) {
    const name = styleEl.getAttributeNS(ODF_NS.style, 'name')
    if (!name) continue
    const propsEl = styleEl.getElementsByTagNameNS(ODF_NS.style, 'text-properties')[0]
    if (!propsEl) continue
    const weight = propsEl.getAttributeNS(ODF_NS.fo, 'font-weight')
    const fontStyle = propsEl.getAttributeNS(ODF_NS.fo, 'font-style')
    const underline = propsEl.getAttributeNS(ODF_NS.style, 'text-underline-style')
    const strike = propsEl.getAttributeNS(ODF_NS.style, 'text-line-through-style')
    map.set(name, {
      bold: weight === 'bold',
      italic: fontStyle === 'italic',
      underline: !!underline && underline !== 'none',
      strike: !!strike && strike !== 'none',
    })
  }
  return map
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

interface InlineFlags {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
}

function wrapInline(text: string, flags: InlineFlags): string {
  let out = escapeHtml(text)
  if (flags.bold) out = `<strong>${out}</strong>`
  if (flags.italic) out = `<em>${out}</em>`
  if (flags.underline) out = `<u>${out}</u>`
  if (flags.strike) out = `<s>${out}</s>`
  return out
}

// Walks an element's inline content (text runs, spans, line breaks, tabs,
// hyperlinks) producing HTML with bold/italic/underline/strikethrough
// resolved from each span's referenced style — so formatting the user
// actually applied survives instead of every run collapsing to
// indistinguishable plain text.
function odtInlineHtml(el: Element, styleMap: Map<string, OdtCharStyle>): string {
  let html = ''
  function walk(node: ChildNode, inherited: InlineFlags) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ''
      if (text) html += wrapInline(text, inherited)
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const child = node as Element
    const ns = child.namespaceURI
    const local = child.localName
    if (ns === ODF_NS.text && local === 'line-break') { html += '<br>'; return }
    if (ns === ODF_NS.text && local === 'tab') { html += '&#9;'; return }
    if (ns === ODF_NS.text && local === 's') {
      const count = parseInt(child.getAttributeNS(ODF_NS.text, 'c') ?? '1', 10)
      html += '&nbsp;'.repeat(Math.max(1, Number.isFinite(count) ? count : 1))
      return
    }
    if (ns === ODF_NS.text && local === 'span') {
      // Style REFERENCES on content elements use the text: namespace
      // (text:style-name) — distinct from a style DEFINITION's own
      // style:name attribute inside <style:style>, which parseOdtCharStyles
      // reads separately above.
      const styleName = child.getAttributeNS(ODF_NS.text, 'style-name')
      const style = styleName ? styleMap.get(styleName) : undefined
      const next: InlineFlags = {
        bold: inherited.bold || !!style?.bold,
        italic: inherited.italic || !!style?.italic,
        underline: inherited.underline || !!style?.underline,
        strike: inherited.strike || !!style?.strike,
      }
      for (const grandchild of Array.from(child.childNodes)) walk(grandchild, next)
      return
    }
    // Unknown wrapper (hyperlink text:a, bookmark, index-mark, etc.) —
    // recurse through it with the same inherited flags rather than
    // dropping its content.
    for (const grandchild of Array.from(child.childNodes)) walk(grandchild, inherited)
  }
  for (const child of Array.from(el.childNodes)) walk(child, { bold: false, italic: false, underline: false, strike: false })
  return html
}

// ── Lists ─────────────────────────────────────────────────────────────────────

// ODF doesn't distinguish "numbered" from "bulleted" at the <text:list>
// level the way HTML does — that's determined by the referenced
// <text:list-style>, which this module doesn't resolve (a full ODF
// numbering-style resolver is well beyond what's needed here). Rendering
// every ODT list as an unordered list is a safe, reasonable default: the
// structure and indentation — the part that actually carries meaning for
// conversion fidelity — is preserved either way, and a numbered list shown
// with bullets is far less surprising than list items silently vanishing.
function odtListToHtml(listEl: Element, styleMap: Map<string, OdtCharStyle>): string {
  const items = Array.from(listEl.children).filter(
    (c) => c.namespaceURI === ODF_NS.text && c.localName === 'list-item',
  )
  const parts = items.map((item) => {
    let inner = ''
    for (const child of Array.from(item.children)) {
      if (child.namespaceURI === ODF_NS.text && (child.localName === 'p' || child.localName === 'h')) {
        inner += odtInlineHtml(child, styleMap)
      } else if (child.namespaceURI === ODF_NS.text && child.localName === 'list') {
        inner += odtListToHtml(child, styleMap)
      }
    }
    return `<li>${inner}</li>`
  })
  return `<ul>${parts.join('')}</ul>`
}

// ── Tables ────────────────────────────────────────────────────────────────────

function odtTableToHtml(tableEl: Element, styleMap: Map<string, OdtCharStyle>): string {
  const rows = Array.from(tableEl.getElementsByTagNameNS(ODF_NS.table, 'table-row'))
  const rowsHtml = rows.map((row) => {
    const cells = Array.from(row.getElementsByTagNameNS(ODF_NS.table, 'table-cell'))
    const cellsHtml = cells.map((cell) => {
      const paras = Array.from(cell.children).filter(
        (c) => c.namespaceURI === ODF_NS.text && (c.localName === 'p' || c.localName === 'h'),
      )
      const inner = paras.map((p) => odtInlineHtml(p, styleMap)).join('<br>')
      return `<td>${inner}</td>`
    })
    return `<tr>${cellsHtml.join('')}</tr>`
  })
  return `<table>${rowsHtml.join('')}</table>`
}

// ── Top-level body walk ───────────────────────────────────────────────────────

function walkOdtBodyToHtml(node: Element, styleMap: Map<string, OdtCharStyle>, out: string[]): void {
  for (const child of Array.from(node.children)) {
    const ns = child.namespaceURI
    const local = child.localName
    if (ns === ODF_NS.text && local === 'h') {
      const levelAttr = parseInt(child.getAttributeNS(ODF_NS.text, 'outline-level') ?? '1', 10)
      const level = Math.min(6, Math.max(1, Number.isFinite(levelAttr) ? levelAttr : 1))
      out.push(`<h${level}>${odtInlineHtml(child, styleMap)}</h${level}>`)
    } else if (ns === ODF_NS.text && local === 'p') {
      const inner = odtInlineHtml(child, styleMap)
      out.push(`<p>${inner || '&nbsp;'}</p>`)
    } else if (ns === ODF_NS.table && local === 'table') {
      out.push(odtTableToHtml(child, styleMap))
    } else if (ns === ODF_NS.text && local === 'list') {
      out.push(odtListToHtml(child, styleMap))
    } else {
      walkOdtBodyToHtml(child, styleMap, out)
    }
  }
}

export async function odtToSemanticHtml(buffer: ArrayBuffer): Promise<string> {
  const { unzipSync } = await import('fflate')
  const files = unzipSync(new Uint8Array(buffer))
  const contentXml = files['content.xml']
  if (!contentXml) throw new Error('Not a valid ODT file — content.xml not found')
  const doc = parseOdtXml(new TextDecoder().decode(contentXml))
  const styleMap = parseOdtCharStyles(doc)

  const body = doc.getElementsByTagNameNS(ODF_NS.office, 'text')[0] ?? doc.documentElement
  const out: string[] = []
  walkOdtBodyToHtml(body, styleMap, out)
  const bodyHtml = out.join('\n') || '<p>&nbsp;</p>'

  // Styled via the same look used elsewhere for generated document HTML
  // (see document.ts's docx→html wrapper), so ODT output is visually
  // consistent with the app's other "→ HTML" conversions.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Document</title>
  <style>
    body { font-family: Georgia, serif; max-width: 800px; margin: 2rem auto; padding: 0 1.5rem; line-height: 1.7; color: #222; font-size: 11pt; }
    h1 { font-size: 2em; margin-top: 1.4em; } h2 { font-size: 1.5em; margin-top: 1.3em; } h3 { font-size: 1.17em; margin-top: 1.2em; }
    h1,h2,h3,h4,h5,h6 { margin-bottom: 0.4em; }
    p { margin: 0 0 0.8em; }
    ul, ol { margin: 0.4em 0 0.8em 1.5em; } li { margin-bottom: 0.2em; }
    table { border-collapse: collapse; width: 100%; margin: 1em 0; }
    td, th { border: 1px solid #ccc; padding: 6px 10px; }
    th { background: #f5f5f5; font-weight: bold; }
  </style>
</head>
<body>
${bodyHtml}
</body>
</html>`
}