import type { FormatInfo, FormatGroup } from '@/types/converter'

export const FORMAT_REGISTRY: Record<string, FormatInfo> = {
  // ── Images ──────────────────────────────────────────────────────────────────
  png: { group: 'Image', mimeType: 'image/png', targets: ['jpeg', 'webp', 'bmp', 'gif', 'avif', 'pdf', 'svg', 'ico', 'cur', 'tiff'], converterModule: 'image' },
  jpeg: { group: 'Image', mimeType: 'image/jpeg', targets: ['png', 'webp', 'bmp', 'gif', 'avif', 'pdf', 'svg', 'ico', 'cur', 'tiff'], converterModule: 'image' },
  jpg: { group: 'Image', mimeType: 'image/jpeg', targets: ['png', 'webp', 'bmp', 'gif', 'avif', 'pdf', 'svg', 'ico', 'cur', 'tiff'], converterModule: 'image' },
  webp: { group: 'Image', mimeType: 'image/webp', targets: ['png', 'jpeg', 'bmp', 'gif', 'avif', 'pdf', 'svg', 'ico', 'cur', 'tiff'], converterModule: 'image' },
  bmp: { group: 'Image', mimeType: 'image/bmp', targets: ['png', 'jpeg', 'webp', 'gif', 'avif', 'pdf', 'svg', 'ico', 'cur', 'tiff'], converterModule: 'image' },
  gif: { group: 'Image', mimeType: 'image/gif', targets: ['png', 'jpeg', 'webp', 'bmp', 'avif', 'pdf', 'svg', 'ico', 'cur', 'tiff'], converterModule: 'image' },
  avif: { group: 'Image', mimeType: 'image/avif', targets: ['png', 'jpeg', 'webp', 'bmp', 'gif', 'pdf', 'svg', 'ico', 'cur', 'tiff'], converterModule: 'image' },
  ico: { group: 'Image', mimeType: 'image/x-icon', targets: ['png', 'jpeg', 'webp', 'bmp', 'gif', 'avif', 'pdf', 'svg', 'cur', 'tiff'], converterModule: 'image' },
  cur: { group: 'Image', mimeType: 'image/x-icon', targets: ['png', 'jpeg', 'webp', 'bmp', 'gif', 'avif', 'pdf', 'svg', 'ico', 'tiff'], converterModule: 'image' },
  svg: { group: 'Image', mimeType: 'image/svg+xml', targets: ['png', 'jpeg', 'webp', 'bmp', 'gif', 'avif', 'pdf', 'ico', 'cur', 'tiff'], converterModule: 'image' },
  tiff: { group: 'Image', mimeType: 'image/tiff', targets: ['png', 'jpeg', 'webp', 'bmp', 'gif', 'avif', 'pdf', 'svg', 'ico', 'cur'], converterModule: 'image' },

  // ── PDF ─────────────────────────────────────────────────────────────────────
  pdf: {
    group: 'PDF',
    mimeType: 'application/pdf',
    targets: ['png', 'jpeg', 'txt', 'html', 'md', 'docx', 'csv'],
    converterModule: 'pdf',
  },

  // ── Spreadsheets ────────────────────────────────────────────────────────────
  xlsx: { group: 'Spreadsheet', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', targets: ['csv', 'json', 'tsv', 'ods', 'xlsb', 'html', 'txt'], converterModule: 'spreadsheet' },
  xls: { group: 'Spreadsheet', mimeType: 'application/vnd.ms-excel', targets: ['xlsx', 'csv', 'json', 'tsv', 'ods', 'xlsb', 'html', 'txt'], converterModule: 'spreadsheet' },
  ods: { group: 'Spreadsheet', mimeType: 'application/vnd.oasis.opendocument.spreadsheet', targets: ['xlsx', 'csv', 'json', 'tsv', 'xlsb', 'html', 'txt'], converterModule: 'spreadsheet' },
  csv: { group: 'Spreadsheet', mimeType: 'text/csv', targets: ['xlsx', 'json', 'tsv', 'ods', 'xlsb', 'html', 'txt'], converterModule: 'spreadsheet' },
  tsv: { group: 'Spreadsheet', mimeType: 'text/tab-separated-values', targets: ['xlsx', 'json', 'csv', 'ods', 'xlsb', 'html', 'txt'], converterModule: 'spreadsheet' },
  xlsb: { group: 'Spreadsheet', mimeType: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12', targets: ['xlsx', 'csv', 'json', 'tsv', 'ods', 'html', 'txt'], converterModule: 'spreadsheet' },

  // ── Documents ───────────────────────────────────────────────────────────────
  docx: { group: 'Document', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', targets: ['html', 'txt', 'md', 'pdf', 'rtf'], converterModule: 'document' },
  md: { group: 'Document', mimeType: 'text/markdown', targets: ['html', 'txt', 'pdf', 'docx'], converterModule: 'document' },
  html: { group: 'Document', mimeType: 'text/html', targets: ['md', 'txt', 'pdf', 'docx'], converterModule: 'document' },
  htm: { group: 'Document', mimeType: 'text/html', targets: ['md', 'txt', 'pdf', 'docx'], converterModule: 'document' },
  txt: { group: 'Document', mimeType: 'text/plain', targets: ['html', 'md', 'pdf', 'docx', 'rtf'], converterModule: 'document' },
  rtf: { group: 'Document', mimeType: 'application/rtf', targets: ['txt', 'html', 'md', 'pdf', 'docx'], converterModule: 'document' },
  odt: { group: 'Document', mimeType: 'application/vnd.oasis.opendocument.text', targets: ['txt', 'html', 'md', 'pdf', 'docx'], converterModule: 'document' },

  // ── Data ────────────────────────────────────────────────────────────────────
  json: { group: 'Data', mimeType: 'application/json', targets: ['csv', 'tsv', 'yaml', 'xml', 'toml', 'ini', 'properties', 'ndjson'], converterModule: 'data' },
  yaml: { group: 'Data', mimeType: 'application/x-yaml', targets: ['json', 'csv', 'tsv', 'xml', 'toml', 'ini', 'properties', 'ndjson'], converterModule: 'data' },
  yml: { group: 'Data', mimeType: 'application/x-yaml', targets: ['json', 'csv', 'tsv', 'xml', 'toml', 'ini', 'properties', 'ndjson'], converterModule: 'data' },
  xml: { group: 'Data', mimeType: 'application/xml', targets: ['json', 'csv', 'tsv', 'yaml', 'toml', 'ini'], converterModule: 'data' },
  toml: { group: 'Data', mimeType: 'application/toml', targets: ['json', 'yaml', 'xml', 'ini', 'properties'], converterModule: 'data' },
  ini: { group: 'Data', mimeType: 'text/plain', targets: ['json', 'yaml', 'toml', 'properties'], converterModule: 'data' },
  properties: { group: 'Data', mimeType: 'text/plain', targets: ['json', 'yaml', 'ini', 'toml'], converterModule: 'data' },
  ndjson: { group: 'Data', mimeType: 'application/x-ndjson', targets: ['json', 'csv', 'tsv', 'yaml', 'xml'], converterModule: 'data' },

  // ── Archives ────────────────────────────────────────────────────────────────
  zip: { group: 'Archive', mimeType: 'application/zip', targets: ['tar', 'gz'], converterModule: 'archive' },
  gz: { group: 'Archive', mimeType: 'application/gzip', targets: ['zip', 'tar'], converterModule: 'archive' },
  gzip: { group: 'Archive', mimeType: 'application/gzip', targets: ['zip', 'tar'], converterModule: 'archive' },
  tar: { group: 'Archive', mimeType: 'application/x-tar', targets: ['zip', 'gz'], converterModule: 'archive' },
  tgz: { group: 'Archive', mimeType: 'application/x-tar', targets: ['zip', 'tar'], converterModule: 'archive' },

  // ── Fonts ───────────────────────────────────────────────────────────────────
  ttf: { group: 'Font', mimeType: 'font/ttf', targets: ['otf', 'woff', 'woff2'], converterModule: 'font' },
  otf: { group: 'Font', mimeType: 'font/otf', targets: ['ttf', 'woff', 'woff2'], converterModule: 'font' },
  woff: { group: 'Font', mimeType: 'font/woff', targets: ['ttf', 'otf', 'woff2'], converterModule: 'font' },
  woff2: { group: 'Font', mimeType: 'font/woff2', targets: ['ttf', 'otf', 'woff'], converterModule: 'font' },

  // ── Audio ───────────────────────────────────────────────────────────────────
  mp3: { group: 'Audio', mimeType: 'audio/mpeg', targets: ['wav', 'ogg', 'flac', 'aac', 'm4a', 'opus', 'aiff', 'wma'], converterModule: 'audio' },
  wav: { group: 'Audio', mimeType: 'audio/wav', targets: ['mp3', 'ogg', 'flac', 'aac', 'm4a', 'opus', 'aiff', 'wma'], converterModule: 'audio' },
  ogg: { group: 'Audio', mimeType: 'audio/ogg', targets: ['mp3', 'wav', 'flac', 'aac', 'm4a', 'opus', 'aiff'], converterModule: 'audio' },
  flac: { group: 'Audio', mimeType: 'audio/flac', targets: ['mp3', 'wav', 'ogg', 'aac', 'm4a', 'opus', 'aiff'], converterModule: 'audio' },
  aac: { group: 'Audio', mimeType: 'audio/aac', targets: ['mp3', 'wav', 'ogg', 'flac', 'm4a', 'opus', 'aiff'], converterModule: 'audio' },
  m4a: { group: 'Audio', mimeType: 'audio/mp4', targets: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'opus', 'aiff'], converterModule: 'audio' },
  opus: { group: 'Audio', mimeType: 'audio/opus', targets: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'aiff'], converterModule: 'audio' },
  wma: { group: 'Audio', mimeType: 'audio/x-ms-wma', targets: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus', 'aiff'], converterModule: 'audio' },
  aiff: { group: 'Audio', mimeType: 'audio/aiff', targets: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus'], converterModule: 'audio' },
  caf: { group: 'Audio', mimeType: 'audio/x-caf', targets: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus'], converterModule: 'audio' },
  ra: { group: 'Audio', mimeType: 'audio/vnd.rn-realaudio', targets: ['mp3', 'wav', 'ogg', 'aac', 'm4a'], converterModule: 'audio' },

  // ── Video ───────────────────────────────────────────────────────────────────
  // NOTE: .ts (MPEG-2 Transport Stream) is listed here — NOT TypeScript files.
  // TypeScript .ts source files are unsupported by design (no sensible conversion target).
  mp4: { group: 'Video', mimeType: 'video/mp4', targets: ['webm', 'avi', 'mov', 'mkv', 'gif', 'mp3', 'wav', 'flv', '3gp', 'ts', 'm4v', 'wmv'], converterModule: 'video' },
  webm: { group: 'Video', mimeType: 'video/webm', targets: ['mp4', 'avi', 'mov', 'mkv', 'gif', 'mp3', 'wav', 'flv', '3gp', 'ts', 'm4v'], converterModule: 'video' },
  mkv: { group: 'Video', mimeType: 'video/x-matroska', targets: ['mp4', 'webm', 'avi', 'mov', 'gif', 'mp3', 'wav', 'flv', '3gp', 'ts', 'm4v'], converterModule: 'video' },
  avi: { group: 'Video', mimeType: 'video/x-msvideo', targets: ['mp4', 'webm', 'mov', 'mkv', 'gif', 'mp3', 'wav', 'flv', '3gp', 'ts', 'm4v'], converterModule: 'video' },
  mov: { group: 'Video', mimeType: 'video/quicktime', targets: ['mp4', 'webm', 'avi', 'mkv', 'gif', 'mp3', 'wav', 'flv', '3gp', 'ts', 'm4v'], converterModule: 'video' },
  flv: { group: 'Video', mimeType: 'video/x-flv', targets: ['mp4', 'webm', 'avi', 'mov', 'mkv', 'gif', 'mp3', 'wav', '3gp'], converterModule: 'video' },
  '3gp': { group: 'Video', mimeType: 'video/3gpp', targets: ['mp4', 'webm', 'avi', 'mov', 'mkv', 'gif', 'mp3', 'wav', 'flv'], converterModule: 'video' },
  wmv: { group: 'Video', mimeType: 'video/x-ms-wmv', targets: ['mp4', 'webm', 'avi', 'mov', 'mkv', 'gif', 'mp3', 'wav', 'flv', '3gp'], converterModule: 'video' },
  'video-ts': { group: 'Video', mimeType: 'video/mp2t', targets: ['mp4', 'webm', 'avi', 'mov', 'mkv', 'gif', 'mp3', 'wav', 'flv', '3gp'], converterModule: 'video' },
  m4v: { group: 'Video', mimeType: 'video/x-m4v', targets: ['mp4', 'webm', 'avi', 'mov', 'mkv', 'gif', 'mp3', 'wav', 'flv', '3gp'], converterModule: 'video' },
  ogv: { group: 'Video', mimeType: 'video/ogg', targets: ['mp4', 'webm', 'avi', 'mov', 'mkv', 'gif', 'mp3', 'wav'], converterModule: 'video' },
}

export const FORMAT_GROUPS: FormatGroup[] = [
  { label: 'Image', formats: ['png', 'jpeg', 'webp', 'bmp', 'gif', 'avif', 'ico', 'cur', 'svg', 'tiff'] },
  { label: 'PDF', formats: ['pdf'] },
  { label: 'Spreadsheet', formats: ['xlsx', 'xls', 'ods', 'csv', 'tsv', 'xlsb'] },
  { label: 'Document', formats: ['docx', 'odt', 'md', 'html', 'txt', 'rtf'] },
  { label: 'Data', formats: ['json', 'yaml', 'yml', 'xml', 'toml', 'ini', 'properties', 'ndjson'] },
  { label: 'Archive', formats: ['zip', 'gz', 'gzip', 'tar', 'tgz'] },
  { label: 'Font', formats: ['ttf', 'otf', 'woff', 'woff2'] },
  { label: 'Audio', formats: ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a', 'opus', 'wma', 'aiff', 'caf', 'ra'] },
  { label: 'Video', formats: ['mp4', 'webm', 'mkv', 'avi', 'mov', 'flv', '3gp', 'wmv', 'm4v', 'ogv'] },
]

export function getExtension(file: File): string {
  return file.name.split('.').pop()?.toLowerCase() ?? ''
}

export function getFormatInfo(ext: string): FormatInfo | undefined {
  return FORMAT_REGISTRY[ext]
}

export function getTargets(inputExt: string): string[] {
  return FORMAT_REGISTRY[inputExt]?.targets ?? []
}

export function buildOutputFilename(originalName: string, outputFormat: string): string {
  const base = originalName.substring(0, originalName.lastIndexOf('.'))
  return `${base}.${outputFormat}`
}

// ── Conversion time estimate ──────────────────────────────────────────────────
// Video/audio use ffmpeg.wasm (single-threaded), which is ~20-50× slower than
// native ffmpeg. Estimates reflect real-world browser performance.
const BASE_MS_BY_MODULE: Record<string, { base: number; perMb: number }> = {
  video: { base: 8000, perMb: 12000 }, // ~3-5 min for a 25 MB video
  audio: { base: 3000, perMb: 4000 }, // ~1-2 min for large audio
  pdf: { base: 500, perMb: 220 },
  archive: { base: 300, perMb: 140 },
  spreadsheet: { base: 300, perMb: 110 },
  image: { base: 250, perMb: 90 },
  font: { base: 250, perMb: 60 },
  document: { base: 300, perMb: 70 },
  data: { base: 200, perMb: 60 },
}

export function estimateConversionMs(file: File, inputFormat: string): number {
  const info = getFormatInfo(inputFormat)
  const { base, perMb } = BASE_MS_BY_MODULE[info?.converterModule ?? ''] ?? { base: 350, perMb: 80 }
  const sizeMb = file.size / (1024 * 1024)
  return Math.round(base + sizeMb * perMb)
}