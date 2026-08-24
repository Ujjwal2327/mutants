import { fileToText } from '@/lib/utils'
import * as yaml from 'js-yaml'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import Papa from 'papaparse'

// ── Shared object-shape helper ────────────────────────────────────────────────
// A "should I recurse into this as a nested structure" check used by the XML /
// INI / Properties serializers below. Deliberately excludes Date — TOML input
// is now parsed by smol-toml (see the TOML section further down), which
// returns real `Date` instances (a `TomlDate` subclass) for date/time values
// instead of plain strings. Date has no own enumerable properties, so
// treating one as "a nested object" and walking it with Object.entries()
// silently produces an empty node (XML/INI) or drops the value entirely
// (Properties) instead of the actual date. Every serializer below that
// branches on "object vs. scalar" needs to agree Date counts as a scalar.
function isPlainRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)
}

function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

// ── XML helpers ───────────────────────────────────────────────────────────────
function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

// Object keys prefixed with '@' represent XML attributes (this is the
// convention xmlToJson below uses when reading XML, and a common one for
// hand-authored JSON meant to become XML-with-attributes). Splitting them
// out lets jsonToXml render them into the opening tag itself instead of as
// child elements — otherwise an XML→JSON→XML round trip (or JSON authored
// with this convention) silently turns every attribute into a same-named
// child element, changing the document's shape.
function splitAttributes(obj: Record<string, unknown>): { attrs: Record<string, unknown>; rest: Record<string, unknown> } {
  const attrs: Record<string, unknown> = {}
  const rest: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith('@') && k.length > 1) attrs[k.slice(1)] = v
    else rest[k] = v
  }
  return { attrs, rest }
}

function attrString(attrs: Record<string, unknown>): string {
  return Object.entries(attrs)
    .map(([k, v]) => {
      const safeKey = k.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/^([^a-zA-Z_])/, '_$1') || 'attr'
      return ` ${safeKey}="${escapeXml(stringifyCell(v))}"`
    })
    .join('')
}

// Renders one <tag>...</tag> element for a (possibly attribute-bearing)
// value. Pulled out of jsonToXml's own recursion so the parent — which is
// the one that knows the tag name — can place attributes in the opening
// tag rather than the child call, which only knows the tag's contents.
function renderElement(tag: string, val: unknown, indent: string): string {
  if (isPlainRecord(val)) {
    const { attrs, rest } = splitAttributes(val)
    const a = attrString(attrs)
    // '#text' is the mirror-image convention xmlToJson uses for a leaf
    // element that carries both attributes and direct text content (e.g.
    // <price currency="USD">19.99</price>) — render it as the element's own
    // text rather than as a nested <_text> child.
    if ('#text' in rest && Object.keys(rest).length === 1) {
      return `${indent}<${tag}${a}>${jsonToXml(rest['#text'])}</${tag}>`
    }
    return `${indent}<${tag}${a}>${jsonToXml(rest, indent)}</${tag}>`
  }
  return `${indent}<${tag}>${jsonToXml(val)}</${tag}>`
}

function jsonToXml(val: unknown, indent = ''): string {
  if (val instanceof Date) return escapeXml(val.toISOString())
  if (Array.isArray(val))
    // A bare array with no enclosing object key (e.g. the document's root value
    // is itself an array, or an array nested directly inside another array).
    // There's no natural tag name to reuse here, so fall back to a generic
    // <item> wrapper per element.
    return val.map(v => `${indent}<item>${jsonToXml(v, indent + '  ')}</item>`).join('\n')
  if (isPlainRecord(val))
    return '\n' + Object.entries(val)
      .map(([k, v]) => {
        const safeKey = k.replace(/[^a-zA-Z0-9_.-]/g, '_').replace(/^([^a-zA-Z_])/, '_$1') || 'field'
        if (Array.isArray(v)) {
          // Represent an array-valued property as repeated sibling elements
          // using the property's OWN tag name (e.g. <skill>Java</skill>
          // <skill>Go</skill>) instead of nesting a generic <item> wrapper
          // inside <skill>. xmlToJson already collapses repeated same-named
          // sibling tags back into an array, so this makes the round trip
          // symmetric instead of introducing an extra `{ item: [...] }`
          // wrapper object around every array property.
          if (v.length === 0) return `${indent}  <${safeKey}></${safeKey}>`
          return v
            .map((item) => renderElement(safeKey, item, indent + '  '))
            .join('\n')
        }
        return renderElement(safeKey, v, indent + '  ')
      }).join('\n') + `\n${indent}`
  // Render null/undefined as the literal text "null" (rather than an empty
  // element, which is indistinguishable from an empty string) so it
  // round-trips recognizably instead of silently turning into "".
  return escapeXml(val === null || val === undefined ? 'null' : String(val))
}

function xmlToJson(xml: string): unknown {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const parseError = doc.querySelector('parsererror')
  if (parseError) throw new Error(`Invalid XML: ${parseError.textContent?.slice(0, 200)}`)
  function parse(node: Element): unknown {
    const attrs = Array.from(node.attributes)
    if (node.children.length === 0) {
      // Leaf element (no child ELEMENTS — the overwhelmingly common case for
      // ordinary data-shaped XML like <name>John</name>). Previously this
      // returned the bare text and skipped attribute collection entirely,
      // so any attributes on a leaf element were silently lost.
      if (attrs.length === 0) return node.textContent ?? ''
      const obj: Record<string, unknown> = {}
      for (const attr of attrs) obj[`@${attr.name}`] = attr.value
      const text = node.textContent ?? ''
      if (text) obj['#text'] = text
      return obj
    }
    const obj: Record<string, unknown> = {}
    for (const attr of attrs) obj[`@${attr.name}`] = attr.value
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
  } else if (isPlainRecord(parsed)) {
    const obj = parsed
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

// ── TOML ──────────────────────────────────────────────────────────────────────
// Parsing/serializing is delegated entirely to smol-toml (spec-compliant,
// actively maintained) instead of a hand-written parser. The previous
// hand-rolled version didn't understand inline tables (`{ x = 1, y = 2 }`),
// TOML dates, or multi-line strings — each of those silently produced a
// wrong value instead of an error, which is worse than not supporting them.
//
// TOML has no concept of a bare top-level array or scalar — every document
// must be a table — so non-object roots (e.g. a CSV file, which becomes an
// array of row-objects) are wrapped under an "items" key, same as the old
// implementation did, so those conversions still produce a sensible file
// instead of smol-toml's "stringify can only be called with an object" error.
function toTomlDocument(data: unknown): Record<string, unknown> {
  if (isPlainRecord(data)) return data
  return { items: data }
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
  if (value instanceof Date) return value.toISOString()
  return String(value ?? '')
}

function stringifyINI(data: unknown): string {
  if (!isPlainRecord(data)) return stringifyINIScalar(data)
  const obj = data
  const rootLines: string[] = []
  const sections: [string, Record<string, unknown>][] = []
  for (const [key, value] of Object.entries(obj)) {
    if (isPlainRecord(value)) {
      sections.push([key, value])
    } else {
      rootLines.push(`${key} = ${stringifyINIScalar(value)}`)
    }
  }
  const sectionBlocks = sections.map(([name, section]) => {
    const lines = Object.entries(section).map(([key, value]) => {
      if (isPlainRecord(value))
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
  } else if (isPlainRecord(obj)) {
    for (const [k, v] of Object.entries(obj))
      flattenForProperties(v, prefix ? `${prefix}.${k}` : k, out)
  } else {
    out[prefix] = obj === null || obj === undefined ? '' : obj instanceof Date ? obj.toISOString() : String(obj)
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
  return arrayifyNumericKeys(root)
}

// flattenForProperties represents arrays via consecutive numeric-index keys
// (e.g. list.0, list.1, ...) since .properties has no native array syntax.
// Object key enumeration order always puts integer-like keys first in
// ascending numeric order regardless of insertion order, so checking that a
// node's keys are exactly "0".."n-1" reliably identifies these and converts
// them back into real arrays instead of leaving `{ "0": ..., "1": ... }`
// objects, which would otherwise change the data's shape on round trip.
function arrayifyNumericKeys(node: unknown): unknown {
  if (node === null || typeof node !== 'object' || Array.isArray(node)) return node
  const obj = node as Record<string, unknown>
  const keys = Object.keys(obj)
  const isArrayLike = keys.length > 0 && keys.every((k, i) => k === String(i))
  const values = keys.map((k) => arrayifyNumericKeys(obj[k]))
  if (isArrayLike) return values
  const result: Record<string, unknown> = {}
  keys.forEach((k, i) => { result[k] = values[i] })
  return result
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
  if (isPlainRecord(parsed)) {
    const obj = parsed
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

export async function convertData(file: File, outputFormat: string, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted()
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  // FIX: strip BOM from text files (common in Windows-exported files)
  let text = await fileToText(file)
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)

  let parsed: unknown

  if (ext === 'json') parsed = JSON.parse(text)
  else if (ext === 'yaml' || ext === 'yml') parsed = yaml.load(text)
  else if (ext === 'xml') parsed = xmlToJson(text)
  else if (ext === 'toml') parsed = parseToml(text)
  else if (ext === 'ini') parsed = parseINI(text)
  else if (ext === 'properties') parsed = unflattenProperties(parseProperties(text))
  else if (ext === 'ndjson') parsed = parseNDJSON(text)
  else if (ext === 'csv' || ext === 'tsv') {
    // Delimited parsing is delegated to papaparse instead of a hand-written
    // tokenizer — it correctly handles the real-world dialects (embedded
    // newlines/commas inside quoted fields, stray whitespace, etc.) that a
    // bespoke parser tends to only catch one bug report at a time.
    const delimiter = ext === 'tsv' ? '\t' : ','
    const { data } = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: true })
    const [rawHeaders, ...rows] = data
    if (!rawHeaders) throw new Error(`${ext.toUpperCase()} file appears to be empty`)
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
  if (outputFormat === 'xml') {
    let rootAttrs = ''
    let rootVal = parsed
    if (isPlainRecord(parsed)) {
      const { attrs, rest } = splitAttributes(parsed)
      rootAttrs = attrString(attrs)
      rootVal = rest
    }
    return new Blob(
      [`<?xml version="1.0" encoding="UTF-8"?>\n<root${rootAttrs}>${jsonToXml(rootVal)}\n</root>`],
      { type: 'application/xml' }
    )
  }

  // ── TOML ──────────────────────────────────────────────────────────────────
  if (outputFormat === 'toml')
    return new Blob([stringifyToml(toTomlDocument(parsed))], { type: 'application/toml' })

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
        return new Blob([Papa.unparse([result.headers, ...result.rows], { delimiter: delim })], { type: mimeType })
      }
    }

    const rows = normaliseToRows(parsed)
    if (rows.length === 0) return new Blob([''], { type: mimeType })

    const headers = Array.from(
      new Set(rows.flatMap(r => (r && typeof r === 'object') ? Object.keys(r) : []))
    )
    return new Blob(
      [Papa.unparse([headers, ...rows.map(r => headers.map(h => stringifyCell(r?.[h])))], { delimiter: delim })],
      { type: mimeType }
    )
  }

  throw new Error(`Unsupported data output: .${outputFormat}`)
}