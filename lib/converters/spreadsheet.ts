import { fileToArrayBuffer, fileToText } from '@/lib/utils'

export async function convertSpreadsheet(file: File, outputFormat: string): Promise<Blob> {
  const XLSX = await import('xlsx')
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  let wb: ReturnType<typeof XLSX.read>

  if (ext === 'csv') {
    // FIX (MEDIUM): strip UTF-8 BOM (0xEF 0xBB 0xBF) that Excel adds to CSV
    // exports. Without this the first column header gets a \uFEFF prefix.
    let text = await fileToText(file)
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
    wb = XLSX.read(text, { type: 'string' })
  } else if (ext === 'tsv') {
    let text = await fileToText(file)
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
    wb = XLSX.read(text, { type: 'string', FS: '\t' })
  } else {
    // FIX: cellDates:true converts Excel date serial numbers (e.g. 44927) to
    // JavaScript Date objects so that flat outputs (CSV, JSON, TSV, HTML, TXT)
    // show human-readable dates like "2023-01-01" instead of raw numbers.
    // cellNF:true preserves the original number format string for reference.
    wb = XLSX.read(new Uint8Array(await fileToArrayBuffer(file)), { type: 'array', cellDates: true, cellNF: true })
  }

  // ── Workbook-preserving outputs (all sheets kept) ─────────────────────────
  if (outputFormat === 'xlsx') {
    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' })
    return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  }
  if (outputFormat === 'ods') {
    const buf = XLSX.write(wb, { bookType: 'ods', type: 'array' })
    return new Blob([buf], { type: 'application/vnd.oasis.opendocument.spreadsheet' })
  }
  if (outputFormat === 'xlsb') {
    const buf = XLSX.write(wb, { bookType: 'xlsb', type: 'array' })
    return new Blob([buf], { type: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12' })
  }

  // ── Flat/tabular outputs (CSV, TSV, JSON, HTML, TXT) ──────────────────────
  if (['csv', 'tsv', 'json', 'html', 'txt'].includes(outputFormat)) {
    const sheetNames = wb.SheetNames

    if (sheetNames.length === 1) {
      return sheetToBlob(XLSX, wb.Sheets[sheetNames[0]], outputFormat, sheetNames[0])
    }

    // Multiple sheets — ZIP them
    const { zipSync } = await import('fflate')
    const zipInput: Record<string, Uint8Array> = {}

    for (const name of sheetNames) {
      const safeName = name.replace(/[/\\:*?"<>|]/g, '_')
      const blob = sheetToBlob(XLSX, wb.Sheets[name], outputFormat, name)
      zipInput[`${safeName}.${outputFormat}`] = new Uint8Array(await blob.arrayBuffer())
    }

    const zipped = zipSync(zipInput, { level: 6 })
    return new Blob([zipped], { type: 'application/zip' })
  }

  throw new Error(`Unsupported spreadsheet output: .${outputFormat}`)
}

// Parse quoted CSV properly (handles commas and quotes inside cells)
function parseCSVLine(line: string): string[] {
  const cells: string[] = []
  let field = '', inQuotes = false, i = 0
  while (i < line.length) {
    const ch = line[i]
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += ch; i++; continue
    }
    if (ch === '"') { inQuotes = true; i++; continue }
    if (ch === ',') { cells.push(field); field = ''; i++; continue }
    field += ch; i++
  }
  cells.push(field)
  return cells
}

function sheetToBlob(
  XLSX: typeof import('xlsx'),
  sheet: import('xlsx').WorkSheet,
  outputFormat: string,
  sheetName = 'Sheet1',
): Blob {
  if (outputFormat === 'csv')
    return new Blob([XLSX.utils.sheet_to_csv(sheet)], { type: 'text/csv' })

  if (outputFormat === 'tsv')
    return new Blob([XLSX.utils.sheet_to_csv(sheet, { FS: '\t' })], { type: 'text/tab-separated-values' })

  if (outputFormat === 'json')
    return new Blob([JSON.stringify(XLSX.utils.sheet_to_json(sheet), null, 2)], { type: 'application/json' })

  if (outputFormat === 'html') {
    const tableHtml = XLSX.utils.sheet_to_html(sheet)
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${escHtml(sheetName)}</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 2rem; color: #222; }
    table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
    td, th { border: 1px solid #ddd; padding: 6px 10px; text-align: left; vertical-align: top; }
    tr:first-child td, th { background: #f0f0f0; font-weight: 600; }
    tr:nth-child(even) { background: #fafafa; }
  </style>
</head>
<body>
<h2>${escHtml(sheetName)}</h2>
${tableHtml}
</body>
</html>`
    return new Blob([html], { type: 'text/html' })
  }

  if (outputFormat === 'txt') {
    const csv = XLSX.utils.sheet_to_csv(sheet)
    const rows = csv.split('\n').map(line => parseCSVLine(line))
    const colWidths: number[] = []
    for (const row of rows) {
      row.forEach((cell, i) => { colWidths[i] = Math.max(colWidths[i] ?? 0, cell.length) })
    }
    // FIX (LOW): trim trailing whitespace from last column on each row
    const lines = rows.map(row =>
      row.map((cell, i) => {
        const isLast = i === row.length - 1
        return isLast ? cell : cell.padEnd(colWidths[i] ?? 0)
      }).join('  ').trimEnd()
    )
    return new Blob([lines.join('\n')], { type: 'text/plain' })
  }

  throw new Error(`Unsupported sheet output: .${outputFormat}`)
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}