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
      return convertImage(file, outputFormat)
    }
    case 'pdf': {
      const { convertPdf } = await import('./pdf')
      signal?.throwIfAborted()
      return convertPdf(file, outputFormat)
    }
    case 'spreadsheet': {
      const { convertSpreadsheet } = await import('./spreadsheet')
      signal?.throwIfAborted()
      return convertSpreadsheet(file, outputFormat)
    }
    case 'document': {
      const { convertDocument } = await import('./document')
      signal?.throwIfAborted()
      return convertDocument(file, outputFormat)
    }
    case 'data': {
      const { convertData } = await import('./data')
      signal?.throwIfAborted()
      return convertData(file, outputFormat)
    }
    case 'archive': {
      const { convertArchive } = await import('./archive')
      signal?.throwIfAborted()
      return convertArchive(file, outputFormat)
    }
    case 'font': {
      const { convertFont } = await import('./font')
      signal?.throwIfAborted()
      return convertFont(file, outputFormat)
    }
    case 'audio': {
      const { convertAudio } = await import('./audio')
      signal?.throwIfAborted()
      return convertAudio(file, outputFormat, onProgress)
    }
    case 'video': {
      const { convertVideo } = await import('./video')
      signal?.throwIfAborted()
      return convertVideo(file, outputFormat, onProgress)
    }
    default:
      throw new Error(`Unknown converter module: ${info.converterModule}`)
  }
}