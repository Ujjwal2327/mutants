import { getFFmpeg, isFFmpegReady, nextJobId, enqueueFFmpegJob } from './ffmpeg-loader'
import type { ConversionProgressInfo } from '@/types/converter'

const AUDIO_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  opus: 'audio/opus',
  aiff: 'audio/aiff',
  wma: 'audio/x-ms-wma',
  caf: 'audio/x-caf',
  ra: 'audio/vnd.rn-realaudio',
}

function buildAudioArgs(outputFormat: string): string[] {
  switch (outputFormat) {
    case 'mp3': return ['-codec:a', 'libmp3lame', '-qscale:a', '2']
    case 'wav': return ['-codec:a', 'pcm_s16le']
    case 'ogg': return ['-codec:a', 'libvorbis', '-qscale:a', '5']
    case 'flac': return ['-codec:a', 'flac']
    case 'aac': return ['-codec:a', 'aac', '-b:a', '192k']
    case 'm4a': return ['-codec:a', 'aac', '-b:a', '192k']
    case 'opus': return ['-codec:a', 'libopus', '-b:a', '128k']
    case 'aiff': return ['-codec:a', 'pcm_s16be']
    case 'wma': return ['-codec:a', 'wmav2', '-b:a', '128k']
    case 'caf': return ['-codec:a', 'pcm_s16le', '-f', 'caf']
    default: throw new Error(`Unsupported audio output: .${outputFormat}`)
  }
}

export async function convertAudio(
  file: File,
  outputFormat: string,
  onProgress?: (info: ConversionProgressInfo) => void,
): Promise<Blob> {
  if (!isFFmpegReady()) onProgress?.({ phase: 'loading' })

  return enqueueFFmpegJob(async () => {
    const ff = await getFFmpeg()

    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    const id = nextJobId()
    const inName = `audio_in_${id}.${ext}`
    const outName = `audio_out_${id}.${outputFormat}`

    const handleProgress = ({ progress }: { progress: number }) => {
      const ratio = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
      onProgress?.({ phase: 'converting', ratio })
    }
    ff.on('progress', handleProgress)

    try {
      await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()))
      // BUG 11 FIX: add '-y' so ffmpeg unconditionally overwrites the output
      // file.  Without it, if a previous (failed) conversion left a stale file
      // with the same name in the virtual FS, ffmpeg would stall waiting for
      // interactive confirmation.
      await ff.exec(['-y', '-i', inName, ...buildAudioArgs(outputFormat), outName])
      const data = await ff.readFile(outName)
      return new Blob([new Uint8Array(data as Uint8Array)], { type: AUDIO_MIME[outputFormat] ?? 'audio/mpeg' })
    } finally {
      ff.off('progress', handleProgress)
      await ff.deleteFile(inName).catch(() => { /* ignore */ })
      await ff.deleteFile(outName).catch(() => { /* ignore */ })
    }
  })
}