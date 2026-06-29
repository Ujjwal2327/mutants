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

    // FIX: PAX extended header (type 'x' or 'g') — skip the metadata block
    if (typeFlag === 'x' || typeFlag === 'g') {
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

function maketar(entries: Record<string, Uint8Array>): Uint8Array {
  const blocks: Uint8Array[] = []
  for (const [name, data] of Object.entries(entries)) {
    // Skip directory entries
    if (name.endsWith('/') || data.length === 0 && name.endsWith('/')) continue
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

export async function convertArchive(file: File, outputFormat: string): Promise<Blob> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const data = new Uint8Array(await fileToArrayBuffer(file))

  // ── ZIP → TAR ──────────────────────────────────────────────────────────────
  if (ext === 'zip' && outputFormat === 'tar') {
    const unzipped = filterFiles(fflate.unzipSync(data))
    if (Object.keys(unzipped).length === 0) throw new Error('ZIP archive is empty or contains only directories')
    return new Blob([new Uint8Array(maketar(unzipped))], { type: 'application/x-tar' })
  }

  // ── ZIP → GZ ───────────────────────────────────────────────────────────────
  if (ext === 'zip' && outputFormat === 'gz') {
    const unzipped = filterFiles(fflate.unzipSync(data))
    const entries = Object.entries(unzipped)
    if (entries.length === 0) throw new Error('ZIP archive is empty or contains only directories')
    if (entries.length === 1) {
      const [, fileData] = entries[0]
      return new Blob([fflate.gzipSync(fileData, { level: 6 })], { type: 'application/gzip' })
    }
    const tarBytes = maketar(Object.fromEntries(entries))
    return new Blob([fflate.gzipSync(tarBytes, { level: 6 })], { type: 'application/gzip' })
  }

  // ── TAR → ZIP ──────────────────────────────────────────────────────────────
  if (ext === 'tar' && outputFormat === 'zip') {
    const files = untar(data)
    if (Object.keys(files).length === 0) throw new Error('TAR archive appears to be empty or unreadable')
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

    if (isTar(inner)) {
      const tarFiles = untar(inner)
      if (Object.keys(tarFiles).length > 0) {
        return new Blob([fflate.zipSync(tarFiles, { level: 6 })], { type: 'application/zip' })
      }
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