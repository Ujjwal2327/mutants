// Renders HTML-ish content (from mammoth/marked/turndown output, a raw
// HTML file, or ODT-derived semantic HTML) into a PDF using jsPDF's own
// vector text/shape primitives, walking the parsed DOM and tracking our
// own page position — see the comment that used to sit above this code in
// document.ts for the full history of why this renders natively instead of
// rasterizing the DOM via html2canvas (canvas color-function crashes on
// oklch(), a hard ~16,384px canvas-height ceiling, and jsPDF's own
// autoPaging text-overlap bugs on multi-page documents).
//
// This also closes a real gap in that native-rendering approach: jsPDF's
// built-in fonts (Helvetica/Times/Courier) only support WinAnsiEncoding
// (~Windows-1252) — so Devanagari, CJK, Cyrillic, Arabic, Greek, and most
// symbol characters have no glyph in the font at all. jsPDF does not throw
// or substitute a placeholder for these (verified directly against jsPDF's
// own PDF output): it silently switches the whole string to a 2-byte
// character encoding that the referenced 1-byte WinAnsi font can't
// interpret, so a viewer shows stray/garbled characters — or nothing —
// instead of the intended text. That is the actual mechanism behind "my
// PDF came out blank" for any document containing a non-Latin script. The
// fix here: detect words that need characters outside WinAnsi and
// rasterize just those words to a small canvas (using the browser's own,
// genuinely Unicode-aware font rendering) and place them as an inline
// image at the right position — everything else keeps using jsPDF's fast,
// native vector text.

import { parseDataUriImage } from './data-uri-image'

type PdfDoc = InstanceType<(typeof import('jspdf'))['jsPDF']>

const MM_PER_PT = 0.352778
const PAGE_W = 210, PAGE_H = 297, MARGIN = 15
const CONTENT_W = PAGE_W - MARGIN * 2

function lineHeightMm(fontSizePt: number): number {
  return fontSizePt * MM_PER_PT * 1.32
}

interface RenderState {
  doc: PdfDoc
  y: number
}

function ensureSpace(state: RenderState, needed: number): void {
  if (state.y + needed > PAGE_H - MARGIN) {
    state.doc.addPage()
    state.y = MARGIN
  }
}

// jsPDF's standard fonts only cover WinAnsi (~Windows-1252) — plenty of
// Latin punctuation (em dash, curly quotes, bullet •) is already in that
// set and renders fine with no help, but symbol-class characters aren't,
// and jsPDF doesn't reject them — it silently substitutes the wrong glyph
// (confirmed directly: U+2192 '→', commonly used as a bullet marker in
// generated documents, renders as garbage punctuation with the default
// font). Swapping the common offenders for a plain-ASCII equivalent is far
// more robust than it looks, precisely because it only needs to cover
// symbol characters — ordinary accented/typographic text already works.
function sanitizePdfText(text: string): string {
  return text
    .replace(/[\u2192\u27A1\u279C\u2794\u21E8\u2B95]/g, '->')
    .replace(/[\u2190\u2B05]/g, '<-')
    .replace(/[\u2194\u21D4]/g, '<->')
    .replace(/[\u26A0\u2757\u2755]/g, '[!]')
    .replace(/[\u2713\u2714\u2705]/g, '[ok]')
    .replace(/[\u2717\u2718\u274C]/g, '[x]')
    .replace(/[\u2B50\u2605]/g, '*')
}

// ── Non-WinAnsi glyph fallback ───────────────────────────────────────────────

// The ~27-character "extra" set WinAnsiEncoding maps beyond plain Latin-1
// (smart quotes, em/en dash, bullet, €, ...) — this is the Windows-1252
// high-byte table (0x80-0x9F), the same set already used elsewhere in this
// converter for RTF decoding, expressed here as the Unicode code points
// jsPDF's fonts can actually render.
const WINANSI_EXTRA_CODEPOINTS = new Set(
  [
    0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160,
    0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014,
    0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
  ],
)

function isWinAnsiCodePoint(cp: number): boolean {
  if (cp <= 0xff) return true
  return WINANSI_EXTRA_CODEPOINTS.has(cp)
}

function needsGlyphFallback(text: string): boolean {
  for (const ch of text) {
    if (!isWinAnsiCodePoint(ch.codePointAt(0) ?? 0)) return true
  }
  return false
}

// Rasterizes one word/line to a small canvas using the browser's own font
// stack — which, unlike jsPDF's built-in fonts, genuinely supports
// whatever script the text needs on any modern OS — returning a PNG data
// URL plus the metrics needed to place and size it like a line of real PDF
// text sitting on the same baseline.
const FALLBACK_FONT_STACK =
  "'Noto Sans','Noto Sans Devanagari','Noto Sans SC','Noto Sans Arabic','Segoe UI',Arial,sans-serif"

interface FallbackGlyph {
  dataUrl: string
  widthMm: number
  heightMm: number
  ascentMm: number
}

const fallbackGlyphCache = new Map<string, FallbackGlyph | null>()

function renderFallbackText(text: string, fontSizePt: number, bold: boolean, italic: boolean): FallbackGlyph | null {
  const cacheKey = `${fontSizePt}|${bold}|${italic}|${text}`
  if (fallbackGlyphCache.has(cacheKey)) return fallbackGlyphCache.get(cacheKey)!

  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) { fallbackGlyphCache.set(cacheKey, null); return null }
  const scale = 4 // supersample so the embedded raster stays crisp at print size
  const pxPerPt = 96 / 72
  const fontPx = fontSizePt * pxPerPt * scale
  const weight = bold ? 'bold ' : ''
  const style = italic ? 'italic ' : ''
  const fontSpec = `${style}${weight}${fontPx}px ${FALLBACK_FONT_STACK}`
  ctx.font = fontSpec
  const metrics = ctx.measureText(text)
  const ascent = metrics.actualBoundingBoxAscent > 0 ? metrics.actualBoundingBoxAscent : fontPx * 0.8
  const descent = metrics.actualBoundingBoxDescent > 0 ? metrics.actualBoundingBoxDescent : fontPx * 0.25
  const width = Math.max(1, Math.ceil(metrics.width))
  const height = Math.max(1, Math.ceil(ascent + descent))
  canvas.width = width
  canvas.height = height
  // Resizing the canvas resets its 2D context state, so the font has to be
  // set again before actually drawing.
  ctx.font = fontSpec
  ctx.fillStyle = '#000000'
  ctx.textBaseline = 'alphabetic'
  ctx.fillText(text, 0, ascent)
  const glyph: FallbackGlyph = {
    dataUrl: canvas.toDataURL('image/png'),
    widthMm: (width / scale / pxPerPt) * MM_PER_PT,
    heightMm: (height / scale / pxPerPt) * MM_PER_PT,
    ascentMm: (ascent / scale / pxPerPt) * MM_PER_PT,
  }
  fallbackGlyphCache.set(cacheKey, glyph)
  return glyph
}

// Shared measurement used by both the paragraph word-wrap loop and table
// cell wrapping, so a word's width means the same thing everywhere it's
// used — and is actually correct for non-WinAnsi words, which
// doc.getTextWidth cannot measure meaningfully (see module comment above).
function measureWordWidthMm(doc: PdfDoc, word: string, fontSizePt: number, bold: boolean, italic: boolean): number {
  if (needsGlyphFallback(word)) {
    const glyph = renderFallbackText(word, fontSizePt, bold, italic)
    if (glyph) return glyph.widthMm
  }
  setRunFont(doc, bold, italic)
  doc.setFontSize(fontSizePt)
  // Sum individual character widths rather than measuring the whole string
  // in one call. jsPDF's getTextWidth() applies the font's AFM kerning-pair
  // table when measuring a multi-character string (verified directly:
  // getTextWidth("You") measures ~0.52mm narrower than 'Y'+'o'+'u' summed,
  // because Helvetica defines a "Yo" kerning pair) -- but doc.text() always
  // renders via a plain Tj with no per-glyph kerning offsets, so the
  // ACTUAL rendered width of a kerning-eligible word is the un-kerned sum
  // of its characters' advances, not the kerned whole-string measurement.
  // Using the kerned value here was silently under-advancing curX after
  // any such word, visibly crowding the next word against it — confirmed
  // against a real document where ~4% of distinct words were affected,
  // worst case a 4pt error (larger than a full word-space).
  let width = 0
  for (const ch of word) width += doc.getTextWidth(ch)
  return width
}

// Draws one word/token at (x, y) where y is the text BASELINE, matching
// doc.text()'s own convention, so real and fallback-rendered words line up
// on the same baseline within a line.
function drawWord(doc: PdfDoc, word: string, x: number, y: number, fontSizePt: number, bold: boolean, italic: boolean): void {
  if (needsGlyphFallback(word)) {
    const glyph = renderFallbackText(word, fontSizePt, bold, italic)
    if (glyph) {
      try {
        doc.addImage(glyph.dataUrl, 'PNG', x, y - glyph.ascentMm, glyph.widthMm, glyph.heightMm)
      } catch {
        /* skip this glyph rather than let it take down the whole render */
      }
      return
    }
  }
  setRunFont(doc, bold, italic)
  doc.setFontSize(fontSizePt)
  doc.text(word, x, y)
}

function setRunFont(doc: PdfDoc, bold: boolean, italic: boolean): void {
  const style = bold && italic ? 'bolditalic' : bold ? 'bold' : italic ? 'italic' : 'normal'
  doc.setFont('helvetica', style)
}

// Draws an underline and/or strikethrough rule spanning [startX, endX] at
// the given text baseline y. Offsets are standard typographic ratios of
// the font size: underline sits just below the baseline, strikethrough
// sits near the middle of the x-height (roughly a third of the way up
// from baseline to cap-height for most fonts).
const DEFAULT_LINE_WIDTH_MM = 0.2

function drawDecorationLines(doc: PdfDoc, startX: number, endX: number, baselineY: number, fontSizePt: number, underline: boolean, strike: boolean): void {
  if (!underline && !strike) return
  if (endX <= startX) return
  const emMm = fontSizePt * MM_PER_PT
  const thickness = Math.max(0.08, emMm * 0.045)
  doc.setLineWidth(thickness)
  if (underline) {
    const y = baselineY + emMm * 0.09
    doc.line(startX, y, endX, y)
  }
  if (strike) {
    const y = baselineY - emMm * 0.3
    doc.line(startX, y, endX, y)
  }
  // Line width is global jsPDF state and persists across calls — restore
  // the default so a later table border or <hr> (neither of which sets
  // its own line width) doesn't silently inherit this thin decoration
  // width instead.
  doc.setLineWidth(DEFAULT_LINE_WIDTH_MM)
}

// ── Inline run / text extraction ─────────────────────────────────────────────

interface InlineRun {
  text: string
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  isBreak?: boolean
}

// Walks an element's children collecting styled text runs — nested any
// number of levels deep (STRONG inside EM inside a plain span, etc.) is
// tracked correctly either way. Stops descending at a nested UL/OL/TABLE:
// those are block-level content the caller (renderList / renderBlock)
// handles separately, so they don't get flattened into this element's own
// paragraph text with no bullets, indentation, or cell structure.
function getInlineRuns(el: Element): InlineRun[] {
  const runs: InlineRun[] = []
  function walk(node: ChildNode, bold: boolean, italic: boolean, underline: boolean, strike: boolean) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = sanitizePdfText((node.textContent ?? '').replace(/\s+/g, ' '))
      if (t) runs.push({ text: t, bold, italic, underline, strike })
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const tag = (node as Element).tagName
    if (tag === 'BR') { runs.push({ text: '', bold, italic, underline, strike, isBreak: true }); return }
    if (tag === 'UL' || tag === 'OL' || tag === 'TABLE') return
    for (const child of Array.from(node.childNodes)) {
      walk(
        child,
        bold || tag === 'STRONG' || tag === 'B',
        italic || tag === 'EM' || tag === 'I',
        underline || tag === 'U',
        strike || tag === 'S' || tag === 'STRIKE' || tag === 'DEL',
      )
    }
  }
  for (const child of Array.from(el.childNodes)) walk(child, false, false, false, false)
  return runs
}

function textOf(el: Element): string {
  return sanitizePdfText((el.textContent ?? '').replace(/\s+/g, ' ').trim())
}

// <pre> (and its usual nested <code>) must preserve whitespace/indentation
// verbatim — unlike textOf()'s prose-oriented "collapse all whitespace to
// a single space" behavior, which would flatten a nicely indented code
// block onto a single line. textContent already contains exactly the
// literal characters between the tags, so no whitespace normalization at
// all is the correct behavior here.
function preformattedText(el: Element): string {
  return sanitizePdfText(el.textContent ?? '')
}

// ── Paragraph / heading / blockquote rendering ───────────────────────────────

// Word-wraps a list of mixed-style runs across as many lines as needed,
// batching consecutive same-styled, non-fallback words into a single
// doc.text() call with a real, literal space-joined string -- rather than
// one absolutely-positioned Td+Tj pair per word. Two reasons this matters:
// (1) it means jsPDF measures and renders the exact same string in one
// call, eliminating any possibility of a measure-vs-render mismatch (see
// measureWordWidthMm's comment for a concrete case this caused); (2) the
// resulting PDF's text layer contains actual space characters, so it's
// correctly extractable by copy-paste, search, and accessibility tools --
// not just ones sophisticated enough to infer word boundaries purely from
// the positional gap between many small, separately-placed text blocks.
// Falls back to drawing a word on its own (via drawWord, which may render
// it as an image) whenever glyph fallback is needed, or a style/line
// change interrupts the run of accumulable words.
function drawRuns(state: RenderState, runs: InlineRun[], x: number, maxWidth: number, fontSize: number): void {
  const { doc } = state
  const lh = lineHeightMm(fontSize)
  ensureSpace(state, lh)
  let curX = x
  let startedLine = false

  let pending = ''
  let pendingStartX = x
  let pendingBold = false
  let pendingItalic = false
  let pendingUnderline = false
  let pendingStrike = false

  const flushPending = () => {
    if (pending) {
      setRunFont(doc, pendingBold, pendingItalic)
      doc.setFontSize(fontSize)
      doc.text(pending, pendingStartX, state.y)
      drawDecorationLines(doc, pendingStartX, curX, state.y, fontSize, pendingUnderline, pendingStrike)
    }
    pending = ''
  }
  const sameStyle = (run: InlineRun) =>
    pendingBold === run.bold && pendingItalic === run.italic && pendingUnderline === run.underline && pendingStrike === run.strike

  for (const run of runs) {
    if (run.isBreak) {
      flushPending()
      state.y += lh
      curX = x
      ensureSpace(state, lh)
      startedLine = false
      continue
    }
    const words = run.text.split(/(\s+)/).filter((w) => w !== '')
    for (const word of words) {
      if (/^\s+$/.test(word)) {
        if (startedLine) {
          if (pending && sameStyle(run)) {
            pending += ' '
          } else {
            flushPending()
          }
          curX += measureWordWidthMm(doc, ' ', fontSize, run.bold, run.italic)
        }
        continue
      }
      const w = measureWordWidthMm(doc, word, fontSize, run.bold, run.italic)
      if (startedLine && curX + w > x + maxWidth) {
        flushPending()
        state.y += lh
        curX = x
        ensureSpace(state, lh)
        startedLine = false
      }
      if (needsGlyphFallback(word)) {
        flushPending()
        drawWord(doc, word, curX, state.y, fontSize, run.bold, run.italic)
        drawDecorationLines(doc, curX, curX + w, state.y, fontSize, run.underline, run.strike)
      } else if (pending && sameStyle(run)) {
        pending += word
      } else {
        flushPending()
        pending = word
        pendingStartX = curX
        pendingBold = run.bold
        pendingItalic = run.italic
        pendingUnderline = run.underline
        pendingStrike = run.strike
      }
      curX += w
      startedLine = true
    }
  }
  flushPending()
  state.y += lh
}

// Renders preformatted text (code blocks) preserving exact spacing and
// line breaks — deliberately NOT going through drawRuns' prose word-wrap,
// which collapses any run of whitespace to a single space's width and
// would destroy leading indentation. Draws each source line via a
// monospace font, only hard-wrapping (by character count) a line too wide
// to fit rather than reflowing it.
function drawPreformattedBlock(state: RenderState, text: string, x: number, maxWidth: number, fontSize: number): void {
  const { doc } = state
  const lh = lineHeightMm(fontSize)
  doc.setFont('courier', 'normal')
  doc.setFontSize(fontSize)
  const charWidth = doc.getTextWidth('M') || 2 // Courier is monospace: every glyph is the same width
  const maxChars = Math.max(10, Math.floor(maxWidth / charWidth))
  const lines = text.replace(/\n+$/, '').split('\n')
  for (const rawLine of lines) {
    const chunks = rawLine.length > maxChars ? (rawLine.match(new RegExp(`.{1,${maxChars}}`, 'g')) ?? ['']) : [rawLine]
    for (const chunk of chunks) {
      ensureSpace(state, lh)
      if (needsGlyphFallback(chunk)) {
        const glyph = renderFallbackText(chunk, fontSize, false, false)
        if (glyph) {
          try {
            doc.addImage(glyph.dataUrl, 'PNG', x, state.y - glyph.ascentMm, glyph.widthMm, glyph.heightMm)
          } catch {
            /* skip this glyph rather than let it take down the whole render */
          }
        }
      } else {
        doc.setFont('courier', 'normal')
        doc.setFontSize(fontSize)
        doc.text(chunk, x, state.y)
      }
      state.y += lh
    }
  }
  doc.setFont('helvetica', 'normal')
}

// ── Lists (nesting-aware) ─────────────────────────────────────────────────────

// Renders a <ul>/<ol>, recursing into any nested list found as a direct
// child of an <li> at an indented depth — instead of flattening a nested
// list's items into the parent item's own text with no bullets or
// indentation, which is what happens if getInlineRuns is allowed to
// descend into a nested UL/OL (it deliberately stops there; see above).
function renderList(state: RenderState, el: Element, x: number, maxWidth: number, depth: number): void {
  const tag = el.tagName
  const indent = Math.min(depth, 4) * 5
  const bulletChars = ['-', '\u2022', 'o', '\u2013']
  let n = 1
  for (const li of Array.from(el.children)) {
    if (li.tagName !== 'LI') continue
    const marker = tag === 'OL' ? `${n++}.` : bulletChars[depth % bulletChars.length]
    const markerWidth = 6
    ensureSpace(state, lineHeightMm(10.5))
    drawWord(state.doc, marker, x + indent, state.y, 10.5, false, false)
    drawRuns(state, getInlineRuns(li), x + indent + markerWidth, maxWidth - indent - markerWidth, 10.5)
    for (const nested of Array.from(li.children)) {
      if (nested.tagName === 'UL' || nested.tagName === 'OL') {
        renderList(state, nested, x, maxWidth, depth + 1)
      }
    }
  }
  state.y += 1
}

// ── Tables ────────────────────────────────────────────────────────────────────

// Wraps `text` to fit within maxWidthMm, measuring words the same
// fallback-aware way drawRuns does — doc.splitTextToSize (used here
// previously) cannot measure non-WinAnsi text at all, so a table cell
// containing e.g. Hindi content would wrap unpredictably (or not at all)
// and render blank. Force-breaks a single word that alone exceeds the
// column width, so one long token can't overflow the cell's border.
function wrapTextToWidth(doc: PdfDoc, text: string, maxWidthMm: number, fontSize: number, bold: boolean): string[] {
  const words = text.split(/\s+/).filter(Boolean)
  if (words.length === 0) return ['']
  const spaceW = measureWordWidthMm(doc, ' ', fontSize, bold, false)
  const lines: string[] = []
  let line: string[] = []
  let lineWidth = 0
  const pushWord = (word: string, width: number) => {
    const extra = (line.length ? spaceW : 0) + width
    if (line.length && lineWidth + extra > maxWidthMm) {
      lines.push(line.join(' '))
      line = [word]
      lineWidth = width
    } else {
      line.push(word)
      lineWidth += extra
    }
  }
  for (const word of words) {
    const w = measureWordWidthMm(doc, word, fontSize, bold, false)
    if (w <= maxWidthMm || maxWidthMm <= 0) { pushWord(word, w); continue }
    // Word alone is wider than the column — hard-break it by characters,
    // inserting a hyphen at the break (standard convention for a mid-word
    // line break) so e.g. "backshifted" splits as "backshift-" / "ed"
    // rather than "backshifte" / "d" with no indication it continues.
    let chunk = ''
    for (const ch of word) {
      const candidate = chunk + ch
      const candidateWidth = measureWordWidthMm(doc, candidate + '-', fontSize, bold, false)
      if (candidateWidth > maxWidthMm && chunk) {
        pushWord(chunk + '-', measureWordWidthMm(doc, chunk + '-', fontSize, bold, false))
        chunk = ch
      } else {
        chunk = candidate
      }
    }
    if (chunk) pushWord(chunk, measureWordWidthMm(doc, chunk, fontSize, bold, false))
  }
  if (line.length) lines.push(line.join(' '))
  return lines.length ? lines : ['']
}

function drawTextLine(doc: PdfDoc, line: string, x: number, y: number, fontSize: number, bold: boolean): void {
  const words = line.split(/(\s+)/).filter((w) => w !== '')
  let curX = x
  let pending = ''
  let pendingStartX = x
  const flush = () => {
    if (pending) {
      setRunFont(doc, bold, false)
      doc.setFontSize(fontSize)
      doc.text(pending, pendingStartX, y)
    }
    pending = ''
  }
  for (const word of words) {
    if (/^\s+$/.test(word)) {
      curX += measureWordWidthMm(doc, ' ', fontSize, bold, false)
      if (pending) pending += ' '
      continue
    }
    const w = measureWordWidthMm(doc, word, fontSize, bold, false)
    if (needsGlyphFallback(word)) {
      flush()
      drawWord(doc, word, curX, y, fontSize, bold, false)
    } else {
      if (!pending) pendingStartX = curX
      pending += word
    }
    curX += w
  }
  flush()
}

// Column widths are allocated proportionally to each column's average
// content length (with a floor so no column collapses to nothing) rather
// than split evenly — the Category/Test/Rule/Example-shaped tables this
// was built against have very unevenly sized columns, and equal-width
// columns made them noticeably harder to read during testing.
function drawTable(state: RenderState, tableEl: Element, x: number, maxWidth: number): void {
  const { doc } = state
  const rows = Array.from(tableEl.querySelectorAll('tr'))
  if (rows.length === 0) return
  const colCount = Math.max(...rows.map((r) => r.children.length))
  if (colCount === 0) return
  const fontSize = 9
  const cellPad = 1.8
  const lh = lineHeightMm(fontSize)

  const colCharTotals = new Array(colCount).fill(0)
  rows.forEach((r) => Array.from(r.children).forEach((c, i) => { colCharTotals[i] += textOf(c).length + 1 }))
  const totalChars = colCharTotals.reduce((a, b) => a + b, 0) || 1
  const minColWidth = maxWidth * 0.12
  let colWidths = colCharTotals.map((n) => Math.max(minColWidth, (n / totalChars) * maxWidth))
  const widthSum = colWidths.reduce((a, b) => a + b, 0)
  colWidths = colWidths.map((w) => (w / widthSum) * maxWidth)
  const colX: number[] = []
  let acc = x
  for (const w of colWidths) { colX.push(acc); acc += w }

  const headerRow =
    rows[0]?.children.length && Array.from(rows[0].children).every((c) => c.tagName === 'TH') ? rows[0] : null

  function wrapRow(row: Element, isHeader: boolean): { wrapped: string[][]; rowHeight: number } {
    const cells = Array.from(row.children)
    const wrapped = cells.map((c, i) => wrapTextToWidth(doc, textOf(c) || ' ', colWidths[i] - cellPad * 2, fontSize, isHeader))
    const rowLines = Math.max(1, ...wrapped.map((w) => w.length))
    return { wrapped, rowHeight: rowLines * lh + cellPad * 2 }
  }

  function drawRow(row: Element, isHeader: boolean): void {
    const { wrapped, rowHeight } = wrapRow(row, isHeader)
    const cells = Array.from(row.children)
    cells.forEach((_cell, i) => {
      if (isHeader) {
        doc.setFillColor(235, 235, 235)
        doc.rect(colX[i], state.y, colWidths[i], rowHeight, 'F')
      }
      doc.setDrawColor(180, 180, 180)
      doc.rect(colX[i], state.y, colWidths[i], rowHeight)
      wrapped[i].forEach((line, li) => {
        drawTextLine(doc, line, colX[i] + cellPad, state.y + cellPad + lh * 0.75 + li * lh, fontSize, isHeader)
      })
    })
    state.y += rowHeight
  }

  for (const row of rows) {
    const isHeader = row === headerRow
    const { rowHeight } = wrapRow(row, isHeader)
    if (state.y + rowHeight > PAGE_H - MARGIN) {
      doc.addPage()
      state.y = MARGIN
      // Repeat the header on the new page so a table that spans a page
      // break doesn't leave its continuation unlabeled.
      if (headerRow && !isHeader) drawRow(headerRow, true)
    }
    drawRow(row, isHeader)
  }
  state.y += 3
}

// ── Block dispatch ────────────────────────────────────────────────────────────

const HEADING_SIZE_PT: Record<string, number> = { H1: 18, H2: 14, H3: 12, H4: 11, H5: 10.5, H6: 10 }
const PASSTHROUGH_TAGS = new Set(['DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'BODY', 'ASIDE', 'FIGURE', 'FIGCAPTION'])

// Dispatches on node type so bare text nodes (e.g. `<body>Hello world</body>`
// with no wrapping <p>, or "Intro text <b>bold</b>" mixed content) render
// too — a plain `Array.from(el.children)` walk only visits ELEMENT
// children and silently drops text nodes entirely, which is what produced
// a blank PDF for minimal/hand-written HTML with no block wrapper.
function renderNode(state: RenderState, node: ChildNode, x: number, maxWidth: number): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = sanitizePdfText((node.textContent ?? '').replace(/\s+/g, ' ').trim())
    if (t) drawRuns(state, [{ text: t, bold: false, italic: false, underline: false, strike: false }], x, maxWidth, 10.5)
    return
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return
  renderBlock(state, node as Element, x, maxWidth)
}

function renderBlock(state: RenderState, el: Element, x: number, maxWidth: number): void {
  const tag = el.tagName
  if (tag in HEADING_SIZE_PT) {
    ensureSpace(state, 10)
    state.y += 3
    drawRuns(state, [{ text: textOf(el), bold: true, italic: false, underline: false, strike: false }], x, maxWidth, HEADING_SIZE_PT[tag])
    state.y += 1.5
    return
  }
  if (tag === 'P') {
    const runs = getInlineRuns(el)
    if (runs.length) drawRuns(state, runs, x, maxWidth, 10.5)
    state.y += 1.2
    return
  }
  if (tag === 'UL' || tag === 'OL') { renderList(state, el, x, maxWidth, 0); return }
  if (tag === 'TABLE') { drawTable(state, el, x, maxWidth); return }
  if (tag === 'BLOCKQUOTE') {
    drawRuns(state, getInlineRuns(el), x + 4, maxWidth - 4, 10.5)
    return
  }
  if (tag === 'PRE' || tag === 'CODE') {
    const text = preformattedText(el)
    if (text.trim()) drawPreformattedBlock(state, text, x, maxWidth, 9.5)
    return
  }
  if (tag === 'IMG') {
    const src = el.getAttribute('src') ?? ''
    const parsed = parseDataUriImage(src)
    // jsPDF's addImage only recognizes JPEG/PNG/WEBP — a data-URI GIF is
    // skipped here rather than passed through to a call that would throw.
    if (parsed && (parsed.mime === 'image/png' || parsed.mime === 'image/jpeg') && parsed.width > 0 && parsed.height > 0) {
      const pxToMm = 25.4 / 96
      let wMm = parsed.width * pxToMm
      let hMm = parsed.height * pxToMm
      const maxHmm = 130
      const scale = Math.min(1, maxWidth / wMm, maxHmm / hMm)
      wMm *= scale
      hMm *= scale
      if (state.y + hMm > PAGE_H - MARGIN) { state.doc.addPage(); state.y = MARGIN }
      try {
        // jsPDF validates image bytes (e.g. PNG chunk CRCs) and throws on
        // anything malformed — a single corrupt/unusual embedded image
        // must not take down the rest of an otherwise-good document.
        state.doc.addImage(src, parsed.mime === 'image/png' ? 'PNG' : 'JPEG', x, state.y, wMm, hMm)
        state.y += hMm + 3
      } catch {
        /* skip this one image, keep rendering the rest of the document */
      }
    }
    return
  }
  if (tag === 'HR') {
    ensureSpace(state, 4)
    state.doc.setDrawColor(200, 200, 200)
    state.doc.line(x, state.y, x + maxWidth, state.y)
    state.y += 4
    return
  }
  if (PASSTHROUGH_TAGS.has(tag)) {
    for (const child of Array.from(el.childNodes)) renderNode(state, child, x, maxWidth)
    return
  }
  // Unrecognized element — fall back to its plain text rather than
  // silently dropping it.
  const t = textOf(el)
  if (t) drawRuns(state, [{ text: t, bold: false, italic: false, underline: false, strike: false }], x, maxWidth, 10.5)
}

// ── Entry points ──────────────────────────────────────────────────────────────

export async function htmlToPdfBlob(html: string): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  try {
    // 'text/html' parsing always yields a real <body> regardless of whether
    // the input was a bare fragment (mammoth/marked/turndown output) or a
    // complete document (odtToSemanticHtml's output, or a user's own
    // uploaded .html file).
    const parsedBody = new DOMParser().parseFromString(html, 'text/html').body
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    const state: RenderState = { doc, y: MARGIN }
    if (parsedBody) {
      for (const child of Array.from(parsedBody.childNodes)) renderNode(state, child, MARGIN, CONTENT_W)
    }
    return doc.output('blob')
  } catch {
    // Fallback for anything genuinely unexpected: a plain, unformatted text
    // dump is still a far better result than a failed conversion.
    const div = document.createElement('div')
    div.innerHTML = html
    div.querySelectorAll('style, script, title').forEach((el) => el.remove())
    return textToPdfBlob(div.textContent ?? '')
  }
}

// Plain-text PDF, used for TXT/RTF input (and as htmlToPdfBlob's own
// fallback). Now shares the same fallback-aware word measurement/drawing
// as the HTML path, so a non-Latin-script .txt file no longer renders
// blank/garbled either.
export async function textToPdfBlob(text: string): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  const fontSize = 11
  const marginTop = 15, marginBottom = 15
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const contentWidth = pageWidth - marginTop - marginBottom
  const lh = lineHeightMm(fontSize)
  const maxY = pageHeight - marginBottom
  // Defensive: fileToText already normalizes CRLF/BOM at the source for
  // every current caller, but this function's input isn't guaranteed to
  // always come from there, so normalize here too rather than depend on it.
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const sanitized = sanitizePdfText(normalized)
  let y = marginTop
  for (const paragraph of sanitized.split('\n')) {
    const lines = wrapTextToWidth(doc, paragraph || ' ', contentWidth, fontSize, false)
    for (const line of lines) {
      if (y + lh > maxY) { doc.addPage(); y = marginTop }
      drawTextLine(doc, paragraph ? line : '', 15, y, fontSize, false)
      y += lh
    }
  }
  return doc.output('blob')
}