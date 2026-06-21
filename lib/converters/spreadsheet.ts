import { fileToArrayBuffer, fileToText } from '@/lib/utils'

export async function convertSpreadsheet(file: File, outputFormat: string): Promise<Blob> {
  const XLSX = await import('xlsx')
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  let wb: ReturnType<typeof XLSX.read>

  if (ext === 'csv') {
    wb = XLSX.read(await fileToText(file), { type: 'string' })
  } else if (ext === 'tsv') {
    wb = XLSX.read(await fileToText(file), { type: 'string', FS: '\t' })
  } else {
    wb = XLSX.read(new Uint8Array(await fileToArrayBuffer(file)), { type: 'array' })
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
  // For single-sheet workbooks, output directly.
  // For multi-sheet workbooks, zip all sheets together.
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
    return new Blob(
      [JSON.stringify(XLSX.utils.sheet_to_json(sheet), null, 2)],
      { type: 'application/json' },
    )

  if (outputFormat === 'html') {
    // SheetJS html output is a full <table> — wrap in a styled document
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
    // Plain-text table using CSV with comma→tab alignment substitution
    // Get as CSV first, then format as aligned columns
    const csv = XLSX.utils.sheet_to_csv(sheet)
    const rows = csv.split('\n').map(line => line.split(','))
    const colWidths: number[] = []
    for (const row of rows) {
      row.forEach((cell, i) => {
        colWidths[i] = Math.max(colWidths[i] ?? 0, cell.length)
      })
    }
    const lines = rows.map(row =>
      row.map((cell, i) => cell.padEnd(colWidths[i] ?? 0)).join('  ')
    )
    return new Blob([lines.join('\n')], { type: 'text/plain' })
  }

  throw new Error(`Unsupported sheet output: .${outputFormat}`)
}

function escHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}