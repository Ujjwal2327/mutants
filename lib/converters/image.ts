import { fileToArrayBuffer } from '@/lib/utils'

const MIME_MAP: Record<string, string> = {
  png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg',
  webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
}

const NEEDS_SPECIAL_DECODER = new Set(['tiff', 'ico', 'cur'])

function parseSvgViewBoxSize(svgText: string): { width: number; height: number } | null {
  const match = svgText.match(/viewBox\s*=\s*["']\s*[\d.+-]+\s+[\d.+-]+\s+([\d.]+)\s+([\d.]+)\s*["']/i)
  return match ? { width: parseFloat(match[1]), height: parseFloat(match[2]) } : null
}

function parseSvgExplicitSize(svgText: string): { width: number; height: number } | null {
  const wMatch = svgText.match(/\bwidth\s*=\s*["']?(\d+(?:\.\d+)?)(?:px)?["']?/i)
  const hMatch = svgText.match(/\bheight\s*=\s*["']?(\d+(?:\.\d+)?)(?:px)?["']?/i)
  if (!wMatch || !hMatch) return null
  // FIX: reject non-pixel units (%, em, rem, vw, vh, etc.).
  // The old regex captured the numeric part of "100%" as 100 and "10em" as 10,
  // causing SVGs with relative dimensions to be rendered at the wrong (tiny) size.
  // Check the character immediately after the full match; if it is a letter or '%'
  // then the value carries a non-pixel unit suffix — fall back to viewBox instead.
  const wEnd = svgText[wMatch.index! + wMatch[0].length] ?? ''
  const hEnd = svgText[hMatch.index! + hMatch[0].length] ?? ''
  if (/[%a-zA-Z]/.test(wEnd) || /[%a-zA-Z]/.test(hEnd)) return null
  return { width: parseFloat(wMatch[1]), height: parseFloat(hMatch[1]) }
}

async function decodeTiff(file: File): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  const UTIF = await import('utif')
  const buffer = await fileToArrayBuffer(file)
  const ifds = UTIF.decode(buffer)
  if (!ifds.length) throw new Error('TIFF file contains no images')
  UTIF.decodeImage(buffer, ifds[0])
  const rgba = UTIF.toRGBA8(ifds[0])
  const width = ifds[0].width as number
  const height = ifds[0].height as number
  const canvas = document.createElement('canvas')
  canvas.width = width; canvas.height = height
  const ctx = canvas.getContext('2d')!
  const imageData = ctx.createImageData(width, height)
  imageData.data.set(rgba)
  ctx.putImageData(imageData, 0, 0)
  return { canvas, width, height }
}

async function decodeIco(file: File): Promise<{ canvas: HTMLCanvasElement; width: number; height: number }> {
  const buffer = new Uint8Array(await fileToArrayBuffer(file))
  const view = new DataView(buffer.buffer)
  const count = view.getUint16(4, true)
  if (count === 0) throw new Error('Icon/cursor file contains no images')
  let bestIdx = 0, bestSize = 0
  for (let i = 0; i < count; i++) {
    const base = 6 + i * 16
    const w = buffer[base] || 256, h = buffer[base + 1] || 256
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
  canvas.width = width; canvas.height = height
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0)
  bitmap.close()
  return { canvas, width, height }
}

async function loadImageElement(file: File): Promise<{ img: HTMLImageElement; width: number; height: number }> {
  const isSvg = file.type === 'image/svg+xml' || file.name.toLowerCase().endsWith('.svg')
  const svgText = isSvg ? await file.text() : null
  const explicitSize = svgText ? parseSvgExplicitSize(svgText) : null
  const fallbackSize = svgText ? parseSvgViewBoxSize(svgText) : null
  const naturalScale = isSvg ? 2 : 1
  const objectUrl = URL.createObjectURL(file)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      let width = img.naturalWidth || explicitSize?.width || fallbackSize?.width || 800
      let height = img.naturalHeight || explicitSize?.height || fallbackSize?.height || 600
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
  canvas.width = width; canvas.height = height
  const ctx = canvas.getContext('2d')!
  if (fillWhite) { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, width, height) }
  ctx.drawImage(img, 0, 0, width, height)
  return canvas
}

function canvasToBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      (b) => {
        if (b && b.size > 0) return resolve(b)
        if (mime === 'image/avif') reject(new Error('AVIF encoding is only supported in Chromium-based browsers (Chrome, Edge, Opera). Try PNG or WebP instead.'))
        else reject(new Error(`This browser does not support encoding ${mime} images. Try PNG or JPEG instead.`))
      },
      mime, quality,
    ))
}

async function canvasToGif(canvas: HTMLCanvasElement, width: number, height: number): Promise<Blob> {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc')
  const ctx = canvas.getContext('2d')!
  const imageData = ctx.getImageData(0, 0, width, height)
  const palette = quantize(imageData.data, 256)
  const indexed = applyPalette(imageData.data, palette)
  const gif = GIFEncoder()
  gif.writeFrame(indexed, width, height, { palette })
  gif.finish()
  return new Blob([gif.bytesView()], { type: 'image/gif' })
}

export async function convertImage(file: File, outputFormat: string): Promise<Blob> {
  const ext = file.name.split('.').pop()?.toLowerCase() ?? ''

  // ── Special-decoder path (TIFF, ICO, CUR) ───────────────────────────────────
  if (NEEDS_SPECIAL_DECODER.has(ext)) {
    let srcCanvas: HTMLCanvasElement, width: number, height: number
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
  if (outputFormat === 'gif') return canvasToGif(drawToCanvas(img, width, height, true), width, height)
  const targetMime = MIME_MAP[outputFormat]
  if (!targetMime) throw new Error(`Unsupported image output format: ${outputFormat}`)
  const quality = ['jpeg', 'jpg', 'webp', 'avif'].includes(outputFormat) ? 0.92 : undefined
  const fillWhite = ['jpeg', 'jpg', 'bmp'].includes(outputFormat)
  return canvasToBlob(drawToCanvas(img, width, height, fillWhite), targetMime, quality)
}

// ── SVG wrapper ───────────────────────────────────────────────────────────────
function convertToSvgWrapper(img: HTMLImageElement, width: number, height: number): Blob {
  return canvasToSvgWrapper(drawToCanvas(img, width, height, false), width, height)
}
function canvasToSvgWrapper(canvas: HTMLCanvasElement, width: number, height: number): Blob {
  const dataUrl = canvas.toDataURL('image/png')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n  <image width="${width}" height="${height}" href="${dataUrl}" />\n</svg>`
  return new Blob([svg], { type: 'image/svg+xml' })
}

// ── PDF ───────────────────────────────────────────────────────────────────────
async function convertToPdf(img: HTMLImageElement, width: number, height: number): Promise<Blob> {
  return canvasToPdf(drawToCanvas(img, width, height, false), width, height)
}
async function canvasToPdf(canvas: HTMLCanvasElement, width: number, height: number): Promise<Blob> {
  const { jsPDF } = await import('jspdf')
  const dataUrl = canvas.toDataURL('image/png')
  const pageWidth = Math.max(1, width * 0.75)
  const pageHeight = Math.max(1, height * 0.75)
  const doc = new jsPDF({ orientation: pageWidth > pageHeight ? 'landscape' : 'portrait', unit: 'pt', format: [pageWidth, pageHeight] })
  doc.addImage(dataUrl, 'PNG', 0, 0, pageWidth, pageHeight)
  return doc.output('blob')
}

// ── TIFF ──────────────────────────────────────────────────────────────────────
async function convertToTiff(img: HTMLImageElement, width: number, height: number): Promise<Blob> {
  return canvasToTiff(drawToCanvas(img, width, height, false), width, height)
}
async function canvasToTiff(canvas: HTMLCanvasElement, width: number, height: number): Promise<Blob> {
  const UTIF = await import('utif')
  const ctx = canvas.getContext('2d')!
  const rgba = ctx.getImageData(0, 0, width, height).data
  const tiffBuffer = UTIF.encodeImage(rgba, width, height)
  return new Blob([new Uint8Array(tiffBuffer)], { type: 'image/tiff' })
}

// ── ICO / CUR ─────────────────────────────────────────────────────────────────
async function convertToIco(img: HTMLImageElement, width: number, height: number): Promise<Blob> {
  return canvasToIco(drawToCanvas(img, width, height, false), width, height)
}
async function convertToCur(img: HTMLImageElement, width: number, height: number): Promise<Blob> {
  return canvasToCur(drawToCanvas(img, width, height, false), width, height)
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
  // FIX (MEDIUM): preserve aspect ratio when squashing to ICO size.
  // Previously used Math.max(w,h) as both dimensions, distorting non-square images.
  // Now fit within 256×256 while maintaining aspect ratio, padding with transparency.
  const MAX = 256
  const ratio = Math.min(MAX / width, MAX / height, 1)
  const fitW = Math.round(width * ratio)
  const fitH = Math.round(height * ratio)
  const size = Math.max(fitW, fitH, 16)

  // Draw centred on a square canvas
  const square = document.createElement('canvas')
  square.width = size; square.height = size
  const ctx = square.getContext('2d')!
  ctx.clearRect(0, 0, size, size)
  const offsetX = Math.round((size - fitW) / 2)
  const offsetY = Math.round((size - fitH) / 2)
  ctx.drawImage(canvas, 0, 0, width, height, offsetX, offsetY, fitW, fitH)

  const pngBlob = await canvasToBlob(square, 'image/png')
  const pngBytes = new Uint8Array(await pngBlob.arrayBuffer())

  const headerSize = 6, entrySize = 16
  const ico = new Uint8Array(headerSize + entrySize + pngBytes.length)
  const view = new DataView(ico.buffer)

  view.setUint16(0, 0, true)
  view.setUint16(2, cursor ? 2 : 1, true)
  view.setUint16(4, 1, true)

  const dim = size >= 256 ? 0 : size
  ico[6] = dim; ico[7] = dim; ico[8] = 0

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