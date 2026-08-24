// Synchronous raster-image dimension parsing from a data: URI.
//
// Reading real image dimensions normally means waiting on an Image
// element's onload, but the PDF/DOCX generators that use this walk the
// document tree synchronously and recursively — making that walk async
// just to read image sizes would be a much larger change. PNG/GIF/JPEG all
// encode their pixel dimensions at a fixed, simple, and fully
// synchronous-to-parse location in their own file headers, so this reads
// them directly from the decoded bytes instead, letting inline <img>
// support slot into the existing synchronous tree walks unchanged.
export interface ParsedImage {
  width: number
  height: number
  mime: 'image/png' | 'image/jpeg' | 'image/gif'
  bytes: Uint8Array
}

export function parseDataUriImage(src: string): ParsedImage | null {
  const match = /^data:([\w/+.-]+);base64,([\s\S]*)$/.exec(src.trim())
  if (!match) return null
  let bytes: Uint8Array
  try {
    const binary = atob(match[2].replace(/\s/g, ''))
    bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  } catch {
    return null
  }

  // PNG: 8-byte signature, then the IHDR chunk: length(4) + "IHDR"(4) + width(4) + height(4)
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: view.getUint32(16), height: view.getUint32(20), mime: 'image/png', bytes }
  }
  // GIF: 6-byte signature, then width(2 LE) + height(2 LE)
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: view.getUint16(6, true), height: view.getUint16(8, true), mime: 'image/gif', bytes }
  }
  // JPEG: scan marker segments for an SOFn (start-of-frame) marker, which
  // carries height then width immediately after its 2-byte segment-length
  // field. Markers with no length field (SOI/RST/TEM) are skipped safely.
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    let offset = 2
    while (offset <= bytes.length - 9) {
      if (bytes[offset] !== 0xff) { offset++; continue }
      const marker = bytes[offset + 1]
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue }
      if (marker === 0xd9) break
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5), mime: 'image/jpeg', bytes }
      }
      const segLength = view.getUint16(offset + 2)
      if (segLength < 2) break
      offset += 2 + segLength
    }
  }
  return null
}
