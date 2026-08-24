import { fileToText, fileToArrayBuffer } from '@/lib/utils'
import { htmlToPdfBlob, textToPdfBlob } from './pdf-text-render'
import { odtToText, odtToSemanticHtml } from './odt'
import { parseDataUriImage } from './data-uri-image'

function htmlToText(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html
  // Setting a FULL html document (one with <head>/<style>/<title>) as the
  // innerHTML of a plain element causes the <html>/<head>/<body> wrapper
  // tags to be dropped by the fragment-parsing algorithm, while THEIR
  // children — including <style> and <title> — survive as ordinary direct
  // children alongside the real body content. textContent doesn't
  // distinguish those from visible text, so raw CSS rules (and the page
  // title) were silently leaking into every "extract plain text" call site
  // that passes a full document through here: HTML->TXT, HTML->RTF, and the
  // plain-text PDF fallback.
  div.querySelectorAll('style, script, title').forEach((el) => el.remove())
  return div.textContent ?? ''
}

// htmlToPdfBlob / textToPdfBlob now live in ./pdf-text-render — see that
// module for the full explanation of how PDF generation works here (native
// vector text instead of html2canvas rasterization) and the non-WinAnsi
// glyph-fallback mechanism that fixes non-Latin-script text rendering
// blank/garbled in the generated PDF.

const CP1252_HIGH_BYTES: Record<number, string> = {
  0x80: '\u20AC', 0x82: '\u201A', 0x83: '\u0192', 0x84: '\u201E', 0x85: '\u2026',
  0x86: '\u2020', 0x87: '\u2021', 0x88: '\u02C6', 0x89: '\u2030', 0x8A: '\u0160',
  0x8B: '\u2039', 0x8C: '\u0152', 0x8E: '\u017D', 0x91: '\u2018', 0x92: '\u2019',
  0x93: '\u201C', 0x94: '\u201D', 0x95: '\u2022', 0x96: '\u2013', 0x97: '\u2014',
  0x98: '\u02DC', 0x99: '\u2122', 0x9A: '\u0161', 0x9B: '\u203A', 0x9C: '\u0153',
  0x9E: '\u017E', 0x9F: '\u0178',
}

function decodeCp1252Byte(byte: number): string {
  if (byte >= 0x80 && byte <= 0x9f) return CP1252_HIGH_BYTES[byte] ?? ''
  return String.fromCharCode(byte)
}

const RTF_DESTINATION_KEYWORDS = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object',
  'generator', 'pgdscpush', 'rsidtbl', 'mmathPr', 'listtable',
  'listoverridetable', 'revtbl', 'fldinst',
  // NOTE: 'fldrslt' is deliberately NOT in this list. \fldinst holds a field's
  // machine instruction (e.g. `HYPERLINK "https://..."`), which is correctly
  // hidden, but \fldrslt holds the field's cached RENDERED RESULT — for a
  // hyperlink, that's the actual clickable display text the reader sees.
  // Treating it as a skippable destination silently deleted real, visible
  // document text (e.g. "Please see our website for details" would lose
  // "our website" entirely) for any RTF containing hyperlinks, page-ref
  // fields, etc. — a very common case for RTF exported from Word.
])

function stripRtfDestinations(src: string): string {
  const out: string[] = []
  let depth = 0, skipDepth = -1, i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === '{') {
      depth++
      if (skipDepth === -1) {
        const isExtended = src[i + 1] === '\\' && src[i + 2] === '*'
        if (isExtended) { skipDepth = depth; i++; continue }
        if (src[i + 1] === '\\') {
          const kwMatch = src.slice(i + 2).match(/^([a-zA-Z]+)/)
          if (kwMatch && RTF_DESTINATION_KEYWORDS.has(kwMatch[1])) { skipDepth = depth; i++; continue }
        }
      }
      if (skipDepth === -1) out.push(ch)
      i++; continue
    }
    if (ch === '}') {
      if (skipDepth !== -1 && depth === skipDepth) skipDepth = -1
      depth--
      if (skipDepth === -1) out.push(ch)
      i++; continue
    }
    if (skipDepth === -1) out.push(ch)
    i++
  }
  return out.join('')
}

function rtfToText(rtf: string): string {
  const OPEN = '\u0001', CLOSE = '\u0002', BACKSLASH = '\u0003'
  let text = rtf.replace(/\\\{/g, OPEN).replace(/\\\}/g, CLOSE).replace(/\\\\/g, BACKSLASH)
  text = stripRtfDestinations(text)
  text = text.replace(/\\par[d]?\b ?/g, '\n').replace(/\\line\b ?/g, '\n')
    .replace(/\\tab\b ?/g, '\t').replace(/\\cell\b ?/g, '\t').replace(/\\row\b ?/g, '\n')
  text = text.replace(/\\'([0-9a-fA-F]{2})/g, (_, hex) => decodeCp1252Byte(parseInt(hex, 16)))
  text = text.replace(/\\u(-?\d+)\??/g, (_, code) => {
    const n = ((parseInt(code, 10) % 65536) + 65536) % 65536
    return String.fromCharCode(n)
  })
  text = text.replace(/\\[a-zA-Z]+-?\d* ?/g, '').replace(/[{}]/g, '')
  text = text.replaceAll(OPEN, '{').replaceAll(CLOSE, '}').replaceAll(BACKSLASH, '\\')
  return text.split('\n').map(l => l.replace(/ +/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

// ── RTF output ────────────────────────────────────────────────────────────────
function textToRtf(text: string): string {
  // FIX: normalize CRLF and bare CR to LF before splitting so that Windows-encoded
  // files don't leave stray \r characters inside RTF paragraph content.
  const normalizedText = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  function encodeRtfChar(char: string): string {
    const code = char.charCodeAt(0)
    if (code < 0x80) return char
    if (code < 0x100) return `\\'${code.toString(16).padStart(2, '0')}`
    // RTF's \uN control word takes a SIGNED 16-bit integer (-32768..32767).
    // Half of the BMP (0x8000-0xFFFF) — which includes a large share of CJK
    // Unified Ideographs and ALL of Hangul — has code units above 32767, so
    // writing them unsigned produces out-of-spec files that real readers
    // (Word, LibreOffice) can misinterpret, even though our own lenient
    // decoder above tolerates either form via its modulo-based unwrap.
    const signed = code > 0x7FFF ? code - 0x10000 : code
    return `\\u${signed}?`
  }
  function encodeRtfText(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}')
      .replace(/[^\x00-\x7F]/g, encodeRtfChar)
  }
  // Join with a single space, not a literal newline: `\par` is itself the
  // complete, sufficient paragraph separator, and a single trailing space is
  // correctly swallowed as the control word's delimiter per the RTF spec ("a
  // space that immediately follows a control word is part of the control
  // word and is ignored"). Joining with an actual '\n' instead — as this
  // used to do — inserted a SECOND, literal line break that survived
  // decoding, so every line gained a spurious blank line on round trip
  // (10 lines of text would come back as 19 lines).
  const rtfParas = normalizedText.split(/\n/).map(line => `${encodeRtfText(line)}\\par`).join(' ')
  return `{\\rtf1\\ansi\\deff0\n{\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}}\n{\\colortbl ;\\red0\\green0\\blue0;}\n\\widowctrl\\hyphauto\n\\f0\\fs24\\cf1 ${rtfParas}\n}`
}

function htmlToRtf(html: string): string {
  return textToRtf(htmlToText(html))
}


const HEADING_TAGS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6']

// Core Turndown (without the separate turndown-plugin-gfm package, which
// isn't a dependency of this project) has NO table support at all — a
// <table> just falls through to the default block handling, which
// discards row/column structure entirely and dumps each cell as its own
// paragraph. For a DOCX or HTML file with any table (extremely common),
// that silently destroys the table shape rather than losing mere styling.
// This build a real GFM pipe-table from the actual DOM structure. It also
// strips <style>/<script>/<title>, since Turndown's default rules just
// convert their raw text as normal content — set free after the same
// fragment-parsing behavior htmlToText's comment above describes, a full
// HTML document's <style> text would otherwise appear as literal text at
// the top of the resulting Markdown.
// mammoth's default conversion silently drops underline and strikethrough
// formatting entirely (confirmed directly: a DOCX run with <w:u> or
// <w:strike> produces plain, unstyled <p>...</p> with no indication either
// existed). Both have a documented style-map matcher to recover them as
// real <u>/<s> tags; applied everywhere DOCX is converted to HTML below.
const MAMMOTH_STYLE_MAP = ['u => u', 'strike => s']

async function createTurndownService(options: Record<string, unknown>) {
  const TurndownService = (await import('turndown')).default
  const td = new TurndownService(options as never)
  td.remove(['style', 'script', 'title'])
  td.addRule('gfmTable', {
    filter: (node: { nodeName: string }) => node.nodeName === 'TABLE',
    replacement: (_content: string, node: unknown) => {
      const table = node as Element
      const rows = Array.from(table.querySelectorAll('tr'))
      if (rows.length === 0) return ''
      const cellText = (cell: Element) =>
        (cell.textContent ?? '').trim().replace(/\s+/g, ' ').replace(/\|/g, '\\|')
      const rowsCells = rows.map((r) => Array.from(r.children).map(cellText))
      const colCount = Math.max(...rowsCells.map((r) => r.length))
      const pad = (cells: string[]) => {
        const copy = cells.slice()
        while (copy.length < colCount) copy.push('')
        return copy
      }
      const header = pad(rowsCells[0])
      const body = rowsCells.slice(1).map(pad)
      const line = (cells: string[]) => `| ${cells.join(' | ')} |`
      const lines = [line(header), line(header.map(() => '---')), ...body.map(line)]
      return `\n\n${lines.join('\n')}\n\n`
    },
  })
  // The rows/cells themselves are read directly from the DOM in the rule
  // above, so suppress Turndown's own (table-unaware) default conversion of
  // them to avoid duplicating their text outside the generated table.
  td.addRule('gfmTableParts', {
    filter: ['thead', 'tbody', 'tfoot', 'tr', 'td', 'th'],
    replacement: () => '',
  })
  // Base Turndown has no built-in GFM strikethrough rule (confirmed: <s>
  // passes through as plain unmarked text by default) — add the standard
  // ~~text~~ syntax. Markdown has no native underline convention, so <u>
  // intentionally has no corresponding rule and continues to fall through
  // as plain text, which is the more honest result than inventing one.
  td.addRule('strikethrough', {
    filter: (node) => ['S', 'STRIKE', 'DEL'].includes(node.nodeName),
    replacement: (content: string) => `~~${content}~~`,
  })
  return td
}

// ── HTML → DOCX ───────────────────────────────────────────────────────────────
async function htmlToDocxBlob(html: string): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel,
    Table, TableRow, TableCell, WidthType, BorderStyle,
    AlignmentType, LevelFormat, ImageRun } = await import('docx')

  const headingLevelFor: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
    H1: HeadingLevel.HEADING_1, H2: HeadingLevel.HEADING_2, H3: HeadingLevel.HEADING_3,
    H4: HeadingLevel.HEADING_4, H5: HeadingLevel.HEADING_5, H6: HeadingLevel.HEADING_6,
  }

  // Collects styled runs from an element's descendants. Stops descending
  // at a nested UL/OL/TABLE — those are block-level content processList /
  // processBlock handle separately, so a nested list's items (or a nested
  // table) don't get flattened into the parent item's own paragraph with
  // no bullets, indentation, or cell structure. Also now handles <br> as an
  // explicit line break: previously it was silently skipped entirely (BR
  // has no children to recurse into), so "Line one<br>Line two" collapsed
  // to "Line oneLine two" with no break at all in the DOCX output.
  function inlineRuns(el: Element): InstanceType<typeof TextRun>[] {
    const runs: InstanceType<typeof TextRun>[] = []
    function walk(node: Node, bold: boolean, italic: boolean, underline: boolean, strike: boolean) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent ?? ''
        if (t) runs.push(new TextRun({ text: t, bold: bold || undefined, italics: italic || undefined, underline: underline ? {} : undefined, strike: strike || undefined }))
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      const tag = (node as Element).tagName
      if (tag === 'BR') { runs.push(new TextRun({ break: 1 })); return }
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
    walk(el, false, false, false, false)
    return runs.length ? runs : [new TextRun('')]
  }

  // True if `el` has any text content outside a nested UL/OL/TABLE — used
  // to decide whether a table cell containing (say) only a nested list
  // needs a plain-text fallback, since inlineRuns deliberately doesn't
  // descend into block-level content and would otherwise render that cell
  // as empty instead of showing SOMETHING.
  function hasNonBlockText(el: Element): boolean {
    for (const node of Array.from(el.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim()) return true
      if (node.nodeType === Node.ELEMENT_NODE) {
        const tag = (node as Element).tagName
        if (tag === 'UL' || tag === 'OL' || tag === 'TABLE') continue
        if (hasNonBlockText(node as Element)) return true
      }
    }
    return false
  }

  // FIX (MEDIUM): Wrap raw HTML in a container so marked() output (adjacent
  // top-level elements) is always iterable via container.children
  const container = document.createElement('div')
  container.innerHTML = html

  const cellBorder = { style: BorderStyle.SINGLE, size: 1, color: 'AAAAAA' }
  const cellBorders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const children: any[] = []

  // Renders a <ul>/<ol> at the given nesting level, recursing into any
  // nested list found as a direct child of an <li> — instead of flattening
  // a nested list's items into the parent item's own paragraph with no
  // bullets or indentation (see inlineRuns' UL/OL stop above).
  function processList(el: Element, level: number) {
    const tag = el.tagName
    const ref = tag === 'OL' ? 'numList' : 'bulletList'
    for (const li of Array.from(el.children)) {
      if (li.tagName !== 'LI') continue
      children.push(new Paragraph({ numbering: { reference: ref, level: Math.min(level, 8) }, children: inlineRuns(li) }))
      for (const nested of Array.from(li.children)) {
        if (nested.tagName === 'UL' || nested.tagName === 'OL') processList(nested, level + 1)
      }
    }
  }

  function pushImage(src: string) {
    const parsed = parseDataUriImage(src)
    if (!parsed || parsed.width <= 0 || parsed.height <= 0) return
    const maxWpx = 600 // comfortably fits within a US Letter/A4 page's margins at 96dpi
    const scale = Math.min(1, maxWpx / parsed.width)
    const w = Math.max(1, Math.round(parsed.width * scale))
    const h = Math.max(1, Math.round(parsed.height * scale))
    try {
      children.push(new Paragraph({
        children: [new ImageRun({
          data: parsed.bytes,
          transformation: { width: w, height: h },
          type: parsed.mime === 'image/png' ? 'png' : parsed.mime === 'image/gif' ? 'gif' : 'jpg',
        })],
      }))
    } catch {
      // A malformed embedded image must not fail the whole document.
    }
  }

  function processBlock(el: Element) {
    const tag = el.tagName
    if (HEADING_TAGS.includes(tag)) {
      children.push(new Paragraph({ heading: headingLevelFor[tag], children: inlineRuns(el) }))
      return
    }
    if (tag === 'P') { children.push(new Paragraph({ children: inlineRuns(el) })); return }
    // Recurse through every common semantic/generic wrapper, not just DIV —
    // real-world HTML (exported pages, ODT/DOCX-derived markup) very often
    // wraps content in <section>/<article>/<header>/etc, and without this
    // ALL of that content — headings, lists, tables, everything nested
    // inside — fell to the generic "flatten to one plain paragraph of
    // concatenated text" fallback at the bottom of this function instead.
    if (['DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'ASIDE', 'FIGURE', 'FIGCAPTION'].includes(tag)) {
      for (const child of Array.from(el.children)) processBlock(child)
      return
    }
    if (tag === 'UL' || tag === 'OL') { processList(el, 0); return }
    if (tag === 'TABLE') {
      const rows: InstanceType<typeof TableRow>[] = []
      for (const tr of Array.from(el.querySelectorAll('tr'))) {
        const cells: InstanceType<typeof TableCell>[] = []
        for (const td of Array.from(tr.children)) {
          const runs = hasNonBlockText(td) || !td.querySelector('ul, ol, table')
            ? inlineRuns(td as Element)
            : [new TextRun((td.textContent ?? '').trim())]
          cells.push(new TableCell({ borders: cellBorders, margins: { top: 60, bottom: 60, left: 100, right: 100 }, children: [new Paragraph({ children: runs })] }))
        }
        if (cells.length) rows.push(new TableRow({ children: cells }))
      }
      if (rows.length) children.push(new Table({ width: { size: 9026, type: WidthType.DXA }, rows }))
      return
    }
    if (tag === 'BLOCKQUOTE') {
      const text = el.textContent?.trim() ?? ''
      if (text) children.push(new Paragraph({ children: [new TextRun({ text, italics: true })] }))
      return
    }
    if (tag === 'PRE') {
      // Preserve line breaks and use a monospace font. Previously this fell
      // into the same branch as BLOCKQUOTE and used el.textContent directly
      // in a single TextRun — the STRING itself did keep its embedded '\n'
      // characters, but Word does not treat a literal newline inside a
      // run's text as a line break, so a multi-line code block rendered as
      // one run-together line regardless. Splitting into per-line TextRuns
      // joined by explicit `break: 1` markers is what actually produces
      // visible line breaks in the document.
      const text = (el.textContent ?? '').replace(/\n+$/, '')
      if (text.trim()) {
        const lines = text.split('\n')
        const runs: InstanceType<typeof TextRun>[] = []
        lines.forEach((line, i) => {
          if (i > 0) runs.push(new TextRun({ break: 1 }))
          runs.push(new TextRun({ text: line, font: 'Courier New' }))
        })
        children.push(new Paragraph({ children: runs }))
      }
      return
    }
    if (tag === 'IMG') { pushImage(el.getAttribute('src') ?? ''); return }
    if (tag === 'HR') {
      children.push(new Paragraph({ border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'AAAAAA', space: 1 } }, children: [new TextRun('')] }))
      return
    }
    if (tag === 'BR') { children.push(new Paragraph({ children: [new TextRun('')] })); return }
    const text = el.textContent?.trim()
    if (text) children.push(new Paragraph({ children: [new TextRun(text)] }))
  }

  for (const el of Array.from(container.children)) processBlock(el)
  if (children.length === 0) children.push(new Paragraph(''))

  const doc = new Document({
    numbering: {
      config: [
        {
          reference: 'bulletList',
          levels: [0, 1, 2, 3, 4].map((level) => ({
            level,
            format: LevelFormat.BULLET,
            text: ['\u2022', '\u25E6', '\u25AA', '\u2023', '\u2043'][level] ?? '\u2022',
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
        {
          reference: 'numList',
          levels: [0, 1, 2, 3, 4].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.LEFT,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children }],
  })
  return Packer.toBlob(doc)
}

async function plainTextToDocxBlob(text: string): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun } = await import('docx')
  // Defensive: fileToText already normalizes CRLF/BOM at the source for
  // this function's current (TXT-input) caller, but don't depend on that
  // always being true — a stray '\r' left in a paragraph's text can render
  // as a visible control-character glyph in Word.
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const paragraphs = normalized.split('\n').map(line => new Paragraph({ children: [new TextRun(line)] }))
  const doc = new Document({ sections: [{ children: paragraphs.length ? paragraphs : [new Paragraph('')] }] })
  return Packer.toBlob(doc)
}

export async function convertDocument(file: File, outputFormat: string, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted()
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''

  // ── DOCX input ──────────────────────────────────────────────────────────────
  if (ext === 'docx') {
    const mammoth = await import('mammoth')
    const arrayBuffer = await fileToArrayBuffer(file)

    if (outputFormat === 'html') {
      const { value } = await mammoth.convertToHtml({ arrayBuffer }, { styleMap: MAMMOTH_STYLE_MAP })
      const wrapped = `<!DOCTYPE html>
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
    blockquote { border-left: 3px solid #ccc; margin: 0.5em 0 0.5em 1em; padding-left: 1em; color: #555; }
    pre, code { font-family: monospace; background: #f5f5f5; padding: 2px 4px; border-radius: 2px; }
    img { max-width: 100%; }
  </style>
</head>
<body>
${value}
</body>
</html>`
      return new Blob([wrapped], { type: 'text/html' })
    }
    if (outputFormat === 'txt') {
      const { value } = await mammoth.extractRawText({ arrayBuffer })
      return new Blob([value], { type: 'text/plain' })
    }
    if (outputFormat === 'md') {
      const td = await createTurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
      const { value } = await mammoth.convertToHtml({ arrayBuffer }, { styleMap: MAMMOTH_STYLE_MAP })
      return new Blob([td.turndown(value)], { type: 'text/markdown' })
    }
    if (outputFormat === 'pdf') {
      // FIX (HIGH): use HTML-based PDF rendering to preserve formatting
      const { value } = await mammoth.convertToHtml({ arrayBuffer }, { styleMap: MAMMOTH_STYLE_MAP })
      return htmlToPdfBlob(value)
    }
    if (outputFormat === 'rtf') {
      const { value } = await mammoth.extractRawText({ arrayBuffer })
      return new Blob([textToRtf(value)], { type: 'application/rtf' })
    }
  }

  // ── Markdown input ──────────────────────────────────────────────────────────
  if (ext === 'md') {
    const { marked } = await import('marked')
    const text = await fileToText(file)
    const html = await marked(text) as string

    if (outputFormat === 'html') {
      const wrapped = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Document</title>
  <style>
    body { font-family: Georgia, serif; max-width: 800px; margin: 2rem auto; padding: 0 1.5rem; line-height: 1.7; color: #222; }
    pre { background: #f5f5f5; padding: 1em; border-radius: 4px; overflow-x: auto; }
    code { font-family: monospace; }
    table { border-collapse: collapse; } td, th { border: 1px solid #ccc; padding: 6px 10px; }
    blockquote { border-left: 3px solid #ccc; margin: 0.5em 0 0.5em 1em; padding-left: 1em; color: #555; }
  </style>
</head>
<body>
${html}
</body>
</html>`
      return new Blob([wrapped], { type: 'text/html' })
    }
    if (outputFormat === 'txt') return new Blob([htmlToText(html)], { type: 'text/plain' })
    if (outputFormat === 'pdf') return htmlToPdfBlob(html)
    if (outputFormat === 'docx') return htmlToDocxBlob(html)
    // FIX (LOW): add md→rtf path
    if (outputFormat === 'rtf') return new Blob([textToRtf(htmlToText(html))], { type: 'application/rtf' })
  }

  // ── HTML / HTM input ────────────────────────────────────────────────────────
  if (ext === 'html' || ext === 'htm') {
    const text = await fileToText(file)

    if (outputFormat === 'md') {
      const td = await createTurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
      return new Blob([td.turndown(text)], { type: 'text/markdown' })
    }
    if (outputFormat === 'txt') return new Blob([htmlToText(text)], { type: 'text/plain' })
    if (outputFormat === 'pdf') return htmlToPdfBlob(text)
    if (outputFormat === 'docx') return htmlToDocxBlob(text)
    if (outputFormat === 'rtf') return new Blob([htmlToRtf(text)], { type: 'application/rtf' })
  }

  // ── TXT input ───────────────────────────────────────────────────────────────
  if (ext === 'txt') {
    const text = await fileToText(file)

    if (outputFormat === 'html') {
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const paras = escaped.split(/\n\n+/).map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`).join('\n')
      return new Blob([`<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>Document</title>\n  <style>body{font-family:Georgia,serif;max-width:800px;margin:2rem auto;padding:0 1.5rem;line-height:1.7;color:#222}p{white-space:pre-wrap;margin:0 0 1em}</style>\n</head>\n<body>\n${paras}\n</body>\n</html>`], { type: 'text/html' })
    }
    if (outputFormat === 'md') return new Blob([text], { type: 'text/markdown' })
    if (outputFormat === 'pdf') return textToPdfBlob(text)
    if (outputFormat === 'docx') return plainTextToDocxBlob(text)
    if (outputFormat === 'rtf') return new Blob([textToRtf(text)], { type: 'application/rtf' })
  }

  // ── RTF input ───────────────────────────────────────────────────────────────
  if (ext === 'rtf') {
    const text = rtfToText(await fileToText(file, 'windows-1252'))

    if (outputFormat === 'html') {
      const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      const paras = escaped.split(/\n\n+/).map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`).join('\n')
      return new Blob([`<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>Document</title>\n  <style>body{font-family:Georgia,serif;max-width:800px;margin:2rem auto;padding:0 1.5rem;line-height:1.7;color:#222}p{white-space:pre-wrap;margin:0 0 1em}</style>\n</head>\n<body>\n${paras}\n</body>\n</html>`], { type: 'text/html' })
    }
    // FIX (LOW): RTF→MD — separate paragraphs with blank lines for proper markdown
    if (outputFormat === 'md') return new Blob([text.split('\n\n').join('\n\n')], { type: 'text/markdown' })
    if (outputFormat === 'pdf') return textToPdfBlob(text)
    if (outputFormat === 'docx') return plainTextToDocxBlob(text)
    if (outputFormat === 'txt') return new Blob([text], { type: 'text/plain' })
  }

  // ── ODT input ───────────────────────────────────────────────────────────────
  if (ext === 'odt') {
    const arrayBuffer = await fileToArrayBuffer(file)

    if (outputFormat === 'txt') {
      return new Blob([await odtToText(arrayBuffer)], { type: 'text/plain' })
    }
    if (outputFormat === 'html') {
      return new Blob([await odtToSemanticHtml(arrayBuffer)], { type: 'text/html' })
    }
    if (outputFormat === 'md') {
      // Routes through the same real <table>/<h1-6>/<strong>/<em> semantic
      // HTML (see ./odt) and the shared GFM-table-aware turndown service
      // used for HTML/DOCX→MD, instead of dumping odtToText's plain-text
      // extraction mislabeled as Markdown. Headings, bold/italic, tables,
      // and lists now survive as real Markdown syntax.
      const td = await createTurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
      const html = await odtToSemanticHtml(arrayBuffer)
      return new Blob([td.turndown(html)], { type: 'text/markdown' })
    }
    if (outputFormat === 'pdf') {
      const html = await odtToSemanticHtml(arrayBuffer)
      return htmlToPdfBlob(html)
    }
    if (outputFormat === 'docx') {
      const html = await odtToSemanticHtml(arrayBuffer)
      return htmlToDocxBlob(html)
    }
    if (outputFormat === 'rtf') {
      const text = await odtToText(arrayBuffer)
      return new Blob([textToRtf(text)], { type: 'application/rtf' })
    }
  }

  throw new Error(`No conversion path: .${ext} → .${outputFormat}`)
}