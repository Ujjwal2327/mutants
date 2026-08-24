import { getFormatInfo, getExtension } from '@/lib/formatRegistry'
import type { ConverterFn } from '@/types/converter'

export const convert: ConverterFn = async (file, outputFormat, onProgress, signal) => {
  const ext = getExtension(file)
  const info = getFormatInfo(ext)

  if (!info) throw new Error(`Unsupported file type: .${ext}`)
  if (!info.targets.includes(outputFormat)) throw new Error(`Cannot convert .${ext} → .${outputFormat}`)

  // Check before we even start importing/running
  signal?.throwIfAborted()

  switch (info.converterModule) {
    case 'image': {
      const { convertImage } = await import('./image')
      signal?.throwIfAborted()
      return convertImage(file, outputFormat, signal)
    }
    case 'pdf': {
      const { convertPdf } = await import('./pdf')
      signal?.throwIfAborted()
      return convertPdf(file, outputFormat, signal)
    }
    case 'spreadsheet': {
      const { convertSpreadsheet } = await import('./spreadsheet')
      signal?.throwIfAborted()
      return convertSpreadsheet(file, outputFormat, signal)
    }
    case 'document': {
      const { convertDocument } = await import('./document')
      signal?.throwIfAborted()
      return convertDocument(file, outputFormat, signal)
    }
    case 'data': {
      const { convertData } = await import('./data')
      signal?.throwIfAborted()
      return convertData(file, outputFormat, signal)
    }
    case 'archive': {
      const { convertArchive } = await import('./archive')
      signal?.throwIfAborted()
      return convertArchive(file, outputFormat, signal)
    }
    case 'font': {
      const { convertFont } = await import('./font')
      signal?.throwIfAborted()
      return convertFont(file, outputFormat, signal)
    }
    case 'audio': {
      const { convertAudio } = await import('./audio')
      signal?.throwIfAborted()
      return convertAudio(file, outputFormat, onProgress, signal)
    }
    case 'video': {
      const { convertVideo } = await import('./video')
      signal?.throwIfAborted()
      return convertVideo(file, outputFormat, onProgress, signal)
    }
    default:
      throw new Error(`Unknown converter module: ${info.converterModule}`)
  }
}