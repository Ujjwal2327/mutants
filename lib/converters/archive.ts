import { fileToArrayBuffer } from '@/lib/utils'
import * as fflate from 'fflate'

function readOctal(bytes: Uint8Array, start: number, length: number): number {
  // GNU base-256 extension: a set high bit on the field's first byte means
  // the rest of the field is a big-endian binary integer rather than octal
  // ASCII text. Used whenever a value (typically file size) doesn't fit in
  // the field's fixed octal-digit width, e.g. files >= 8GB. Without this,
  // such a field gets decoded as text and parseInt(..., 8) on binary bytes
  // silently returns NaN/garbage, corrupting that entry's extraction.
  const first = bytes[start]
  if (first & 0x80) {
    let value = first & 0x7f
    for (let i = 1; i < length; i++) value = value * 256 + bytes[start + i]
    return value
  }
  const str = new TextDecoder().decode(bytes.subarray(start, start + length)).replace(/\0.*$/, '').trim()
  return str ? parseInt(str, 8) : 0
}

function writeOctalField(view: Uint8Array, start: number, length: number, value: number) {
  const str = value.toString(8).padStart(length - 1, '0')
  for (let i = 0; i < length - 1; i++) view[start + i] = str.charCodeAt(i)
  view[start + length - 1] = 0
}

function writeStringField(view: Uint8Array, start: number, length: number, value: string) {
  // Must encode as real UTF-8 bytes, not raw UTF-16 code units: charCodeAt()
  // returns values above 255 for most non-Latin-1 characters (e.g. CJK,
  // Cyrillic, emoji), and assigning those directly into a Uint8Array silently
  // truncates to the low 8 bits, corrupting the name instead of encoding it.
  const bytes = new TextEncoder().encode(value)
  view.set(bytes.subarray(0, length), start)
}

// Parses a PAX extended-header data block: a sequence of
// "<length> <key>=<value>\n" records (length includes itself, the key,
// '=', value, and the trailing newline). Critically, that length is a BYTE
// count, not a character count — so record boundaries must be computed on
// the raw Uint8Array first and only decoded to text one record at a time.
// (Decoding the whole block to a JS string up front and then slicing by the
// byte length would work fine for ASCII paths but silently misalign as soon
// as the filename contains multi-byte UTF-8 characters, since one JS/UTF-16
// string unit doesn't correspond to one UTF-8 byte.)
function parsePaxRecords(data: Uint8Array): Record<string, string> {
  const records: Record<string, string> = {}
  const decoder = new TextDecoder()
  let pos = 0
  while (pos < data.length) {
    let spaceIdx = -1
    for (let i = pos; i < data.length; i++) {
      if (data[i] === 0x20) { spaceIdx = i; break }
      if (data[i] < 0x30 || data[i] > 0x39) break // not an ASCII digit -> malformed; bail out
    }
    if (spaceIdx === -1) break
    const len = parseInt(decoder.decode(data.subarray(pos, spaceIdx)), 10)
    if (!len || isNaN(len) || len <= 0 || pos + len > data.length) break
    const recordText = decoder.decode(data.subarray(pos, pos + len))
    const eqIdx = recordText.indexOf('=')
    if (eqIdx !== -1) {
      const prefixLen = spaceIdx - pos + 1 // "<len> " prefix is pure ASCII, so byte count === char count here
      const key = recordText.slice(prefixLen, eqIdx)
      let value = recordText.slice(eqIdx + 1)
      if (value.endsWith('\n')) value = value.slice(0, -1)
      records[key] = value
    }
    pos += len
  }
  return records
}

function untar(buffer: Uint8Array): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  let offset = 0
  // FIX: track long-name override from GNU/PAX extended headers
  let pendingLongName: string | null = null

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break
    const rawName = new TextDecoder().decode(header.subarray(0, 100)).replace(/\0.*$/, '')
    const size = readOctal(header, 124, 12)
    const typeFlag = String.fromCharCode(header[156])
    offset += 512

    // FIX: GNU long-name header (type 'L') — next block contains the real filename
    if (typeFlag === 'L') {
      const nameBytes = buffer.subarray(offset, offset + size)
      pendingLongName = new TextDecoder().decode(nameBytes).replace(/\0.*$/, '')
      offset += Math.ceil(size / 512) * 512
      continue
    }

    // PAX extended header (type 'x'): parse it for a "path" record, which is
    // the modern (non-GNU-specific) way tools like bsdtar/libarchive — the
    // default `tar` on macOS — represent long filenames. Previously this was
    // just skipped like a global 'g' header, silently truncating any long
    // name back down to the legacy 100-byte field on the next entry.
    if (typeFlag === 'x') {
      const paxData = buffer.subarray(offset, offset + size)
      const records = parsePaxRecords(paxData)
      if (records.path) pendingLongName = records.path
      offset += Math.ceil(size / 512) * 512
      continue
    }

    // Global PAX header ('g') applies to all following entries; we don't
    // track any of the keys it typically carries, so just skip its data.
    if (typeFlag === 'g') {
      offset += Math.ceil(size / 512) * 512
      continue
    }

    const name = pendingLongName ?? rawName
    pendingLongName = null

    // Skip directory entries (typeFlag '5') and symlinks/hardlinks
    if ((typeFlag === '0' || typeFlag === '\0') && name && !name.endsWith('/')) {
      files[name] = buffer.subarray(offset, offset + size)
    }
    offset += Math.ceil(size / 512) * 512
  }
  return files
}

// Builds the GNU-tar "././@LongLink" header + data blocks that precede a
// regular entry whenever its name doesn't fit the legacy 100-byte name field.
// Without this, maketar() silently truncated any name over 100 UTF-8 bytes
// (very achievable with a nested path, or even a short name once non-ASCII
// characters are UTF-8 encoded) since writeStringField only ever wrote the
// first `length` bytes into the fixed-size header field.
function makeLongNameBlocks(name: string): Uint8Array[] {
  const nameBytes = new TextEncoder().encode(name + '\0')
  const header = new Uint8Array(512)
  writeStringField(header, 0, 100, './@LongLink')
  writeOctalField(header, 100, 8, 0o644)
  writeOctalField(header, 108, 8, 0)
  writeOctalField(header, 116, 8, 0)
  writeOctalField(header, 124, 12, nameBytes.length)
  writeOctalField(header, 136, 12, Math.floor(Date.now() / 1000))
  header.fill(32, 148, 156)
  header[156] = 'L'.charCodeAt(0)
  writeStringField(header, 257, 6, 'ustar')
  header[263] = '0'.charCodeAt(0)
  header[264] = '0'.charCodeAt(0)
  let checksum = 0
  for (let i = 0; i < 512; i++) checksum += header[i]
  writeOctalField(header, 148, 8, checksum)
  const padded = new Uint8Array(Math.ceil(nameBytes.length / 512) * 512)
  padded.set(nameBytes)
  return [header, padded]
}

function maketar(entries: Record<string, Uint8Array>): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const [name, data] of Object.entries(entries)) {
    // Skip directory entries
    if (name.endsWith('/') || data.length === 0 && name.endsWith('/')) continue
    const nameBytes = new TextEncoder().encode(name)
    if (nameBytes.length > 100) blocks.push(...makeLongNameBlocks(name))
    const header = new Uint8Array(512)
    // Always also write a (possibly truncated) name into the standard field:
    // readers that don't understand the preceding 'L' block still get a
    // usable — if shortened — name instead of nothing, and readers that do
    // understand it (including our own untar()) use the full name from it.
    writeStringField(header, 0, 100, name)
    writeOctalField(header, 100, 8, 0o644)
    writeOctalField(header, 108, 8, 0)
    writeOctalField(header, 116, 8, 0)
    writeOctalField(header, 124, 12, data.length)
    writeOctalField(header, 136, 12, Math.floor(Date.now() / 1000))
    header.fill(32, 148, 156)
    header[156] = '0'.charCodeAt(0)
    writeStringField(header, 257, 6, 'ustar')
    header[263] = '0'.charCodeAt(0)
    header[264] = '0'.charCodeAt(0)
    let checksum = 0
    for (let i = 0; i < 512; i++) checksum += header[i]
    writeOctalField(header, 148, 8, checksum)
    const padded = new Uint8Array(Math.ceil(data.length / 512) * 512)
    padded.set(data)
    blocks.push(header, padded)
  }
  blocks.push(new Uint8Array(1024))
  const total = blocks.reduce((s, b) => s + b.length, 0)
  const out = new Uint8Array(total)
  let pos = 0
  for (const b of blocks) { out.set(b, pos); pos += b.length }
  return out
}

function isTar(data: Uint8Array): boolean {
  if (data.length < 512) return false
  const magic = new TextDecoder().decode(data.subarray(257, 263))
  return magic.startsWith('ustar')
}

// FIX (MEDIUM): filter out directory entries (keys ending in '/') from
// fflate.unzipSync results before passing to maketar or zipSync.
function filterFiles(entries: Record<string, Uint8Array>): Record<string, Uint8Array> {
  const result: Record<string, Uint8Array> = {}
  for (const [k, v] of Object.entries(entries)) {
    if (!k.endsWith('/')) result[k] = v
  }
  return result
}

export async function convertArchive(file: File, outputFormat: string, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted()
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const data = new Uint8Array(await fileToArrayBuffer(file))

  // ── ZIP → TAR ──────────────────────────────────────────────────────────────
  if (ext === 'zip' && outputFormat === 'tar') {
    const unzipped = filterFiles(fflate.unzipSync(data))
    if (Object.keys(unzipped).length === 0) throw new Error('ZIP archive is empty or contains only directories')
    signal?.throwIfAborted()
    return new Blob([new Uint8Array(maketar(unzipped))], { type: 'application/x-tar' })
  }

  // ── ZIP → GZ ───────────────────────────────────────────────────────────────
  if (ext === 'zip' && outputFormat === 'gz') {
    const unzipped = filterFiles(fflate.unzipSync(data))
    const entries = Object.entries(unzipped)
    if (entries.length === 0) throw new Error('ZIP archive is empty or contains only directories')
    signal?.throwIfAborted()
    if (entries.length === 1) {
      const [, fileData] = entries[0]
      return new Blob([fflate.gzipSync(fileData, { level: 6 })], { type: 'application/gzip' })
    }
    const tarBytes = maketar(Object.fromEntries(entries))
    signal?.throwIfAborted()
    return new Blob([fflate.gzipSync(tarBytes, { level: 6 })], { type: 'application/gzip' })
  }

  // ── TAR → ZIP ──────────────────────────────────────────────────────────────
  if (ext === 'tar' && outputFormat === 'zip') {
    const files = untar(data)
    if (Object.keys(files).length === 0) throw new Error('TAR archive appears to be empty or unreadable')
    signal?.throwIfAborted()
    return new Blob([fflate.zipSync(files, { level: 6 })], { type: 'application/zip' })
  }

  // ── TAR → GZ ───────────────────────────────────────────────────────────────
  if (ext === 'tar' && outputFormat === 'gz') {
    return new Blob([fflate.gzipSync(data, { level: 6 })], { type: 'application/gzip' })
  }

  // ── GZ/TGZ → ZIP ──────────────────────────────────────────────────────────
  if ((ext === 'gz' || ext === 'gzip' || ext === 'tgz') && outputFormat === 'zip') {
    let inner: Uint8Array
    try { inner = fflate.gunzipSync(data) }
    catch { throw new Error('Failed to decompress .gz file — it may be corrupt or not a valid gzip archive') }
    signal?.throwIfAborted()

    if (isTar(inner)) {
      const tarFiles = untar(inner)
      if (Object.keys(tarFiles).length > 0) {
        return new Blob([fflate.zipSync(tarFiles, { level: 6 })], { type: 'application/zip' })
      }
      // It IS a tar, just one with nothing extractable (directories only) —
      // give the same clear error as the other empty-archive cases above,
      // rather than falling through and silently zipping the raw, still-
      // tar-formatted bytes as if they were one opaque "file".
      throw new Error('Archive contains no files to convert (directories only)')
    }
    const innerName = file.name
      .replace(/\.tgz$/i, '.tar').replace(/\.tar\.gz$/i, '.tar').replace(/\.(gz|gzip)$/i, '') || 'file'
    return new Blob([fflate.zipSync({ [innerName]: inner }, { level: 6 })], { type: 'application/zip' })
  }

  // ── GZ/TGZ → TAR ──────────────────────────────────────────────────────────
  if ((ext === 'gz' || ext === 'gzip' || ext === 'tgz') && outputFormat === 'tar') {
    let inner: Uint8Array
    try { inner = fflate.gunzipSync(data) }
    catch { throw new Error('Failed to decompress .gz file — it may be corrupt or not a valid gzip archive') }
    return new Blob([new Uint8Array(inner)], { type: 'application/x-tar' })
  }

  // ── TGZ → GZ ──────────────────────────────────────────────────────────────
  if (ext === 'tgz' && outputFormat === 'gz') {
    return new Blob([data], { type: 'application/gzip' })
  }

  throw new Error(`Unsupported archive conversion: .${ext} → .${outputFormat}`)
}