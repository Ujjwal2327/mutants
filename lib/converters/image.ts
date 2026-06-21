import { fileToArrayBuffer } from '@/lib/utils'

const MIME_MAP: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  bmp: 'image/bmp',
  avif: 'image/avif',
  // NOTE: 'gif' intentionally omitted — canvas.toBlob('image/gif') is NOT
  // supported in any modern browser. GIF output is handled via gifenc below.
}

// Formats that browsers cannot reliably decode via <img>/Canvas.
const NEEDS_SPECIAL_DECODER = new Set(['tiff', 'ico', 'cur'])

function parseSvgViewBoxSize(svgText: string): { width: number; height: number } | null {
  const match = svgText.match(
    /viewBox\s*=\s*["']\s*[\d.+-]+\s+[\d.+-]+\s+([\d.]+)\s+([\d.]+)\s*["']/i,
  )
  return match ? { width: parseFloat(match[1]), height: parseFloat(match[2]) } : null
}

function parseSvgExplicitSize(svgText: string): { width: number; height: number } | null {
  const wMatch = svgText.match(/\bwidth\s*=\s*["']?([\d.]+)(?:px)?["']?/i)
  const hMatch = svgText.match(/\bheight\s*=\s*["']?([\d.]+)(?:px)?["']?/i)
  if (wMatch && hMatch) return { width: parseFloat(wMatch[1]), height: parseFloat(hMatch[1]) }
  return null
}

// Decode a TIFF file using the `utif` library and return an RGBA canvas.
async function decodeTiff(
  file: File,
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  const UTIF = await import('utif')
  const buffer = await fileToArrayBuffer(file)
  const ifds = UTIF.decode(buffer)
  if (!ifds.length) throw new Error('TIFF file contains no images')
  UTIF.decodeImage(buffer, ifds[0])
  const rgba = UTIF.toRGBA8(ifds[0])
  const width = ifds[0].width as number
  const height = ifds[0].height as number
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  const imageData = ctx.createImageData(width, height)
  imageData.data.set(rgba)
  ctx.putImageData(imageData, 0, 0)
  return { canvas, width, height }
}

// Decode an ICO or CUR file.
async function decodeIco(
  file: File,
): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  const buffer = new Uint8Array(await fileToArrayBuffer(file))
  const view = new DataView(buffer.buffer)

  const count = view.getUint16(4, true)
  if (count === 0) throw new Error('Icon/cursor file contains no images')

  let bestIdx = 0
  let bestSize = 0
  for (let i = 0; i < count; i++) {
    const base = 6 + i * 16
    const w = buffer[base] || 256
    const h = buffer[base + 1] || 256
    if (w * h > bestSize) { bestSize = w * h; bestIdx = i }
  }

  const base = 6 + bestIdx * 16
  const dataSize = view.getUint32(base + 8, true)
  const dataOffset = view.getUint32(base + 12, true)
  const imageBytes = buffer.subarray(dataOffset, dataOffset + dataSize)

  const isPng = imageBytes[0] === 0x89 && imageBytes[1] === 0x50

  const blob = new Blob([imageBytes], { type: isPng ? 'image/png' : 'image/bmp' })
  const bitmap = await createImageBitmap(blob)
  const { width, height } = bitmap
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  bitmap.close()
  return { canvas, width, height }
}

async function loadImageElement(
  file: File,
): Promise<{ img: HTMLImageElement; width: number; height: number }> {
  const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')

  const svgText = isSvg ? await file.text() : null
  // Try explicit width/height first, then viewBox, then default
  const explicitSize = svgText ? parseSvgExplicitSize(svgText) : null
  const fallbackSize = svgText ? parseSvgViewBoxSize(svgText) : null

  // Prefer rasterising SVGs at 2× the declared size for better quality
  const naturalScale = isSvg ? 2 : 1

  const objectUrl = URL.createObjectURL(file)

  return new Promise((resolve, reject) => {
    const img = new Image()

    img.onload = () => {
      let width = img.naturalWidth || explicitSize?.width || fallbackSize?.width || 800
      let height = img.naturalHeight || explicitSize?.height || fallbackSize?.height || 600
      // Scale SVGs up for quality
      width = Math.round(width * naturalScale)
      height = Math.round(height * naturalScale)
      URL.revokeObjectURL(objectUrl)
      resolve({ img, width, height })
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('Failed to load image — the file may be corrupt or unsupported by this browser'))
    }

    img.src = objectUrl
  })
}

function drawToCanvas(
  img: HTMLImageElement | HTMLCanvasElement,
  width: number,
  height: number,
  fillWhite: boolean,
): HTMLCanvasElement {
  if (img instanceof HTMLCanvasElement && !fillWhite) return img

  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  if (fillWhite) {
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, width, height)
  }
  ctx.drawImage(img, 0, 0, width, height)
  return canvas
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => {
        if (b && b.size > 0) return resolve(b)
        if (mime === 'image/avif') {
          reject(new Error('AVIF encoding is only supported in Chromium-based browsers (Chrome, Edge, Opera). Try PNG or WebP instead.'))
        } else {
          reject(new Error(`This browser does not support encoding ${mime} images. Try PNG or JPEG instead.`))
        }
      },
      mime,
      quality,
    ),
  )
}

// ── GIF encoder ──────────────────────────────────────────────────────────────
async function canvasToGif(canvas: HTMLCanvasElement, width: number, height: number): Promise<Blob> {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc')

  const ctx = canvas.getContext('2d')!
  const imageData = ctx.getImageData(0, 0, width, height)
  const rgba = imageData.data

  const palette = quantize(rgba, 256)
  const indexed = applyPalette(rgba, palette)

  const gif = GIFEncoder()
  gif.writeFrame(indexed, width, height, { palette })
  gif.finish()

  return new Blob([gif.bytesView()], { type: 'image/gif' })
}

export async function convertImage(file: File, outputFormat: string): Promise<Blob> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''

  // ── Special-decoder path (TIFF, ICO, CUR input) ─────────────────────────────
  if (NEEDS_SPECIAL_DECODER.has(ext)) {
    let srcCanvas: HTMLCanvasElement
    let width: number
    let height: number

    if (ext === 'tiff') {
      ; ({ canvas: srcCanvas, width, height } = await decodeTiff(file))
    } else {
      ; ({ canvas: srcCanvas, width, height } = await decodeIco(file))
    }

    if (outputFormat === 'svg') return canvasToSvgWrapper(srcCanvas, width, height)
    if (outputFormat === 'pdf') return canvasToPdf(srcCanvas, width, height)
    if (outputFormat === 'ico') return canvasToIco(srcCanvas, width, height)
    if (outputFormat === 'cur') return canvasToCur(srcCanvas, width, height)
    if (outputFormat === 'tiff') return canvasToTiff(srcCanvas, width, height)
    if (outputFormat === 'gif') return canvasToGif(srcCanvas, width, height)

    const targetMime = MIME_MAP[outputFormat]
    if (!targetMime) throw new Error(`Unsupported image output format: ${outputFormat}`)

    const fillWhite = ['jpeg', 'jpg', 'bmp'].includes(outputFormat)
    const quality = ['jpeg', 'jpg', 'webp', 'avif'].includes(outputFormat) ? 0.92 : undefined
    return canvasToBlob(drawToCanvas(srcCanvas, width, height, fillWhite), targetMime, quality)
  }

  // ── Standard browser-decoded path ───────────────────────────────────────────
  const { img, width, height } = await loadImageElement(file)

  if (outputFormat === 'svg') return convertToSvgWrapper(img, width, height)
  if (outputFormat === 'pdf') return convertToPdf(img, width, height)
  if (outputFormat === 'ico') return convertToIco(img, width, height)
  if (outputFormat === 'cur') return convertToCur(img, width, height)
  if (outputFormat === 'tiff') return convertToTiff(img, width, height)
  if (outputFormat === 'gif') {
    // Fill white for GIF since it has no alpha support
    const canvas = drawToCanvas(img, width, height, true)
    return canvasToGif(canvas, width, height)
  }

  const targetMime = MIME_MAP[outputFormat]
  if (!targetMime) throw new Error(`Unsupported image output format: ${outputFormat}`)

  const quality = ['jpeg', 'jpg', 'webp', 'avif'].includes(outputFormat) ? 0.92 : undefined
  const fillWhite = ['jpeg', 'jpg', 'bmp'].includes(outputFormat)
  const canvas = drawToCanvas(img, width, height, fillWhite)
  return canvasToBlob(canvas, targetMime, quality)
}

// ── SVG wrapper helpers ──────────────────────────────────────────────────────
// For raster→SVG: embed as base64 PNG inside an SVG container. This preserves
// the image faithfully (it is not vector tracing) but produces a valid, scalable
// SVG file that works in all SVG viewers. Vector tracing would require a
// dedicated library (e.g. potrace) which adds significant bundle size.
function convertToSvgWrapper(img: HTMLImageElement, width: number, height: number): Blob {
  const canvas = drawToCanvas(img, width, height, false)
  return canvasToSvgWrapper(canvas, width, height)
}

function canvasToSvgWrapper(canvas: HTMLCanvasElement, width: number, height: number): Blob {
  const dataUrl = canvas.toDataURL('image/png')
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n` +
    `  <image width="${width}" height="${height}" href="${dataUrl}" />\n` +
    `</svg>`
  return new Blob([svg], { type: 'image/svg+xml' })
}

// ── PDF helpers ──────────────────────────────────────────────────────────────

async function convertToPdf(img: HTMLImageElement, width: number, height: number): Promise<Blob> {
  const canvas = drawToCanvas(img, width, height, false)
  return canvasToPdf(canvas, width, height)
}

async function canvasToPdf(canvas: HTMLCanvasElement, width: number, height: number): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const dataUrl = canvas.toDataURL('image/png')

  // Treat source pixels as 96dpi and convert to points (72/in)
  const pageWidth = Math.max(1, width * 0.75)
  const pageHeight = Math.max(1, height * 0.75)

  const doc = new jsPDF({
    orientation: pageWidth > pageHeight ? 'landscape' : 'portrait',
    unit: 'pt',
    format: [pageWidth, pageHeight],
  })
  doc.addImage(dataUrl, 'PNG', 0, 0, pageWidth, pageHeight)
  return doc.output('blob')
}

// ── TIFF helpers ─────────────────────────────────────────────────────────────

async function convertToTiff(img: HTMLImageElement, width: number, height: number): Promise<Blob> {
  const canvas = drawToCanvas(img, width, height, false)
  return canvasToTiff(canvas, width, height)
}

async function canvasToTiff(canvas: HTMLCanvasElement, width: number, height: number): Promise<Blob> {
  const UTIF = await import('utif')
  const ctx = canvas.getContext('2d')!
  const rgba = ctx.getImageData(0, 0, width, height).data
  const tiffBuffer = UTIF.encodeImage(rgba, width, height)
  return new Blob([new Uint8Array(tiffBuffer)], { type: 'image/tiff' })
}

// ── ICO / CUR helpers ────────────────────────────────────────────────────────

async function convertToIco(img: HTMLImageElement, width: number, height: number): Promise<Blob> {
  const canvas = drawToCanvas(img, width, height, false)
  return canvasToIco(canvas, width, height)
}

async function convertToCur(img: HTMLImageElement, width: number, height: number): Promise<Blob> {
  const canvas = drawToCanvas(img, width, height, false)
  return canvasToCur(canvas, width, height)
}

async function canvasToIco(canvas: HTMLCanvasElement, width: number, height: number): Promise<Blob> {
  return canvasToIconFamily(canvas, width, height, false)
}

async function canvasToCur(canvas: HTMLCanvasElement, width: number, height: number): Promise<Blob> {
  return canvasToIconFamily(canvas, width, height, true)
}

async function canvasToIconFamily(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  cursor: boolean,
): Promise<Blob> {
  const size = Math.min(256, Math.max(width, height, 16))
  const sized = drawToCanvas(canvas, size, size, false)
  const pngBlob = await canvasToBlob(sized, 'image/png')
  const pngBytes = new Uint8Array(await pngBlob.arrayBuffer())

  const headerSize = 6
  const entrySize = 16
  const ico = new Uint8Array(headerSize + entrySize + pngBytes.length)
  const view = new DataView(ico.buffer)

  view.setUint16(0, 0, true)
  view.setUint16(2, cursor ? 2 : 1, true)
  view.setUint16(4, 1, true)

  const dim = size >= 256 ? 0 : size
  ico[6] = dim
  ico[7] = dim
  ico[8] = 0

  if (cursor) {
    view.setUint16(10, Math.floor(size / 2), true)
    view.setUint16(12, Math.floor(size / 2), true)
  } else {
    ico[9] = 0
    view.setUint16(10, 1, true)
    view.setUint16(12, 32, true)
  }

  view.setUint32(14, pngBytes.length, true)
  view.setUint32(18, headerSize + entrySize, true)

  ico.set(pngBytes, headerSize + entrySize)
  return new Blob([ico], { type: 'image/x-icon' })
}