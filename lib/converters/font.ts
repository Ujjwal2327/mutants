import { fileToArrayBuffer } from '@/lib/utils'

const FONT_MIME: Record<string, string> = {
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
}

interface SfntTable {
  tag: number
  checksum: number
  data: Uint8Array
}

// Reads the sfnt offset table + table directory of a plain TTF/OTF buffer,
// returning each table's raw bytes untouched.
function readSfntTables(buffer: ArrayBuffer): { flavor: number; tables: SfntTable[] } {
  const view = new DataView(buffer)
  const flavor = view.getUint32(0)
  const numTables = view.getUint16(4)
  const tables: SfntTable[] = []
  for (let i = 0; i < numTables; i++) {
    const base = 12 + i * 16
    const tag = view.getUint32(base)
    const checksum = view.getUint32(base + 4)
    const offset = view.getUint32(base + 8)
    const length = view.getUint32(base + 12)
    tables.push({ tag, checksum, data: new Uint8Array(buffer, offset, length).slice() })
  }
  return { flavor, tables }
}

// Builds a standard sfnt (TTF/OTF container) binary from a flavor tag and a
// set of tables, laying out a correct offset table + directory (sorted by
// tag, as required) and 4-byte-aligned, padded table data.
const HEAD_TAG = 0x68656164 // 'head' as a big-endian uint32

// Sum of every 4-byte-aligned big-endian word in `data`, zero-padding the
// final partial word if the buffer isn't a multiple of 4 bytes — this is
// the specific whole-file checksum algorithm the sfnt spec defines for
// computing 'head'.checkSumAdjustment.
function sfntChecksum(data: Uint8Array): number {
  let sum = 0
  for (let i = 0; i < data.length; i += 4) {
    let word = 0
    for (let j = 0; j < 4; j++) word = (word << 8) | (i + j < data.length ? data[i + j] : 0)
    sum = (sum + word) >>> 0
  }
  return sum >>> 0
}

function buildSfnt(flavor: number, tables: SfntTable[]): ArrayBuffer {
  const numTables = tables.length
  let pow2 = 1
  while (pow2 * 2 <= numTables) pow2 *= 2
  const searchRange = pow2 * 16
  const entrySelector = Math.log2(pow2)
  const rangeShift = numTables * 16 - searchRange

  const sorted = [...tables].sort((a, b) => a.tag - b.tag)

  // The whole-file checksum ('head'.checkSumAdjustment) depends on this
  // file's own layout (table order/offsets/padding), which differs from
  // whatever layout the ORIGINAL font had — reusing the original head
  // table's stored adjustment value verbatim would leave a stale,
  // spec-incorrect checksum in the rebuilt file. Per spec, computing it
  // requires the field to read as zero first; the directory's own checksum
  // entry for 'head' is likewise defined against that zeroed state; only
  // the raw output bytes get the real adjustment patched in afterward.
  const headIdx = sorted.findIndex((t) => t.tag === HEAD_TAG)
  if (headIdx !== -1 && sorted[headIdx].data.length >= 12) {
    const zeroed = sorted[headIdx].data.slice()
    new DataView(zeroed.buffer).setUint32(8, 0, false)
    sorted[headIdx] = { ...sorted[headIdx], data: zeroed, checksum: sfntChecksum(zeroed) }
  }

  const headerSize = 12
  const dirSize = numTables * 16
  let offset = headerSize + dirSize
  const offsets: number[] = []
  for (const t of sorted) {
    offsets.push(offset)
    offset += Math.ceil(t.data.length / 4) * 4
  }
  const out = new Uint8Array(offset)
  const view = new DataView(out.buffer)
  view.setUint32(0, flavor)
  view.setUint16(4, numTables)
  view.setUint16(6, searchRange)
  view.setUint16(8, entrySelector)
  view.setUint16(10, rangeShift)
  sorted.forEach((t, i) => {
    const base = headerSize + i * 16
    view.setUint32(base, t.tag)
    view.setUint32(base + 4, t.checksum)
    view.setUint32(base + 8, offsets[i])
    view.setUint32(base + 12, t.data.length)
    out.set(t.data, offsets[i])
  })
  if (headIdx !== -1) {
    const adjustment = (0xb1b0afba - sfntChecksum(out)) >>> 0
    view.setUint32(offsets[headIdx] + 8, adjustment, false)
  }
  return out.buffer
}

// Unwraps a WOFF (v1) container back to a plain sfnt, decompressing any
// per-table zlib streams (WOFF stores each table individually zlib-deflated,
// or raw when compression wouldn't shrink it — signaled by compLength
// equalling origLength).
async function woffToSfnt(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  const view = new DataView(buffer)
  if (view.getUint32(0) !== 0x774f4646) throw new Error('Not a valid WOFF file — signature mismatch')
  const flavor = view.getUint32(4)
  const numTables = view.getUint16(12)
  const { unzlibSync } = await import('fflate')

  const tables: SfntTable[] = []
  for (let i = 0; i < numTables; i++) {
    const base = 44 + i * 20
    const tag = view.getUint32(base)
    const tableOffset = view.getUint32(base + 4)
    const compLength = view.getUint32(base + 8)
    const origLength = view.getUint32(base + 12)
    const origChecksum = view.getUint32(base + 16)
    const raw = new Uint8Array(buffer, tableOffset, compLength)
    const data = compLength === origLength ? raw.slice() : unzlibSync(raw)
    tables.push({ tag, checksum: origChecksum, data })
  }
  return buildSfnt(flavor, tables)
}

// Wraps a plain sfnt into a WOFF (v1) container, zlib-compressing each table
// (keeping it uncompressed if that happens to be smaller, exactly as the
// WOFF spec recommends) so the result is an actually-compact web font
// instead of just the original bytes repackaged uncompressed.
async function sfntToWoff(sfnt: ArrayBuffer): Promise<ArrayBuffer> {
  const { flavor, tables } = readSfntTables(sfnt)
  const { zlibSync } = await import('fflate')
  const numTables = tables.length
  const sorted = [...tables].sort((a, b) => a.tag - b.tag)

  const compressed = sorted.map((t) => {
    if (t.data.length === 0) return t.data
    const z = zlibSync(t.data, { level: 9 })
    return z.length < t.data.length ? z : t.data
  })

  const headerSize = 44
  const dirSize = numTables * 20
  let offset = headerSize + dirSize
  const offsets: number[] = []
  for (const c of compressed) {
    offsets.push(offset)
    offset += Math.ceil(c.length / 4) * 4
  }
  const totalSfntSize = 12 + numTables * 16 + sorted.reduce((s, t) => s + Math.ceil(t.data.length / 4) * 4, 0)

  const out = new Uint8Array(offset)
  const view = new DataView(out.buffer)
  view.setUint32(0, 0x774f4646) // 'wOFF'
  view.setUint32(4, flavor)
  view.setUint32(8, out.length)
  view.setUint16(12, numTables)
  view.setUint16(14, 0) // reserved
  view.setUint32(16, totalSfntSize)
  // majorVersion/minorVersion/meta*/priv* fields (bytes 20-43) left as 0

  sorted.forEach((t, i) => {
    const base = headerSize + i * 20
    view.setUint32(base, t.tag)
    view.setUint32(base + 4, offsets[i])
    view.setUint32(base + 8, compressed[i].length)
    view.setUint32(base + 12, t.data.length)
    view.setUint32(base + 16, t.checksum)
    out.set(compressed[i], offsets[i])
  })

  return out.buffer
}

export async function convertFont(file: File, outputFormat: string, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted()
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const buffer = await fileToArrayBuffer(file)

  // Normalize every input down to a plain sfnt (TTF/OTF) buffer first, then
  // branch only on the *output* format below. This deliberately manipulates
  // raw table bytes directly (see readSfntTables/buildSfnt/woffToSfnt above)
  // instead of routing through opentype.js's parse-then-rebuild, which does
  // not round-trip every table/lookup type it can read: real-world fonts
  // using certain GSUB contextual/chaining-substitution lookup types (common
  // in fonts with ligatures — confirmed against a real system font) make its
  // writer throw outright, and even where it doesn't throw, a full
  // reparse+rebuild risks silently dropping hinting bytecode or other tables
  // it doesn't fully model. Treating every format as "the same table data,
  // different container" preserves 100% of the original font — including
  // every OpenType feature — regardless of how sophisticated it is.
  let sfnt: ArrayBuffer

  if (ext === 'woff2') {
    const wawoff2 = await import('wawoff2')
    const decompressed = await wawoff2.decompress(new Uint8Array(buffer))
    sfnt = new Uint8Array(decompressed).buffer
  } else if (ext === 'woff') {
    sfnt = await woffToSfnt(buffer)
  } else {
    // ttf/otf input is already a plain sfnt container.
    sfnt = buffer
  }

  if (outputFormat === 'ttf' || outputFormat === 'otf')
    return new Blob([sfnt], { type: FONT_MIME[outputFormat] })

  if (outputFormat === 'woff')
    return new Blob([await sfntToWoff(sfnt)], { type: FONT_MIME.woff })

  if (outputFormat === 'woff2') {
    const wawoff2 = await import('wawoff2')
    const compressed = await wawoff2.compress(new Uint8Array(sfnt))
    return new Blob([new Uint8Array(compressed)], { type: FONT_MIME.woff2 })
  }

  throw new Error(`Unsupported font output: .${outputFormat}`)
}