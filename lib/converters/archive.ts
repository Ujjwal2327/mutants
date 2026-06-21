import { fileToArrayBuffer } from '@/lib/utils'
import * as fflate from 'fflate'

function readOctal(bytes: Uint8Array, start: number, length: number): number {
  const str = new TextDecoder().decode(bytes.subarray(start, start + length)).replace(/\0.*$/, '').trim()
  return str ? parseInt(str, 8) : 0
}

function writeOctalField(view: Uint8Array, start: number, length: number, value: number) {
  const str = value.toString(8).padStart(length - 1, '0')
  for (let i = 0; i < length - 1; i++) view[start + i] = str.charCodeAt(i)
  view[start + length - 1] = 0
}

function writeStringField(view: Uint8Array, start: number, length: number, value: string) {
  for (let i = 0; i < Math.min(value.length, length); i++) view[start + i] = value.charCodeAt(i)
}

// Minimal USTAR reader/writer
function untar(buffer: Uint8Array): Record<string, Uint8Array> {
  const files: Record<string, Uint8Array> = {}
  let offset = 0

  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((b) => b === 0)) break

    const name = new TextDecoder().decode(header.subarray(0, 100)).replace(/\0.*$/, '')
    const size = readOctal(header, 124, 12)
    const typeFlag = String.fromCharCode(header[156])

    offset += 512
    if ((typeFlag === '0' || typeFlag === '\0') && name) {
      files[name] = buffer.subarray(offset, offset + size)
    }
    offset += Math.ceil(size / 512) * 512
  }

  return files
}

function maketar(entries: Record<string, Uint8Array>): Uint8Array {
  const blocks: Uint8Array[] = []

  for (const [name, data] of Object.entries(entries)) {
    const header = new Uint8Array(512)
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

// Check if bytes are gzip-compressed (magic bytes 1F 8B)
function isGzip(data: Uint8Array): boolean {
  return data[0] === 0x1f && data[1] === 0x8b
}

// Check if gunzipped data looks like a tar archive
function isTar(data: Uint8Array): boolean {
  // TAR: bytes 257–262 are 'ustar' magic, or check for all-zero 512-byte blocks
  if (data.length < 512) return false
  const magic = new TextDecoder().decode(data.subarray(257, 263))
  return magic.startsWith('ustar') || magic.startsWith('\0')
}

export async function convertArchive(file: File, outputFormat: string): Promise<Blob> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const data = new Uint8Array(await fileToArrayBuffer(file))

  // ── ZIP → TAR ──────────────────────────────────────────────────────────────
  if (ext === 'zip' && outputFormat === 'tar') {
    const unzipped = fflate.unzipSync(data)
    if (Object.keys(unzipped).length === 0) throw new Error('ZIP archive is empty')
    return new Blob([new Uint8Array(maketar(unzipped))], { type: 'application/x-tar' })
  }

  // ── ZIP → GZ (produces .tar.gz for multi-file, plain .gz for single-file) ──
  if (ext === 'zip' && outputFormat === 'gz') {
    const unzipped = fflate.unzipSync(data)
    const entries = Object.entries(unzipped)
    if (entries.length === 0) throw new Error('ZIP archive is empty')
    if (entries.length === 1) {
      const [, fileData] = entries[0]
      return new Blob([fflate.gzipSync(fileData, { level: 6 })], { type: 'application/gzip' })
    }
    // Multi-file: build tar first, then gzip (output is a .tar.gz)
    const tarBytes = maketar(Object.fromEntries(entries))
    return new Blob([fflate.gzipSync(tarBytes, { level: 6 })], { type: 'application/gzip' })
  }

  // ── TAR → ZIP ──────────────────────────────────────────────────────────────
  if (ext === 'tar' && outputFormat === 'zip') {
    const files = untar(data)
    if (Object.keys(files).length === 0) throw new Error('TAR archive appears to be empty or unreadable')
    return new Blob([fflate.zipSync(files, { level: 6 })], { type: 'application/zip' })
  }

  // ── TAR → GZ (compress the tar stream) ────────────────────────────────────
  if (ext === 'tar' && outputFormat === 'gz') {
    return new Blob([fflate.gzipSync(data, { level: 6 })], { type: 'application/gzip' })
  }

  // ── GZ/TGZ → ZIP ──────────────────────────────────────────────────────────
  if ((ext === 'gz' || ext === 'gzip' || ext === 'tgz') && outputFormat === 'zip') {
    let inner: Uint8Array
    try {
      inner = fflate.gunzipSync(data)
    } catch {
      throw new Error('Failed to decompress .gz file — it may be corrupt or not a valid gzip archive')
    }

    // If the inner content is a tar archive, extract individual files
    if (isTar(inner)) {
      const tarFiles = untar(inner)
      if (Object.keys(tarFiles).length > 0) {
        return new Blob([fflate.zipSync(tarFiles, { level: 6 })], { type: 'application/zip' })
      }
    }

    // Single file: strip .gz/.tgz extension to recover inner filename
    const innerName = file.name
      .replace(/\.tgz$/i, '.tar')
      .replace(/\.tar\.gz$/i, '.tar')
      .replace(/\.(gz|gzip)$/i, '')
      || 'file'
    return new Blob([fflate.zipSync({ [innerName]: inner }, { level: 6 })], { type: 'application/zip' })
  }

  // ── GZ/TGZ → TAR (decompress, optionally extract inner tar) ───────────────
  if ((ext === 'gz' || ext === 'gzip' || ext === 'tgz') && outputFormat === 'tar') {
    let inner: Uint8Array
    try {
      inner = fflate.gunzipSync(data)
    } catch {
      throw new Error('Failed to decompress .gz file — it may be corrupt or not a valid gzip archive')
    }
    // If already a tar, just return it
    return new Blob([new Uint8Array(inner)], { type: 'application/x-tar' })
  }

  // ── TGZ → GZ (already gzip; extract as plain tar.gz — same bytes) ─────────
  if (ext === 'tgz' && outputFormat === 'gz') {
    // .tgz IS a .tar.gz, just return the same bytes under .gz extension
    return new Blob([data], { type: 'application/gzip' })
  }

  throw new Error(`Unsupported archive conversion: .${ext} → .${outputFormat}`)
}