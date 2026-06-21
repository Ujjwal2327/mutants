export type ConversionStatus = 'idle' | 'converting' | 'done' | 'error' | 'cancelled'

export interface ConvertibleFile {
  id: string
  file: File
  inputFormat: string
  outputFormat: string
  status: ConversionStatus
  progress: number
  errorMessage?: string
  outputBlob?: Blob
  outputFilename?: string
  /** Timestamp (Date.now()) when this conversion started — drives the progress estimate. */
  startedAt?: number
  /** Rough predicted duration in ms for this conversion, based on file size/type. */
  estimatedMs?: number
  /** True while the (one-time, per session) ffmpeg engine download is in progress. */
  loadingEngine?: boolean
  /** True once we're receiving real, measured progress (ffmpeg audio/video) instead of a simulated estimate. */
  usesRealProgress?: boolean
}

export interface ConversionProgressInfo {
  phase: 'loading' | 'converting'
  /** 0–1 ratio, only present once real progress is available (phase === 'converting'). */
  ratio?: number
}

export type ConverterFn = (
  file: File,
  outputFormat: string,
  onProgress?: (info: ConversionProgressInfo) => void,
  signal?: AbortSignal,
) => Promise<Blob>

export interface FormatGroup {
  label: string
  formats: string[]
}

export interface FormatInfo {
  group: string
  mimeType: string
  targets: string[]
  converterModule: string
}