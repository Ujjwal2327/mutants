import { fileToArrayBuffer } from '@/lib/utils'
import * as fflate from 'fflate'

// ── Types ─────────────────────────────────────────────────────────────────────
interface PdfTextItem {
  str: string
  hasEOL?: boolean
  transform?: number[]
  width?: number
  height?: number
  dir?: string
}

interface TextWord {
  x: number
  y: number
  str: string
  width: number
}

interface TableRow {
  sno: string
  date: string
  cheque: string
  remarks: string
  withdrawal: string
  deposit: string
  balance: string
}

// ── Noise detection ───────────────────────────────────────────────────────────
// Test the ENTIRE visual row text — if any pattern matches, skip the whole row.
const NOISE_ROW_PATTERNS: RegExp[] = [
  /www\.[a-z]+\.bank\.in/i,
  /Dial your Bank/i,
  /Please call from your registered/i,
  /Never share your OTP/i,
  /This is a system generated/i,
  /Legends for transactions/i,
  /RCHG\s*-\s*Recharge/i,
  /PAVC\s*-\s*Pay any Visa/i,
  /SMO\s*-\s*Smart Money/i,
  /VPS\/IPS\s*-\s*Debit/i,
  /does not require any signature/i,
  /Sincerely,/i,
  /Team ICICI/i,
  /1800-1080/i,
  /NEFT\s*-\s*National Electronics/i,
  /IMPS\s*-\s*Immediate Payment/i,
  /MMT\s*-\s*Mobile Money/i,
  /BIL\s*-\s*Internet Bill/i,
  /BBPS\s*-\s*Bharat Bill/i,
]

function isNoiseRow(rowText: string): boolean {
  if (!rowText.trim()) return true
  for (const p of NOISE_ROW_PATTERNS) {
    if (p.test(rowText)) return true
  }
  return false
}

// A row whose entire content is just 1–3 digits = page number
function isPageNumberRow(rowText: string): boolean {
  return /^\s*\d{1,3}\s*$/.test(rowText)
}

// Column header rows repeated on every page of bank statement PDFs.
// pdfjs splits the two-line header cells into separate visual rows, so we
// must catch ALL possible fragment combinations:
//
//  Full row 1: "S No. Transaction Date Cheque Number Transaction Remarks Withdrawal Deposit Balance"
//  Full row 2: "Amount (INR) Amount (INR) (INR)"
//
//  Or partial splits: "Withdrawal Deposit Balance", "Date Cheque Number", etc.
//
// Strategy: if the row contains ONLY known header vocabulary words (no real
// data like a date, amount, or UPI path), treat it as a header row.
const HEADER_VOCAB = new Set([
  's', 'no', 'no.', 's.no', 'transaction', 'date', 'cheque', 'number',
  'remarks', 'withdrawal', 'deposit', 'balance', 'amount', '(inr)', 'inr',
])

function isColumnHeaderRow(rowText: string): boolean {
  const t = rowText.trim()
  if (!t) return true

  // Fast path: multiple key column names present together
  if ((t.includes('S No') || t.includes('S.No')) && t.includes('Date') && t.includes('Balance')) return true
  if (t.includes('Transaction') && t.includes('Cheque') && t.includes('Withdrawal')) return true
  if (t.includes('Withdrawal') && t.includes('Deposit') && t.includes('Balance')) return true
  if (t.includes('Withdrawal') && t.includes('Amount') && t.includes('INR')) return true
  if (t.includes('Deposit') && t.includes('Amount') && t.includes('INR')) return true

  // Vocabulary check: row contains ONLY header words — catches any partial
  // fragment like "Amount (INR) Amount (INR) (INR)" or "Withdrawal Deposit Balance"
  const words = t.toLowerCase().replace(/[()]/g, ' ').split(/\s+/).filter(Boolean)
  if (words.length > 0 && words.every(w => HEADER_VOCAB.has(w))) return true

  // Single-token header fragments
  if (/^\s*(Cheque Number|Transaction Remarks|Transaction Date|S No\.?)\s*$/.test(t)) return true
  if (/^\s*\(INR\)\s*$/.test(t)) return true
  if (/^\s*(Withdrawal|Deposit|Balance)\s*$/.test(t)) return true
  if (/^\s*(Amount \(INR\)|Transaction Remarks)\s*$/.test(t)) return true

  return false
}

// Strip noise appended inside remarks strings
const NOISE_SUFFIX_PATTERNS: RegExp[] = [
  /\s*www\.[a-z]+\.bank\.in.*/i,
  /\s*Dial your Bank.*/i,
  /\s*Please call from.*/i,
  /\s*Never share your OTP.*/i,
  /\s*call from your registered.*/i,
  /\s*does not require any.*/i,
  /\s*Legends for transactions.*/i,
  /\s*RCHG\s*-\s*Recharge.*/i,
  /\s*1800-1080.*/i,
]

function stripNoiseFromRemarks(text: string): string {
  for (const p of NOISE_SUFFIX_PATTERNS) {
    text = text.replace(p, '')
  }
  return text.replace(/\s+/g, ' ').trim()
}

// ── Extract positioned words from one PDF page ────────────────────────────────
async function getPageWords(
  page: Awaited<ReturnType<
    Awaited<ReturnType<typeof import('pdfjs-dist')['getDocument']>['promise']>['getPage']
  >>,
): Promise<TextWord[]> {
  const content = await page.getTextContent()
  const viewport = page.getViewport({ scale: 1 })
  const pageHeight = viewport.height
  const words: TextWord[] = []
  for (const raw of content.items) {
    if (!('str' in (raw as object))) continue
    const item = raw as PdfTextItem
    if (!item.str?.trim()) continue
    const transform = item.transform ?? [1, 0, 0, 1, 0, 0]
    words.push({
      x: transform[4],
      y: pageHeight - transform[5],
      str: item.str,
      width: item.width ?? 0,
    })
  }
  return words
}

// ── Group words into visual rows by Y proximity ───────────────────────────────
function groupIntoRows(words: TextWord[], yTolerance = 4): TextWord[][] {
  if (words.length === 0) return []
  const sorted = [...words].sort((a, b) => a.y - b.y)
  const rows: TextWord[][] = []
  let current: TextWord[] = [sorted[0]]
  let currentY = sorted[0].y
  for (let i = 1; i < sorted.length; i++) {
    if (Math.abs(sorted[i].y - currentY) > yTolerance) {
      rows.push(current)
      current = [sorted[i]]
      currentY = sorted[i].y
    } else {
      current.push(sorted[i])
      currentY = (currentY + sorted[i].y) / 2
    }
  }
  if (current.length > 0) rows.push(current)
  return rows
}

// ── Column boundary detection ─────────────────────────────────────────────────
interface ColBounds {
  snoMax: number
  dateMax: number
  chequeMax: number
  remarksMax: number
  withdrawalMax: number
  depositMax: number
}

function detectColumns(allWords: TextWord[]): ColBounds | null {
  if (allWords.length === 0) return null
  // Detect financial table by presence of decimal amounts in right columns
  const amountRe = /^\d[\d,]*\.\d{2}$/
  const amountWords = allWords.filter(w => w.x > 300 && amountRe.test(w.str))
  if (amountWords.length < 5) return null

  const pageWidth = Math.max(...allWords.map(w => w.x + (w.width || 0)))
  const s = pageWidth / 595 // scale relative to A4 width

  return {
    snoMax: 55 * s,
    dateMax: 125 * s,
    chequeMax: 188 * s,
    remarksMax: 372 * s,
    withdrawalMax: 452 * s,
    depositMax: 518 * s,
  }
}

function classifyX(x: number, cols: ColBounds): keyof TableRow {
  if (x < cols.snoMax) return 'sno'
  if (x < cols.dateMax) return 'date'
  if (x < cols.chequeMax) return 'cheque'
  if (x < cols.remarksMax) return 'remarks'
  if (x < cols.withdrawalMax) return 'withdrawal'
  if (x < cols.depositMax) return 'deposit'
  return 'balance'
}

// ── Short alias label detection ───────────────────────────────────────────────
// ICICI bank statement PDFs render a short alias (e.g. "9618907961@ybl",
// "Ujjwal Mah") ABOVE each transaction. This line must not be appended to the
// previous transaction — it belongs to the next one and is discarded since the
// full UPI path already contains it.
const REMARKS_PATH_PREFIXES = ['UPI/', 'MMT/', 'NEFT/', 'BIL/', 'RCHG/', 'IMPS/', 'INF/', 'EBA/', 'CMS/']

function startsWithPath(text: string): boolean {
  const t = text.trimStart()
  return REMARKS_PATH_PREFIXES.some(p => t.startsWith(p))
}

function isShortLabel(text: string): boolean {
  const t = text.trim()
  if (startsWithPath(t)) return false
  if (t.length > 50) return false
  // Max 3 words — rules out "TATA CONSULTANCY SERVICES LIMITED"
  if (t.split(' ').length > 3) return false
  // Exclude NEFT-style refs: long strings with multiple hyphens and digits
  if (/[A-Z0-9]{8,}-[A-Z0-9]{4,}/.test(t)) return false
  return /^[A-Za-z0-9@._\-\s]{1,50}$/.test(t)
}

// ── Split merged amounts ──────────────────────────────────────────────────────
// pdfjs sometimes returns deposit+balance as one text item: "1.00 31569.00"
function splitMergedAmounts(str: string): string[] {
  const parts = str.trim().split(/\s+/)
  const amountRe = /^\d[\d,]*\.\d{2}$/
  if (parts.length === 2 && parts.every(p => amountRe.test(p))) {
    return parts
  }
  return [str]
}

// ── Main table extraction ─────────────────────────────────────────────────────
async function extractTableRows(
  pdf: Awaited<ReturnType<typeof import('pdfjs-dist')['getDocument']>['promise']>,
): Promise<TableRow[]> {
  const allPageWords: TextWord[][] = []
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    allPageWords.push(await getPageWords(page))
  }

  const cols = detectColumns(allPageWords.flat())
  if (!cols) return []

  const rows: TableRow[] = []
  let current: TableRow | null = null
  let pendingLabel: string | null = null

  for (const pageWords of allPageWords) {
    const visualRows = groupIntoRows(pageWords)

    for (const vRow of visualRows) {
      const sortedWords = [...vRow].sort((a, b) => a.x - b.x)
      const rowText = sortedWords.map(w => w.str).join(' ')

      // Skip noise rows, page numbers, and column header rows (including
      // partial header fragments that appear on pages 2+)
      if (isNoiseRow(rowText)) continue
      if (isPageNumberRow(rowText)) continue
      if (isColumnHeaderRow(rowText)) continue

      // Classify each word into its column
      const colData: Record<keyof TableRow, string[]> = {
        sno: [], date: [], cheque: [], remarks: [],
        withdrawal: [], deposit: [], balance: [],
      }
      for (const w of sortedWords) {
        colData[classifyX(w.x, cols)].push(w.str)
      }

      const sno = colData.sno.join(' ').trim()
      const date = colData.date.join(' ').trim()
      const cheque = colData.cheque.join(' ').trim()
      const remarksRaw = colData.remarks.join(' ').trim()
      const withdrawalRaw = colData.withdrawal.join(' ').trim()
      const depositRaw = colData.deposit.join(' ').trim()
      const balanceRaw = colData.balance.join(' ').trim()

      // Fix merged amounts: "1.00 31569.00" → deposit="1.00", balance="31569.00"
      let withdrawal = withdrawalRaw
      let deposit = depositRaw
      let balance = balanceRaw

      if (!balance && deposit) {
        const split = splitMergedAmounts(deposit)
        if (split.length === 2) { deposit = split[0]; balance = split[1] }
      }
      if (!balance && withdrawal) {
        const split = splitMergedAmounts(withdrawal)
        if (split.length === 2) { withdrawal = split[0]; balance = split[1] }
      }
      // When withdrawal col has deposit+balance merged and withdrawal already set
      if (!deposit && !balance && withdrawal && current?.withdrawal) {
        const split = splitMergedAmounts(withdrawal)
        if (split.length === 2) { deposit = split[0]; balance = split[1]; withdrawal = '' }
      }

      // New transaction row: integer S.No + date
      if (/^\d+$/.test(sno) && /^\d{2}[./]\d{2}[./]\d{4}$/.test(date)) {
        if (current) rows.push(current)
        pendingLabel = null
        current = { sno, date, cheque, remarks: remarksRaw, withdrawal, deposit, balance }
        continue
      }

      // Orphan short-label row (alias for the NEXT transaction — discard it)
      if (!sno && !date && !withdrawal && !deposit && !balance && remarksRaw) {
        if (isShortLabel(remarksRaw)) {
          pendingLabel = remarksRaw
          continue
        }
      }

      // Continuation row: append to current transaction
      if (current !== null) {
        pendingLabel = null
        if (remarksRaw && !isShortLabel(remarksRaw)) {
          current.remarks += ' ' + remarksRaw
        }
        if (withdrawal && !current.withdrawal) current.withdrawal = withdrawal
        if (deposit && !current.deposit) current.deposit = deposit
        if (balance && !current.balance) current.balance = balance
        if (cheque && !current.cheque) current.cheque = cheque
      }
    }
  }
  if (current) rows.push(current)

  // Final clean-up
  for (const row of rows) {
    row.remarks = stripNoiseFromRemarks(row.remarks)
    row.withdrawal = row.withdrawal.trim()
    row.deposit = row.deposit.trim()
    row.balance = row.balance.trim()
    row.cheque = row.cheque.trim()
  }

  return rows
}

// ── Plain text extraction (non-table PDFs) ────────────────────────────────────
async function getPdfPages(
  buffer: ArrayBuffer,
): Promise<{ pageNum: number; text: string }[]> {
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) }).promise
  const pages: { pageNum: number; text: string }[] = []

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i)
    const words = await getPageWords(page)
    if (words.length === 0) { pages.push({ pageNum: i, text: '' }); continue }

    const visualRows = groupIntoRows(words)
    const textLines: string[] = []

    for (const row of visualRows) {
      const rowText = row.map(w => w.str).join(' ')
      if (isNoiseRow(rowText) || isPageNumberRow(rowText)) continue
      const sorted = [...row].sort((a, b) => a.x - b.x)
      let lineText = ''
      for (let j = 0; j < sorted.length; j++) {
        if (j === 0) { lineText = sorted[j].str; continue }
        const gap = sorted[j].x - (sorted[j - 1].x + sorted[j - 1].width)
        lineText += (gap > 2 ? ' ' : '') + sorted[j].str
      }
      const trimmed = lineText.trimEnd()
      if (trimmed) textLines.push(trimmed)
    }

    pages.push({ pageNum: i, text: textLines.join('\n').replace(/\n{3,}/g, '\n\n').trim() })
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
  if (mime === 'image/jpeg') { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height) }
  await page.render({ canvas, canvasContext: ctx, viewport }).promise
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), mime, 0.92))
}

// ── Output formatters ─────────────────────────────────────────────────────────
function rowsToCsv(rows: TableRow[]): string {
  const header = ['S.No', 'Date', 'Cheque Number', 'Transaction Remarks', 'Withdrawal (INR)', 'Deposit (INR)', 'Balance (INR)']
  const esc = (s: string) => (s.includes(',') || s.includes('"') || s.includes('\n')) ? `"${s.replace(/"/g, '""')}"` : s
  return [header.map(esc).join(','), ...rows.map(r =>
    [r.sno, r.date, r.cheque, r.remarks, r.withdrawal, r.deposit, r.balance].map(esc).join(',')
  )].join('\n')
}

function rowsToHtml(rows: TableRow[], filename: string): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const tableRows = rows.map(r =>
    `      <tr>
        <td>${esc(r.sno)}</td>
        <td class="nowrap">${esc(r.date)}</td>
        <td>${esc(r.cheque)}</td>
        <td class="remarks">${esc(r.remarks)}</td>
        <td class="${r.withdrawal ? 'withdrawal' : 'amt'}">${esc(r.withdrawal)}</td>
        <td class="${r.deposit ? 'deposit' : 'amt'}">${esc(r.deposit)}</td>
        <td class="balance">${esc(r.balance)}</td>
      </tr>`
  ).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${esc(filename)}</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:Arial,sans-serif;font-size:12px;color:#222;background:#f0f0f0;padding:20px}
    h1{font-size:16px;color:#333;margin-bottom:16px}
    .wrap{overflow-x:auto;background:#fff;border-radius:6px;border:1px solid #ddd}
    table{width:100%;border-collapse:collapse;font-size:11.5px}
    thead th{background:#1a1a2e;color:#fff;padding:9px 10px;text-align:left;position:sticky;top:0;z-index:1}
    thead th:nth-child(5),thead th:nth-child(6),thead th:nth-child(7){text-align:right}
    tbody tr{border-bottom:1px solid #f2f2f2}
    tbody tr:nth-child(even){background:#fafafa}
    tbody tr:hover{background:#fff8f8}
    tbody td{padding:7px 10px;vertical-align:top}
    td.nowrap{white-space:nowrap}
    td.remarks{font-size:10px;color:#666;word-break:break-all;max-width:360px;line-height:1.4}
    td.withdrawal{text-align:right;color:#c8102e;font-weight:600}
    td.deposit{text-align:right;color:#1b7a34;font-weight:600}
    td.amt{text-align:right}
    td.balance{text-align:right;font-weight:700}
  </style>
</head>
<body>
  <h1>${esc(filename)}</h1>
  <div class="wrap">
    <table>
      <thead>
        <tr>
          <th>S.No</th><th>Date</th><th>Cheque No.</th>
          <th>Transaction Remarks</th>
          <th>Withdrawal (INR)</th><th>Deposit (INR)</th><th>Balance (INR)</th>
        </tr>
      </thead>
      <tbody>
${tableRows}
      </tbody>
    </table>
  </div>
</body>
</html>`
}

function rowsToMd(rows: TableRow[], filename: string): string {
  const esc = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const header = '| S.No | Date | Cheque No. | Transaction Remarks | Withdrawal (INR) | Deposit (INR) | Balance (INR) |'
  const divider = '|------|------|------------|---------------------|------------------|---------------|---------------|'
  const lines = rows.map(r =>
    `| ${esc(r.sno)} | ${esc(r.date)} | ${esc(r.cheque)} | ${esc(r.remarks)} | ${esc(r.withdrawal)} | ${esc(r.deposit)} | ${esc(r.balance)} |`
  )
  return `# ${filename}\n\n${header}\n${divider}\n${lines.join('\n')}`
}

function rowsToTxt(rows: TableRow[]): string {
  const header = ['S.No'.padEnd(6), 'Date'.padEnd(13), 'Remarks'.padEnd(60), 'Withdrawal'.padStart(15), 'Deposit'.padStart(15), 'Balance'.padStart(15)].join('  ')
  const divider = '-'.repeat(header.length)
  const lines = rows.map(r => [
    r.sno.padEnd(6),
    r.date.padEnd(13),
    r.remarks.slice(0, 59).padEnd(60),
    r.withdrawal.padStart(15),
    r.deposit.padStart(15),
    r.balance.padStart(15),
  ].join('  '))
  return [header, divider, ...lines].join('\n')
}

// ── Main export ───────────────────────────────────────────────────────────────
export async function convertPdf(file: File, outputFormat: string): Promise<Blob> {
  const buffer = await fileToArrayBuffer(file)

  // PNG/JPEG: render pages as images
  if (outputFormat === 'png' || outputFormat === 'jpeg') {
    const pdfjsLib = await import('pdfjs-dist')
    pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise
    const mime = outputFormat === 'png' ? 'image/png' : 'image/jpeg'
    if (pdf.numPages === 1) return renderPageToBlob(pdf, 1, 2, mime)
    const zipInput: Record<string, Uint8Array> = {}
    for (let i = 1; i <= pdf.numPages; i++) {
      const blob = await renderPageToBlob(pdf, i, 2, mime)
      zipInput[`page-${String(i).padStart(3, '0')}.${outputFormat}`] = new Uint8Array(await blob.arrayBuffer())
    }
    return new Blob([fflate.zipSync(zipInput, { level: 6 })], { type: 'application/zip' })
  }

  // All text-based outputs: attempt table extraction first
  const pdfjsLib = await import('pdfjs-dist')
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.mjs'
  const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise
  const tableRows = await extractTableRows(pdf)
  const hasTable = tableRows.length > 0

  // ── HTML ──────────────────────────────────────────────────────────────────
  if (outputFormat === 'html') {
    if (hasTable) return new Blob([rowsToHtml(tableRows, file.name)], { type: 'text/html' })
    const pages = await getPdfPages(buffer.slice(0))
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    const body = pages.map(p => {
      const bodyHtml = p.text
        ? p.text.split(/\n\n+/).map(para => `    <p>${esc(para).replace(/\n/g, '<br>')}</p>`).join('\n')
        : '    <p><em>(no extractable text on this page)</em></p>'
      return `  <section class="page">\n    <h2>Page ${p.pageNum}</h2>\n${bodyHtml}\n  </section>`
    }).join('\n')
    return new Blob([`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${esc(file.name)}</title>
  <style>
    body{font-family:Georgia,serif;max-width:800px;margin:2rem auto;padding:0 1.5rem;line-height:1.7;color:#222}
    h2{font-size:.75rem;text-transform:uppercase;letter-spacing:.08em;color:#888;margin-bottom:.4rem}
    .page{border-bottom:1px solid #e5e5e5;padding-bottom:2rem;margin-bottom:2rem}
    .page:last-child{border-bottom:none}
    p{margin:0 0 .8em;white-space:pre-wrap}
  </style>
</head>
<body>${body}</body>
</html>`], { type: 'text/html' })
  }

  // ── CSV ────────────────────────────────────────────────────────────────────
  if (outputFormat === 'csv') {
    if (hasTable) return new Blob([rowsToCsv(tableRows)], { type: 'text/csv' })
    const pages = await getPdfPages(buffer.slice(0))
    const csvRows: string[] = []
    for (const page of pages) {
      for (const line of page.text.split('\n')) {
        if (!line.trim()) continue
        const cells = line.split(/  +/).map(c => c.trim()).filter(Boolean)
        if (cells.length > 1) {
          csvRows.push(cells.map(c => (c.includes(',') || c.includes('"')) ? `"${c.replace(/"/g, '""')}"` : c).join(','))
        } else if (cells.length === 1) csvRows.push(cells[0])
      }
    }
    return new Blob([csvRows.join('\n') || 'No table data found'], { type: 'text/csv' })
  }

  // ── Markdown ───────────────────────────────────────────────────────────────
  if (outputFormat === 'md') {
    if (hasTable) return new Blob([rowsToMd(tableRows, file.name)], { type: 'text/markdown' })
    const pages = await getPdfPages(buffer.slice(0))
    const md = pages.map(p => {
      const body = p.text
        ? p.text.split(/\n\n+/).map(para => para.replace(/\n/g, '  \n').trim()).filter(Boolean).join('\n\n')
        : '*(no extractable text on this page)*'
      return `## Page ${p.pageNum}\n\n${body}`
    }).join('\n\n---\n\n')
    return new Blob([md], { type: 'text/markdown' })
  }

  // ── TXT ───────────────────────────────────────────────────────────────────
  if (outputFormat === 'txt') {
    if (hasTable) return new Blob([rowsToTxt(tableRows)], { type: 'text/plain' })
    const pages = await getPdfPages(buffer.slice(0))
    return new Blob([pages.map(p =>
      `--- Page ${p.pageNum} ---\n${p.text || '(no extractable text on this page)'}`
    ).join('\n\n')], { type: 'text/plain' })
  }

  // ── DOCX ───────────────────────────────────────────────────────────────────
  if (outputFormat === 'docx') {
    const {
      Document, Packer, Paragraph, TextRun, HeadingLevel,
      Table, TableRow: DocxTableRow, TableCell, WidthType, BorderStyle,
      PageBreak, AlignmentType, ImageRun,
    } = await import('docx')

    if (hasTable) {
      const cellBorder = { style: BorderStyle.SINGLE, size: 1, color: 'CCCCCC' }
      const borders = { top: cellBorder, bottom: cellBorder, left: cellBorder, right: cellBorder }
      const headerTexts = ['S.No', 'Date', 'Cheque No.', 'Transaction Remarks', 'Withdrawal (INR)', 'Deposit (INR)', 'Balance (INR)']
      const makeCell = (text: string, bold = false) =>
        new TableCell({
          borders,
          margins: { top: 40, bottom: 40, left: 80, right: 80 },
          children: [new Paragraph({ children: [new TextRun({ text, bold, size: 18 })] })],
        })
      const headerRow = new DocxTableRow({ children: headerTexts.map(t => makeCell(t, true)), tableHeader: true })
      const dataRows = tableRows.map(r =>
        new DocxTableRow({ children: [r.sno, r.date, r.cheque, r.remarks, r.withdrawal, r.deposit, r.balance].map(v => makeCell(v)) })
      )
      const doc = new Document({ sections: [{ children: [new Table({ width: { size: 9026, type: WidthType.DXA }, rows: [headerRow, ...dataRows] })] }] })
      return Packer.toBlob(doc)
    }

    // Fallback: text-based DOCX for prose PDFs
    const pages = await getPdfPages(buffer.slice(0))
    const totalText = pages.map(p => p.text).join('')
    if (totalText.trim().length > 50) {
      const children: InstanceType<typeof Paragraph>[] = []
      for (const page of pages) {
        if (page.pageNum > 1) children.push(new Paragraph({ children: [new PageBreak()] }))
        if (!page.text) { children.push(new Paragraph({ children: [new TextRun({ text: '(no extractable text on this page)', italics: true })] })); continue }
        for (const para of page.text.split(/\n\n+/)) {
          for (const line of para.split('\n')) {
            const trimmed = line.trim()
            if (!trimmed) continue
            const isHeading = trimmed === trimmed.toUpperCase() && trimmed.length < 80 && trimmed.length > 2
            children.push(new Paragraph({ heading: isHeading ? HeadingLevel.HEADING_2 : undefined, children: [new TextRun(trimmed)] }))
          }
        }
      }
      if (!children.length) children.push(new Paragraph(''))
      return Packer.toBlob(new Document({ sections: [{ children }] }))
    }

    // Image-based DOCX fallback for scanned PDFs
    const pdf2 = await pdfjsLib.getDocument({ data: new Uint8Array(buffer.slice(0)) }).promise
    const children2: InstanceType<typeof Paragraph>[] = []
    for (let i = 1; i <= pdf2.numPages; i++) {
      const page = await pdf2.getPage(i)
      const viewport = page.getViewport({ scale: 1.5 })
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(viewport.width); canvas.height = Math.round(viewport.height)
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvas, canvasContext: ctx, viewport }).promise
      const pngBlob: Blob = await new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), 'image/png'))
      const pngData = new Uint8Array(await pngBlob.arrayBuffer())
      const w = Math.round(5_715_450 / 9525)
      const h = Math.round(5_715_450 * canvas.height / canvas.width / 9525)
      children2.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ data: pngData, transformation: { width: w, height: h }, type: 'png' })] }))
      if (i < pdf2.numPages) children2.push(new Paragraph({ children: [new PageBreak()] }))
    }
    return Packer.toBlob(new Document({
      sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 720, right: 720, bottom: 720, left: 720 } } }, children: children2 }],
    }))
  }

  throw new Error(`Unsupported PDF output: .${outputFormat}`)
}