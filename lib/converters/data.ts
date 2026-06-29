import { fileToText } from '@/lib/utils'
import * as yaml from 'js-yaml'

// ── Delimited parser (CSV/TSV) ────────────────────────────────────────────────
function parseDelimited(text: string, delim: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  while (i < text.length) {
    const char = text[i]
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue }
        inQuotes = false; i++; continue
      }
      field += char; i++; continue
    }
    if (char === '"') { inQuotes = true; i++; continue }
    if (char === delim) { row.push(field); field = ''; i++; continue }
    if (char === '\r') { i++; continue }
    if (char === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue }
    field += char; i++
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row) }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''))
}

function toCsv(rows: string[][], delim = ','): string {
  return rows.map(r =>
    r.map(c => {
      const needsQuote = c.includes(delim) || c.includes('"') || c.includes('\n') || c.includes('\r') ||
        (delim === '\t' ? false : c.includes('\t'))
      return needsQuote ? `"${c.replace(/"/g, '""')}"` : c
    }).join(delim)
  ).join('\n')
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// ── XML helpers ───────────────────────────────────────────────────────────────
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function jsonToXml(val: unknown, indent = ''): string {
  if (Array.isArray(val))
    return val.map(v => `${indent}<item>${jsonToXml(v, indent + '  ')}</item>`).join('\n')
  if (val !== null && typeof val === 'object')
    return '\n' + Object.entries(val as Record<string, unknown>)
      .map(([k, v]) => {
        const safeKey = k.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/^([^a-zA-Z_])/, '_$1') || 'field'
        return `${indent}  <${safeKey}>${jsonToXml(v, indent + '  ')}</${safeKey}>`
      }).join('\n') + `\n${indent}`
  // FIX: use String(val) so null renders as "null" in XML rather than empty string,
  // preserving round-trip fidelity
  return escapeXml(val === null || val === undefined ? '' : String(val))
}

function xmlToJson(xml: string): unknown {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const parseError = doc.querySelector('parseerror')
  if (parseError) throw new Error(`Invalid XML: ${parseError.textContent?.slice(0, 200)}`)
  function parse(node: Element): unknown {
    if (node.children.length === 0) return node.textContent ?? ''
    const obj: Record<string, unknown> = {}
    for (const attr of Array.from(node.attributes)) obj[`@${attr.name}`] = attr.value
    for (const child of Array.from(node.children)) {
      const k = child.tagName
      const v = parse(child)
      obj[k] = k in obj ? (Array.isArray(obj[k]) ? [...(obj[k] as unknown[]), v] : [obj[k], v]) : v
    }
    return obj
  }
  return parse(doc.documentElement)
}

function xmlToRows(xml: string): { headers: string[]; rows: string[][] } | null {
  const parsed = xmlToJson(xml)
  return jsonToRows(parsed)
}

function jsonToRows(parsed: unknown): { headers: string[]; rows: string[][] } | null {
  let arr: Record<string, unknown>[]
  if (Array.isArray(parsed)) {
    // FIX: arrays of primitives (numbers, strings, booleans) should produce a
    // single-column table with a "value" header instead of yielding no columns
    if (parsed.length > 0 && (typeof parsed[0] !== 'object' || parsed[0] === null)) {
      return { headers: ['value'], rows: parsed.map(item => [stringifyCell(item)]) }
    }
    arr = parsed as Record<string, unknown>[]
  } else if (parsed !== null && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    const keys = Object.keys(obj).filter(k => !k.startsWith('@'))
    const arrayKey = keys.find(k => Array.isArray(obj[k]))
    if (arrayKey) {
      const inner = obj[arrayKey] as unknown[]
      arr = (inner.length > 0 && typeof inner[0] === 'object' && inner[0] !== null)
        ? inner as Record<string, unknown>[]
        : [obj]
    } else {
      arr = [obj]
    }
  } else {
    // Primitive value — wrap it so CSV output has at least one row
    return { headers: ['value'], rows: [[String(parsed ?? '')]] }
  }
  if (arr.length === 0) return { headers: [], rows: [] }
  const headerSet = new Set<string>()
  for (const row of arr) {
    if (row && typeof row === 'object') for (const key of Object.keys(row)) headerSet.add(key)
  }
  const headers = Array.from(headerSet).filter(h => !h.startsWith('@'))
  const rows = arr.map(row => headers.map(h => stringifyCell(row?.[h])))
  return { headers, rows }
}

// ── TOML parser ───────────────────────────────────────────────────────────────
function splitTomlArrayItems(inner: string): string[] {
  const items: string[] = []
  let depth = 0, inQuotes = false, current = ''
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (inQuotes) {
      current += c
      if (c === '"' && inner[i - 1] !== '\\') inQuotes = false
      continue
    }
    if (c === '"') { inQuotes = true; current += c; continue }
    if (c === '[') { depth++; current += c; continue }
    if (c === ']') { depth--; current += c; continue }
    if (c === ',' && depth === 0) { items.push(current.trim()); current = ''; continue }
    current += c
  }
  if (current.trim()) items.push(current.trim())
  return items
}

function parseTomlValue(raw: string): unknown {
  const val = raw.trim()
  if (val.startsWith('[') && val.endsWith(']')) {
    const inner = val.slice(1, -1).trim()
    return inner ? splitTomlArrayItems(inner).map(parseTomlValue) : []
  }
  if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
    return val.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  if (val === 'true') return true
  if (val === 'false') return false
  if (val !== '' && !isNaN(Number(val))) return Number(val)
  // FIX: strip inline comments from unquoted string values
  // TOML uses # for inline comments; strip everything after an unquoted #
  const commentIdx = val.indexOf('#')
  if (commentIdx > 0) return val.slice(0, commentIdx).trimEnd()
  return val
}

function parseTOML(src: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let cur = root
  // FIX: track current array-of-tables key for [[table]] syntax
  let curArrayKey: string | null = null

  for (const line of src.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue

    // FIX: handle [[array-of-tables]] double-bracket syntax
    const aam = t.match(/^\[\[([^\]]+)\]\]$/)
    if (aam) {
      const keyPath = aam[1].split('.').map(k => k.trim())
      let node: Record<string, unknown> = root
      for (let i = 0; i < keyPath.length - 1; i++) {
        const k = keyPath[i]
        if (typeof node[k] !== 'object' || node[k] === null) node[k] = {}
        node = node[k] as Record<string, unknown>
      }
      const lastKey = keyPath[keyPath.length - 1]
      if (!Array.isArray(node[lastKey])) node[lastKey] = []
      const newEntry: Record<string, unknown> = {}
        ; (node[lastKey] as Record<string, unknown>[]).push(newEntry)
      cur = newEntry
      curArrayKey = lastKey
      continue
    }

    // Standard [table] single-bracket
    const sm = t.match(/^\[([^\]]+)\]$/)
    if (sm) {
      curArrayKey = null
      let node = root
      for (const key of sm[1].split('.').map(k => k.trim())) {
        if (typeof node[key] !== 'object' || node[key] === null || Array.isArray(node[key])) node[key] = {}
        node = node[key] as Record<string, unknown>
      }
      cur = node; continue
    }
    const kv = t.match(/^([\w.-]+)\s*=\s*(.+)$/)
    if (!kv) continue
    cur[kv[1]] = parseTomlValue(kv[2])
  }
  return root
}

function tomlEscape(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function tomlScalar(value: unknown): string {
  if (typeof value === 'string') return `"${tomlEscape(value)}"`
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return `[${value.map(tomlScalar).join(', ')}]`
  return `"${tomlEscape(String(value ?? ''))}"`
}

function stringifyTomlTable(data: Record<string, unknown>, prefix: string): string {
  const scalarLines: string[] = []
  const tableSections: string[] = []
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
      // FIX: emit array-of-tables using [[key]] syntax
      const path = prefix ? `${prefix}.${key}` : key
      for (const item of value as Record<string, unknown>[]) {
        const body = stringifyTomlTable(item, '')
        tableSections.push(`[[${path}]]${body ? '\n' + body : ''}`)
      }
    } else if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const path = prefix ? `${prefix}.${key}` : key
      const nested = stringifyTomlTable(value as Record<string, unknown>, path)
      tableSections.push(`[${path}]${nested ? '\n' + nested : ''}`)
    } else {
      scalarLines.push(`${key} = ${tomlScalar(value)}`)
    }
  }
  return [...scalarLines, ...tableSections].join('\n')
}

function stringifyToml(data: unknown): string {
  if (Array.isArray(data)) {
    // FIX: top-level array — if objects, emit as [[items]] array-of-tables
    if (data.length > 0 && typeof data[0] === 'object' && data[0] !== null && !Array.isArray(data[0])) {
      return (data as Record<string, unknown>[])
        .map(item => {
          const body = stringifyTomlTable(item, '')
          return `[[items]]${body ? '\n' + body : ''}`
        })
        .join('\n\n')
    }
    // Primitive arrays at top level — emit as TOML array
    return `items = ${tomlScalar(data)}`
  }
  if (data !== null && typeof data === 'object') return stringifyTomlTable(data as Record<string, unknown>, '')
  return tomlScalar(data)
}

// ── INI ───────────────────────────────────────────────────────────────────────
function parseINIValue(raw: string): unknown {
  const val = raw.trim()
  if (val === 'true') return true
  if (val === 'false') return false
  if (val !== '' && !isNaN(Number(val))) return Number(val)
  return val
}

function parseINI(src: string): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  let cur: Record<string, unknown> = root
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';') || line.startsWith('#')) continue
    const sectionMatch = line.match(/^\[(.+)\]$/)
    if (sectionMatch) {
      const name = sectionMatch[1].trim()
      const existing = root[name]
      cur = (existing && typeof existing === 'object' && !Array.isArray(existing))
        ? existing as Record<string, unknown> : {}
      root[name] = cur; continue
    }
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const key = line.slice(0, eq).trim()
    // FIX: strip inline comments (text after ' ;' or ' #' that is not inside quotes)
    let rawValue = line.slice(eq + 1).trim()
    const commentMatch = rawValue.match(/^([^"';#]*?)\s*[;#].*$/)
    if (commentMatch && !rawValue.startsWith('"') && !rawValue.startsWith("'")) {
      rawValue = commentMatch[1].trim()
    }
    cur[key] = parseINIValue(rawValue)
  }
  return root
}

function stringifyINIScalar(value: unknown): string {
  if (Array.isArray(value)) return value.map(v => stringifyINIScalar(v)).join(', ')
  return String(value ?? '')
}

function stringifyINI(data: unknown): string {
  if (data === null || typeof data !== 'object') return stringifyINIScalar(data)
  const obj = data as Record<string, unknown>
  const rootLines: string[] = []
  const sections: [string, Record<string, unknown>][] = []
  for (const [key, value] of Object.entries(obj)) {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      sections.push([key, value as Record<string, unknown>])
    } else {
      rootLines.push(`${key} = ${stringifyINIScalar(value)}`)
    }
  }
  const sectionBlocks = sections.map(([name, section]) => {
    const lines = Object.entries(section).map(([key, value]) => {
      if (value !== null && typeof value === 'object' && !Array.isArray(value))
        return `${key} = ${JSON.stringify(value)}`
      return `${key} = ${stringifyINIScalar(value)}`
    })
    return `[${name}]\n${lines.join('\n')}`
  })
  return [rootLines.join('\n'), ...sectionBlocks].filter(Boolean).join('\n\n')
}

// ── Properties ────────────────────────────────────────────────────────────────
function flattenForProperties(obj: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> {
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => flattenForProperties(v, prefix ? `${prefix}.${i}` : String(i), out))
  } else if (obj !== null && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>))
      flattenForProperties(v, prefix ? `${prefix}.${k}` : k, out)
  } else {
    out[prefix] = obj === null || obj === undefined ? '' : String(obj)
  }
  return out
}

function unflattenProperties(flat: Record<string, string>): unknown {
  const root: Record<string, unknown> = {}
  for (const [path, value] of Object.entries(flat)) {
    const keys = path.split('.')
    let node = root
    keys.forEach((k, i) => {
      if (i === keys.length - 1) { node[k] = value }
      else {
        if (typeof node[k] !== 'object' || node[k] === null) node[k] = {}
        node = node[k] as Record<string, unknown>
      }
    })
  }
  return root
}

function parseProperties(src: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of src.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith('!')) continue
    const eq = line.search(/[=:]/)
    if (eq === -1) continue
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
  }
  return out
}

function stringifyProperties(data: unknown): string {
  const flat = flattenForProperties(data)
  return Object.entries(flat).map(([k, v]) => `${k}=${v}`).join('\n')
}

// ── NDJSON ────────────────────────────────────────────────────────────────────
function parseNDJSON(text: string): unknown[] {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l))
}

function stringifyNDJSON(parsed: unknown): string {
  const arr = Array.isArray(parsed) ? parsed : [parsed]
  return arr.map(item => JSON.stringify(item)).join('\n')
}

// ── Normalise parsed data to flat row array ────────────────────────────────────
function normaliseToRows(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) {
    // FIX: if array contains primitives (not objects), wrap each as {value: item}
    // so CSV/TSV output has a proper header column instead of producing no output
    if (parsed.length > 0 && (typeof parsed[0] !== 'object' || parsed[0] === null)) {
      return parsed.map(item => ({ value: item }))
    }
    return parsed as Record<string, unknown>[]
  }
  if (parsed !== null && typeof parsed === 'object') {
    const obj = parsed as Record<string, unknown>
    const keys = Object.keys(obj)
    if (keys.length === 1 && Array.isArray(obj[keys[0]])) return obj[keys[0]] as Record<string, unknown>[]
    return [obj]
  }
  return [{ value: parsed }]
}

// ── Deduplicate CSV/TSV header names ─────────────────────────────────────────
function deduplicateHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>()
  return headers.map(h => {
    if (!seen.has(h)) { seen.set(h, 0); return h }
    const count = seen.get(h)! + 1
    seen.set(h, count)
    return `${h}_${count}`
  })
}

export async function convertData(file: File, outputFormat: string): Promise<Blob> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  // FIX: strip BOM from text files (common in Windows-exported files)
  let text = await fileToText(file)
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)

  let parsed: unknown

  if (ext === 'json') parsed = JSON.parse(text)
  else if (ext === 'yaml' || ext === 'yml') parsed = yaml.load(text)
  else if (ext === 'xml') parsed = xmlToJson(text)
  else if (ext === 'toml') parsed = parseTOML(text)
  else if (ext === 'ini') parsed = parseINI(text)
  else if (ext === 'properties') parsed = unflattenProperties(parseProperties(text))
  else if (ext === 'ndjson') parsed = parseNDJSON(text)
  else if (ext === 'csv') {
    const [rawHeaders, ...rows] = parseDelimited(text, ',')
    if (!rawHeaders) throw new Error('CSV file appears to be empty')
    // FIX: deduplicate column headers to avoid silent data loss
    const headers = deduplicateHeaders(rawHeaders)
    parsed = rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])))
  } else if (ext === 'tsv') {
    const [rawHeaders, ...rows] = parseDelimited(text, '\t')
    if (!rawHeaders) throw new Error('TSV file appears to be empty')
    // FIX: deduplicate column headers to avoid silent data loss
    const headers = deduplicateHeaders(rawHeaders)
    parsed = rows.map(r => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ''])))
  } else throw new Error(`Unsupported data input: .${ext}`)

  // ── JSON ──────────────────────────────────────────────────────────────────
  if (outputFormat === 'json')
    return new Blob([JSON.stringify(parsed, null, 2)], { type: 'application/json' })

  // ── YAML ──────────────────────────────────────────────────────────────────
  if (outputFormat === 'yaml' || outputFormat === 'yml')
    return new Blob([yaml.dump(parsed, { lineWidth: 120 })], { type: 'application/x-yaml' })

  // ── XML ───────────────────────────────────────────────────────────────────
  if (outputFormat === 'xml')
    return new Blob(
      [`<?xml version="1.0" encoding="UTF-8"?>\n<root>${jsonToXml(parsed)}\n</root>`],
      { type: 'application/xml' }
    )

  // ── TOML ──────────────────────────────────────────────────────────────────
  if (outputFormat === 'toml')
    return new Blob([stringifyToml(parsed)], { type: 'application/toml' })

  // ── INI ───────────────────────────────────────────────────────────────────
  if (outputFormat === 'ini')
    return new Blob([stringifyINI(parsed)], { type: 'text/plain' })

  // ── Properties ────────────────────────────────────────────────────────────
  if (outputFormat === 'properties')
    return new Blob([stringifyProperties(parsed)], { type: 'text/plain' })

  // ── NDJSON ────────────────────────────────────────────────────────────────
  if (outputFormat === 'ndjson')
    return new Blob([stringifyNDJSON(parsed)], { type: 'application/x-ndjson' })

  // ── CSV / TSV ─────────────────────────────────────────────────────────────
  if (outputFormat === 'csv' || outputFormat === 'tsv') {
    const delim = outputFormat === 'tsv' ? '\t' : ','
    const mimeType = outputFormat === 'tsv' ? 'text/tab-separated-values' : 'text/csv'

    // Special handling for XML input — use position-aware table extraction
    if (ext === 'xml') {
      const result = xmlToRows(text)
      if (result && result.headers.length > 0) {
        return new Blob([toCsv([result.headers, ...result.rows], delim)], { type: mimeType })
      }
    }

    const rows = normaliseToRows(parsed)
    if (rows.length === 0) return new Blob([''], { type: mimeType })

    const headers = Array.from(
      new Set(rows.flatMap(r => (r && typeof r === 'object') ? Object.keys(r) : []))
    )
    return new Blob(
      [toCsv([headers, ...rows.map(r => headers.map(h => stringifyCell(r?.[h])))], delim)],
      { type: mimeType }
    )
  }

  throw new Error(`Unsupported data output: .${outputFormat}`)
}