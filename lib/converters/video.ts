import { getFFmpeg, isFFmpegReady, nextJobId, enqueueFFmpegJob } from './ffmpeg-loader'
import type { ConversionProgressInfo } from '@/types/converter'

const OUTPUT_MIME: Record<string, string> = {
  mp4: 'video/mp4',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  gif: 'image/gif',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flv: 'video/x-flv',
  '3gp': 'video/3gpp',
  mpg: 'video/mpeg',
  wmv: 'video/x-ms-wmv',
  ts: 'video/mp2t',
  m4v: 'video/x-m4v',
}

function buildVideoArgs(outputFormat: string): string[] {
  switch (outputFormat) {
    case 'mp4':
      return [
        '-codec:v', 'libx264', '-crf', '23', '-preset', 'fast',
        '-codec:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
      ]
    case 'webm':
      return [
        '-codec:v', 'libvpx-vp9', '-crf', '30', '-b:v', '0',
        '-codec:a', 'libopus', '-b:a', '128k',
      ]
    case 'avi':
      return ['-codec:v', 'mpeg4', '-qscale:v', '5', '-codec:a', 'libmp3lame']
    case 'mkv':
      return [
        '-codec:v', 'libx264', '-crf', '23', '-preset', 'fast',
        '-codec:a', 'aac', '-b:a', '128k',
      ]
    case 'gif':
      return [
        '-vf',
        'fps=10,scale=480:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=256:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5',
        '-loop', '0',
      ]
    case 'mp3':
      return ['-vn', '-codec:a', 'libmp3lame', '-qscale:a', '2']
    case 'wav':
      return ['-vn', '-codec:a', 'pcm_s16le']
    case 'mov':
      return [
        '-codec:v', 'libx264', '-crf', '23', '-preset', 'fast',
        '-codec:a', 'aac', '-b:a', '128k',
      ]
    case 'wmv':
      return [
        '-codec:v', 'wmv2', '-qscale:v', '5',
        '-codec:a', 'wmav2', '-b:a', '128k',
      ]
    case 'flv':
      return [
        '-codec:v', 'libx264', '-crf', '23', '-preset', 'fast',
        '-codec:a', 'aac', '-b:a', '128k', '-ar', '44100',
      ]
    case '3gp':
      return [
        '-codec:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0',
        '-crf', '28', '-preset', 'fast',
        '-codec:a', 'aac', '-b:a', '96k', '-ar', '22050',
      ]
    case 'mpg':
      return ['-codec:v', 'mpeg2video', '-qscale:v', '5', '-codec:a', 'mp2', '-b:a', '192k']
    case 'ts':
      return [
        '-codec:v', 'libx264', '-crf', '23', '-preset', 'fast',
        '-codec:a', 'aac', '-b:a', '128k',
        '-f', 'mpegts',
      ]
    case 'm4v':
      return [
        '-codec:v', 'libx264', '-crf', '23', '-preset', 'fast',
        '-codec:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
      ]
    default:
      throw new Error(`Unsupported video output: .${outputFormat}`)
  }
}

export async function convertVideo(
  file: File,
  outputFormat: string,
  onProgress?: (info: ConversionProgressInfo) => void,
): Promise<Blob> {
  if (!isFFmpegReady()) onProgress?.({ phase: 'loading' })

  return enqueueFFmpegJob(async () => {
    const ff = await getFFmpeg()

    const ext = file.name.split('.').pop()?.toLowerCase() ?? ''
    const id = nextJobId()
    const inName = `video_in_${id}.${ext}`
    const outName = `video_out_${id}.${outputFormat}`

    const handleProgress = ({ progress }: { progress: number }) => {
      const ratio = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0
      onProgress?.({ phase: 'converting', ratio })
    }
    ff.on('progress', handleProgress)

    try {
      await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()))

      // ── Fast path: stream copy for container remux ─────────────────────────
      // BUG 11 FIX: added '-y' to both exec calls so ffmpeg overwrites the
      // output file without prompting.  Without it, if the fast-path produces a
      // too-small file and we fall through to the slow re-encode path, ffmpeg
      // finds the output file already exists and may stall or error instead of
      // overwriting it.
      if (['mp4', 'mkv', 'mov', 'm4v'].includes(outputFormat)) {
        const copyArgs = outputFormat === 'mp4'
          ? ['-y', '-c', 'copy', '-movflags', '+faststart']
          : ['-y', '-c', 'copy']
        await ff.exec(['-i', inName, ...copyArgs, outName])
        const copied = (await ff.readFile(outName).catch(() => null)) as Uint8Array | null
        if (copied && copied.length > 10_000) {
          return new Blob([new Uint8Array(copied)], { type: OUTPUT_MIME[outputFormat] ?? 'video/mp4' })
        }
        await ff.deleteFile(outName).catch(() => { })
      }

      // ── Slow path: full re-encode ──────────────────────────────────────────
      // BUG 11 FIX: '-y' ensures ffmpeg overwrites without interactive prompt
      await ff.exec(['-y', '-i', inName, ...buildVideoArgs(outputFormat), outName])
      const data = await ff.readFile(outName)
      return new Blob([new Uint8Array(data as Uint8Array)], { type: OUTPUT_MIME[outputFormat] ?? 'video/mp4' })
    } finally {
      ff.off('progress', handleProgress)
      await ff.deleteFile(inName).catch(() => { /* ignore */ })
      await ff.deleteFile(outName).catch(() => { /* ignore */ })
    }
  })
}