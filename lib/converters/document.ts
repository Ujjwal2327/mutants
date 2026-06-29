import { fileToText, fileToArrayBuffer } from '@/lib/utils'

function htmlToText(html: string): string {
  const div = document.createElement('div')
  div.innerHTML = html
  return div.textContent ?? ''
}

// ── PDF output ────────────────────────────────────────────────────────────────
// FIX (HIGH): Previously used htmlToText() stripping all formatting before
// rendering to PDF. Now renders styled HTML directly via an off-screen iframe
// so headings, bold, tables, lists are all preserved.
async function htmlToPdfBlob(html: string): Promise<Blob> {
  const { jsPDF } = await import('jspdf')

  // Full styled HTML document
  const fullHtml = html.startsWith('<!DOCTYPE') || html.startsWith('<html')
    ? html
    : `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
        body{font-family:Georgia,serif;font-size:11pt;line-height:1.6;color:#222;margin:15mm}
        h1{font-size:18pt;margin:0.8em 0 0.4em}h2{font-size:14pt;margin:0.7em 0 0.3em}
        h3{font-size:12pt;margin:0.6em 0 0.3em}
        p{margin:0 0 0.6em}ul,ol{margin:0.4em 0 0.4em 1.5em}
        table{border-collapse:collapse;width:100%;margin:0.5em 0}
        td,th{border:1px solid #ccc;padding:4px 8px;font-size:10pt}
        th{background:#f0f0f0;font-weight:bold}
        pre,code{font-family:monospace;font-size:10pt;background:#f5f5f5;padding:2px 4px}
        blockquote{border-left:3px solid #ccc;margin:0.4em 0 0.4em 1em;padding-left:0.8em;color:#555}
      </style></head><body>${html}</body></html>`

  // Use jsPDF html() method which renders HTML properly
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })

  return new Promise((resolve, reject) => {
    doc.html(fullHtml, {
      callback: (d) => resolve(d.output('blob')),
      x: 0,
      y: 0,
      width: 210,
      windowWidth: 794, // A4 at 96dpi
      autoPaging: 'text',
    })
  }).catch(() => {
    // Fallback: plain text if html() fails (e.g. in test environments)
    const text = htmlToText(fullHtml)
    const doc2 = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
    doc2.setFontSize(11)
    const pageHeight = doc2.internal.pageSize.getHeight()
    const marginTop = 15, marginBottom = 15, lineHeight = 6
    const lines = doc2.splitTextToSize(text, 180) as string[]
    let y = marginTop
    for (const line of lines) {
      if (y + lineHeight > pageHeight - marginBottom) { doc2.addPage(); y = marginTop }
      doc2.text(line, 15, y)
      y += lineHeight
    }
    return doc2.output('blob')
  })
}

// Keep plain-text PDF as fallback for txt/rtf inputs where no HTML is available
async function textToPdfBlob(text: string): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' })
  doc.setFontSize(11)
  const pageHeight = doc.internal.pageSize.getHeight()
  const marginTop = 15, marginBottom = 15, lineHeight = 6
  const maxY = pageHeight - marginBottom
  const lines = doc.splitTextToSize(text, 180) as string[]
  let y = marginTop
  for (const line of lines) {
    if (y + lineHeight > maxY) { doc.addPage(); y = marginTop }
    doc.text(line, 15, y)
    y += lineHeight
  }
  return doc.output('blob')
}

// ── RTF helpers ───────────────────────────────────────────────────────────────
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
  'listoverridetable', 'revtbl', 'fldinst', 'fldrslt',
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
    return `\\u${code}?`
  }
  function encodeRtfText(str: string): string {
    return str.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}')
      .replace(/[^\x00-\x7F]/g, encodeRtfChar)
  }
  const rtfParas = normalizedText.split(/\n/).map(line => `${encodeRtfText(line)}\\par`).join('\n')
  return `{\\rtf1\\ansi\\deff0\n{\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}}\n{\\colortbl ;\\red0\\green0\\blue0;}\n\\widowctrl\\hyphauto\n\\f0\\fs24\\cf1 ${rtfParas}\n}`
}

function htmlToRtf(html: string): string {
  return textToRtf(htmlToText(html))
}

const HEADING_TAGS = ['H1', 'H2', 'H3', 'H4', 'H5', 'H6']

// ── HTML → DOCX ───────────────────────────────────────────────────────────────
async function htmlToDocxBlob(html: string): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel,
    Table, TableRow, TableCell, WidthType, BorderStyle,
    AlignmentType, LevelFormat } = await import('docx')

  const headingLevelFor: Record<string, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
    H1: HeadingLevel.HEADING_1, H2: HeadingLevel.HEADING_2, H3: HeadingLevel.HEADING_3,
    H4: HeadingLevel.HEADING_4, H5: HeadingLevel.HEADING_5, H6: HeadingLevel.HEADING_6,
  }

  function inlineRuns(el: Element): InstanceType<typeof TextRun>[] {
    const runs: InstanceType<typeof TextRun>[] = []
    function walk(node: Node, bold: boolean, italic: boolean, underline: boolean) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = node.textContent ?? ''
        if (t) runs.push(new TextRun({ text: t, bold: bold || undefined, italics: italic || undefined, underline: underline ? {} : undefined }))
        return
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return
      const tag = (node as Element).tagName
      for (const child of Array.from(node.childNodes)) {
        walk(child, bold || tag === 'STRONG' || tag === 'B', italic || tag === 'EM' || tag === 'I', underline || tag === 'U')
      }
    }
    walk(el, false, false, false)
    return runs.length ? runs : [new TextRun('')]
  }

  // FIX (MEDIUM): Wrap raw HTML in a container so marked() output (adjacent
  // top-level elements) is always iterable via container.children
  const container = document.createElement('div')
  container.innerHTML = html

  const cellBorder = { style: BorderStyle.SINGLE, size: 1, color: 'AAAAAA' }
  const cellBorders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const children: any[] = []

  function processBlock(el: Element) {
    const tag = el.tagName
    if (HEADING_TAGS.includes(tag)) {
      children.push(new Paragraph({ heading: headingLevelFor[tag], children: inlineRuns(el) }))
      return
    }
    if (tag === 'P') { children.push(new Paragraph({ children: inlineRuns(el) })); return }
    if (tag === 'DIV') { for (const child of Array.from(el.children)) processBlock(child); return }
    if (tag === 'UL' || tag === 'OL') {
      const ref = tag === 'OL' ? 'numList' : 'bulletList'
      for (const li of Array.from(el.querySelectorAll(':scope > li'))) {
        children.push(new Paragraph({ numbering: { reference: ref, level: 0 }, children: inlineRuns(li as Element) }))
      }
      return
    }
    if (tag === 'TABLE') {
      const rows: InstanceType<typeof TableRow>[] = []
      for (const tr of Array.from(el.querySelectorAll('tr'))) {
        const cells: InstanceType<typeof TableCell>[] = []
        for (const td of Array.from(tr.children)) {
          cells.push(new TableCell({ borders: cellBorders, margins: { top: 60, bottom: 60, left: 100, right: 100 }, children: [new Paragraph({ children: inlineRuns(td as Element) })] }))
        }
        if (cells.length) rows.push(new TableRow({ children: cells }))
      }
      if (rows.length) children.push(new Table({ width: { size: 9026, type: WidthType.DXA }, rows }))
      return
    }
    if (tag === 'BLOCKQUOTE' || tag === 'PRE') {
      const text = el.textContent?.trim() ?? ''
      if (text) children.push(new Paragraph({ children: [new TextRun({ text, italics: true })] }))
      return
    }
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
        { reference: 'bulletList', levels: [{ level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
        { reference: 'numList', levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }] },
      ],
    },
    sections: [{ children }],
  })
  return Packer.toBlob(doc)
}

async function plainTextToDocxBlob(text: string): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun } = await import('docx')
  const paragraphs = text.split('\n').map(line => new Paragraph({ children: [new TextRun(line)] }))
  const doc = new Document({ sections: [{ children: paragraphs.length ? paragraphs : [new Paragraph('')] }] })
  return Packer.toBlob(doc)
}

// ── ODT helpers ───────────────────────────────────────────────────────────────
async function odtToText(buffer: ArrayBuffer): Promise<string> {
  const { unzipSync } = await import('fflate')
  const files = unzipSync(new Uint8Array(buffer))
  const contentXml = files['content.xml']
  if (!contentXml) throw new Error('Not a valid ODT file — content.xml not found')
  const xmlText = new TextDecoder().decode(contentXml)
  const div = document.createElement('div')
  div.innerHTML = xmlText
    .replace(/<text:line-break[^>]*>/gi, '\n')
    .replace(/<text:p[^>]*>/gi, '\n')
    .replace(/<text:h[^>]*>/gi, '\n')
    .replace(/<\/text:p>/gi, '\n')
    .replace(/<\/text:h>/gi, '\n')
  return (div.textContent ?? '').split('\n').map(l => l.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

async function odtToHtml(buffer: ArrayBuffer): Promise<string> {
  const text = await odtToText(buffer)
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const paras = escaped.split(/\n\n+/).map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`).join('\n')
  return `<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="UTF-8">\n  <title>Document</title>\n  <style>\n    body { font-family: Georgia, serif; max-width: 800px; margin: 2rem auto; padding: 0 1.5rem; line-height: 1.7; color: #222; }\n    p { white-space: pre-wrap; margin: 0 0 1em; }\n  </style>\n</head>\n<body>\n${paras}\n</body>\n</html>`
}

export async function convertDocument(file: File, outputFormat: string): Promise<Blob> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''

  // ── DOCX input ──────────────────────────────────────────────────────────────
  if (ext === 'docx') {
    const mammoth = await import('mammoth')
    const arrayBuffer = await fileToArrayBuffer(file)

    if (outputFormat === 'html') {
      const { value } = await mammoth.convertToHtml({ arrayBuffer })
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
      const TurndownService = (await import('turndown')).default
      const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
      const { value } = await mammoth.convertToHtml({ arrayBuffer })
      return new Blob([td.turndown(value)], { type: 'text/markdown' })
    }
    if (outputFormat === 'pdf') {
      // FIX (HIGH): use HTML-based PDF rendering to preserve formatting
      const { value } = await mammoth.convertToHtml({ arrayBuffer })
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
    const TurndownService = (await import('turndown')).default
    const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
    const text = await fileToText(file)

    if (outputFormat === 'md') return new Blob([td.turndown(text)], { type: 'text/markdown' })
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
      return new Blob([await odtToHtml(arrayBuffer)], { type: 'text/html' })
    }
    if (outputFormat === 'md') {
      return new Blob([await odtToText(arrayBuffer)], { type: 'text/markdown' })
    }
    if (outputFormat === 'pdf') {
      const html = await odtToHtml(arrayBuffer)
      return htmlToPdfBlob(html)
    }
    // FIX (HIGH): ODT→DOCX previously used plainTextToDocxBlob losing all structure.
    // Now routes through odtToHtml→htmlToDocxBlob preserving paragraphs and structure.
    if (outputFormat === 'docx') {
      const html = await odtToHtml(arrayBuffer)
      return htmlToDocxBlob(html)
    }
    // FIX (LOW): add odt→rtf path
    if (outputFormat === 'rtf') {
      const text = await odtToText(arrayBuffer)
      return new Blob([textToRtf(text)], { type: 'application/rtf' })
    }
  }

  throw new Error(`No conversion path: .${ext} → .${outputFormat}`)
}