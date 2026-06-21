import { fileToArrayBuffer } from '@/lib/utils'
import * as fflate from 'fflate'

// ── Types ────────────────────────────────────────────────────────────────────
interface PdfTextItem {
  str: string
  hasEOL?: boolean
  transform?: number[]
  width?: number
  height?: number
  dir?: string
}

// ── Text extraction with proper layout reconstruction ─────────────────────────
// Reconstructs reading order by sorting items by vertical then horizontal
// position, grouping items on the same line together. This handles columnar
// PDFs much better than naive item-by-item concatenation.
async function getPdfPages(
  buffer: ArrayBuffer,
): Promise<{ pageNum: number; text: string }[]> {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise

  const pages: { pageNum: number; text: string }[] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const content = await page.getTextContent()
    const viewport = page.getViewport({ scale: 1 })
    const pageHeight = viewport.height

    // Collect all text items with their positions
    const items: Array<{ x: number; y: number; str: string; width: number; hasEOL: boolean }> = []
    for (const raw of content.items) {
      if (!('str' in (raw as object))) continue
      const item = raw as PdfTextItem
      if (!item.str) continue
      // transform is a 6-element matrix: [scaleX, skewX, skewY, scaleY, x, y]
      const transform = item.transform ?? [1, 0, 0, 1, 0, 0]
      const x = transform[4]
      const y = pageHeight - transform[5] // flip Y (PDF coords go bottom-up)
      items.push({
        x,
        y,
        str: item.str,
        width: item.width ?? 0,
        hasEOL: item.hasEOL ?? false,
      })
    }

    if (items.length === 0) {
      pages.push({ pageNum: i, text: '' })
      continue
    }

    // Sort by Y (top to bottom), then X (left to right) within each line
    items.sort((a, b) => {
      const dy = a.y - b.y
      if (Math.abs(dy) > 3) return dy // different lines
      return a.x - b.x
    })

    // Group items into lines (within 5px vertical tolerance)
    const lines: Array<Array<typeof items[0]>> = []
    let currentLine: typeof items = []
    let currentY = items[0].y

    for (const item of items) {
      if (Math.abs(item.y - currentY) > 5 && currentLine.length > 0) {
        lines.push(currentLine)
        currentLine = [item]
        currentY = item.y
      } else {
        currentLine.push(item)
        // Update currentY to average of the line
        currentY = (currentY + item.y) / 2
      }
    }
    if (currentLine.length > 0) lines.push(currentLine)

    // Reconstruct text from lines, inserting spaces between items on the same line
    const textLines: string[] = []
    for (const line of lines) {
      let lineText = ''
      for (let j = 0; j < line.length; j++) {
        const item = line[j]
        if (j === 0) {
          lineText = item.str
        } else {
          // Add a space if there's a significant gap between items
          const prev = line[j - 1]
          const gap = item.x - (prev.x + prev.width)
          if (gap > 2) lineText += ' '
          lineText += item.str
        }
      }
      const trimmed = lineText.trimEnd()
      if (trimmed) textLines.push(trimmed)
    }

    const text = textLines
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()

    pages.push({ pageNum: i, text })
  }
  return pages
}

// ── Page renderer ─────────────────────────────────────────────────────────────
async function renderPageToBlob(
  pdf: Awaited<ReturnType<typeof import('pdfjs-dist')['getDocument']>['promise']>,
  pageNum: number,
  scale: number,
  mime: 'image/png' | 'image/jpeg',
): Promise<Blob> {
  const page = await pdf.getPage(pageNum)
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(viewport.width)
  canvas.height = Math.round(viewport.height)
  const ctx = canvas.getContext('2d')!
  if (mime === 'image/jpeg') {
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
  }
  await page.render({ canvas, canvasContext: ctx, viewport }).promise
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), mime, 0.92),
  )
}

// ── Table extraction for CSV output ──────────────────────────────────────────
// Attempts to detect tabular structure by grouping text items into columns
// based on X-alignment, then outputting as CSV.
function extractTablesAsCsv(pages: { pageNum: number; text: string }[]): string {
  // Simple approach: split each line into tab-separated fields by whitespace runs
  // that indicate column boundaries. For most PDFs this gives reasonable CSV output.
  const csvRows: string[] = []
  for (const page of pages) {
    if (!page.text) continue
    const lines = page.text.split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      // Split on 2+ spaces (likely column separators in fixed-width tables)
      const cells = line.split(/  +/).map(c => c.trim()).filter(Boolean)
      if (cells.length > 1) {
        // Looks like a table row — CSV-encode each cell
        const csvLine = cells.map(c =>
          (c.includes(',') || c.includes('"') || c.includes('\n'))
            ? `"${c.replace(/"/g, '""')}"`
            : c
        ).join(',')
        csvRows.push(csvLine)
      } else if (cells.length === 1) {
        csvRows.push(cells[0])
      }
    }
  }
  return csvRows.join('\n')
}

export async function convertPdf(file: File, outputFormat: string): Promise<Blob> {
  const buffer = await fileToArrayBuffer(file)

  // ── Text ──────────────────────────────────────────────────────────────────
  if (outputFormat === 'txt') {
    const pages = await getPdfPages(buffer)
    const out = pages.map((p) =>
      `--- Page ${p.pageNum} ---\n${p.text || '(no extractable text on this page)'}`
    ).join('\n\n')
    return new Blob([out], { type: 'text/plain' })
  }

  // ── CSV ────────────────────────────────────────────────────────────────────
  if (outputFormat === 'csv') {
    const pages = await getPdfPages(buffer)
    const csv = extractTablesAsCsv(pages)
    return new Blob([csv || 'No table data found'], { type: 'text/csv' })
  }

  // ── HTML ──────────────────────────────────────────────────────────────────
  if (outputFormat === 'html') {
    const pages = await getPdfPages(buffer)
    const esc = (s: string) =>
      s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

    const body = pages
      .map((p) => {
        const bodyHtml = p.text
          ? p.text
            .split(/\n\n+/)
            .map((para) => `    <p>${esc(para.replace(/\n/g, '<br>'))}</p>`)
            .join('\n')
          : '    <p><em>(no extractable text on this page)</em></p>'
        return `  <section class="page">
    <h2>Page ${p.pageNum}</h2>
${bodyHtml}
  </section>`
      })
      .join('\n')

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${esc(file.name)}</title>
  <style>
    body { font-family: Georgia, serif; max-width: 800px; margin: 2rem auto; padding: 0 1.5rem; line-height: 1.7; color: #222; }
    h2 { font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; color: #888; margin-bottom: 0.4rem; }
    .page { border-bottom: 1px solid #e5e5e5; padding-bottom: 2rem; margin-bottom: 2rem; }
    .page:last-child { border-bottom: none; }
    p { margin: 0 0 0.8em; }
  </style>
</head>
<body>
${body}
</body>
</html>`
    return new Blob([html], { type: 'text/html' })
  }

  // ── Markdown ───────────────────────────────────────────────────────────────
  if (outputFormat === 'md') {
    const pages = await getPdfPages(buffer)
    const md = pages
      .map((p) => {
        const body = p.text
          ? p.text
            .split(/\n\n+/)
            .map((para) => para.replace(/\n/g, ' ').trim())
            .filter(Boolean)
            .join('\n\n')
          : '*(no extractable text on this page)*'
        return `## Page ${p.pageNum}\n\n${body}`
      })
      .join('\n\n---\n\n')
    return new Blob([md], { type: 'text/markdown' })
  }

  // ── DOCX ───────────────────────────────────────────────────────────────────
  // Strategy: try text extraction first. If text is found, produce a clean
  // text-based DOCX. If text extraction yields nothing (scanned/image PDF),
  // fall back to rendering pages as images embedded in DOCX.
  if (outputFormat === 'docx') {
    const { Document, Packer, Paragraph, TextRun, HeadingLevel, ImageRun, PageBreak, AlignmentType } = await import('docx')
    const pdfjsLib = await import('pdfjs-dist')
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise

    // First, try text extraction
    const pages = await getPdfPages(buffer)
    const totalText = pages.map(p => p.text).join('')

    if (totalText.trim().length > 50) {
      // ── Text-based DOCX ──────────────────────────────────────────────────
      // We have real text — produce a proper text document
      const children: (InstanceType<typeof Paragraph>)[] = []

      for (const page of pages) {
        if (page.pageNum > 1) {
          children.push(new Paragraph({ children: [new PageBreak()] }))
        }

        if (!page.text) {
          children.push(new Paragraph({
            children: [new TextRun({ text: '(no extractable text on this page)', italics: true })],
          }))
          continue
        }

        const paragraphs = page.text.split(/\n\n+/)
        for (const para of paragraphs) {
          const lines = para.split('\n')
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed) continue

            // Simple heuristic: ALL CAPS short lines → heading
            const isHeading = trimmed === trimmed.toUpperCase() && trimmed.length < 80 && trimmed.length > 2
            if (isHeading) {
              children.push(new Paragraph({
                heading: HeadingLevel.HEADING_2,
                children: [new TextRun(trimmed)],
              }))
            } else {
              children.push(new Paragraph({
                children: [new TextRun(trimmed)],
              }))
            }
          }
        }
      }

      if (children.length === 0) children.push(new Paragraph(''))

      const doc = new Document({ sections: [{ children }] })
      return Packer.toBlob(doc)
    }

    // ── Image-based DOCX (fallback for scanned/image-only PDFs) ─────────────
    const SCALE = 1.5
    const children2: (InstanceType<typeof Paragraph>)[] = []

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i)
      const viewport = page.getViewport({ scale: SCALE })

      const canvas = document.createElement('canvas')
      canvas.width = Math.round(viewport.width)
      canvas.height = Math.round(viewport.height)
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvas, canvasContext: ctx, viewport }).promise

      const pngBlob: Blob = await new Promise((res, rej) =>
        canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'),
      )
      const pngData = new Uint8Array(await pngBlob.arrayBuffer())

      const contentWidthEmu = 5_715_450
      const aspectRatio = canvas.height / canvas.width
      const imgWidthEmu = contentWidthEmu
      const imgHeightEmu = Math.round(contentWidthEmu * aspectRatio)

      children2.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new ImageRun({
              data: pngData,
              transformation: {
                width: Math.round(imgWidthEmu / 9525),
                height: Math.round(imgHeightEmu / 9525),
              },
              type: 'png',
            }),
          ],
        }),
      )

      if (i < pdf.numPages) {
        children2.push(new Paragraph({ children: [new PageBreak()] }))
      }
    }

    const doc = new Document({
      sections: [{
        properties: {
          page: {
            size: { width: 11906, height: 16838 },
            margin: { top: 720, right: 720, bottom: 720, left: 720 },
          },
        },
        children: children2,
      }],
    })
    return Packer.toBlob(doc)
  }

  // ── PNG / JPEG (render pages) ──────────────────────────────────────────────
  if (outputFormat === 'png' || outputFormat === 'jpeg') {
    const pdfjsLib = await import('pdfjs-dist')
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise
    const mime = outputFormat === 'png' ? 'image/png' : 'image/jpeg'

    if (pdf.numPages === 1) return renderPageToBlob(pdf, 1, 2, mime)

    const zipInput: Record<string, Uint8Array> = {}
    for (let i = 1; i <= pdf.numPages; i++) {
      const blob = await renderPageToBlob(pdf, i, 2, mime)
      zipInput[`page-${String(i).padStart(3, '0')}.${outputFormat}`] = new Uint8Array(
        await blob.arrayBuffer(),
      )
    }
    return new Blob([fflate.zipSync(zipInput, { level: 6 })], { type: 'application/zip' })
  }

  throw new Error(`Unsupported PDF output: .${outputFormat}`)
}