import { fileToArrayBuffer } from '@/lib/utils'

const FONT_MIME: Record<string, string> = {
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
}

export async function convertFont(file: File, outputFormat: string): Promise<Blob> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
  const buffer = await fileToArrayBuffer(file)

  // Normalize every input down to a plain SFNT (TTF/OTF) buffer first, then
  // branch only on the *output* format below. opentype.js can't parse WOFF2
  // (it uses a totally different, dictionary-coded glyf table), so that input
  // is decoded with wawoff2 instead of being fed into opentype.parse like the
  // others.
  let sfnt: ArrayBuffer

  if (ext === 'woff2') {
    const wawoff2 = await import('wawoff2')
    const decompressed = await wawoff2.decompress(new Uint8Array(buffer))
    sfnt = new Uint8Array(decompressed).buffer
  } else {
    const opentype = await import('opentype.js')
    const font = opentype.parse(buffer)
    sfnt = (font as unknown as { toArrayBuffer(): ArrayBuffer }).toArrayBuffer()
  }

  if (outputFormat === 'ttf' || outputFormat === 'otf')
    return new Blob([sfnt], { type: FONT_MIME[outputFormat] })

  if (outputFormat === 'woff')
    return new Blob([wrapSfntAsWoff(sfnt)], { type: FONT_MIME.woff })

  if (outputFormat === 'woff2') {
    const wawoff2 = await import('wawoff2')
    const compressed = await wawoff2.compress(new Uint8Array(sfnt))
    return new Blob([new Uint8Array(compressed)], { type: FONT_MIME.woff2 })
  }

  throw new Error(`Unsupported font output: .${outputFormat}`)
}

function wrapSfntAsWoff(sfnt: ArrayBuffer): ArrayBuffer {
  const src = new DataView(sfnt)
  const numTables = src.getUint16(4)

  const tables: { tag: string; checksum: number; offset: number; length: number }[] = []
  for (let i = 0; i < numTables; i++) {
    const b = 12 + i * 16
    tables.push({
      tag: String.fromCharCode(src.getUint8(b), src.getUint8(b + 1), src.getUint8(b + 2), src.getUint8(b + 3)),
      checksum: src.getUint32(b + 4),
      offset: src.getUint32(b + 8),
      length: src.getUint32(b + 12),
    })
  }

  const hdrSize = 44
  const dirSize = numTables * 20
  const dataSize = tables.reduce((s, t) => s + Math.ceil(t.length / 4) * 4, 0)
  const woff = new ArrayBuffer(hdrSize + dirSize + dataSize)
  const dst = new DataView(woff)
  const dstBytes = new Uint8Array(woff)
  const srcBytes = new Uint8Array(sfnt)

  dst.setUint32(0, 0x774F4646)        // 'wOFF'
  dst.setUint32(4, src.getUint32(0))  // flavor
  dst.setUint32(8, woff.byteLength)
  dst.setUint16(12, numTables)
  dst.setUint16(14, 0)
  dst.setUint32(16, sfnt.byteLength)
  // remaining header fields are 0

  let offset = hdrSize + dirSize
  tables.forEach((t, i) => {
    const d = hdrSize + i * 20
    for (let c = 0; c < 4; c++) dst.setUint8(d + c, t.tag.charCodeAt(c))
    dst.setUint32(d + 4, offset)
    dst.setUint32(d + 8, t.length)
    dst.setUint32(d + 12, t.length)
    dst.setUint32(d + 16, t.checksum)
    dstBytes.set(srcBytes.subarray(t.offset, t.offset + t.length), offset)
    offset += Math.ceil(t.length / 4) * 4
  })

  return woff
}