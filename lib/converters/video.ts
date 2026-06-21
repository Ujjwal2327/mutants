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
  wmv: 'video/x-ms-wmv',
  ts: 'video/mp2t',
  m4v: 'video/x-m4v',
}

function buildVideoArgs(outputFormat: string): string[] {
  switch (outputFormat) {
    case 'mp4':
      return [
        '-codec:v', 'libx264', '-crf', '28', '-preset', 'ultrafast',
        '-codec:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
      ]
    case 'webm':
      // VP9 realtime mode — much faster in single-threaded wasm
      return [
        '-codec:v', 'libvpx-vp9', '-crf', '35', '-b:v', '0',
        '-deadline', 'realtime', '-cpu-used', '8',
        '-codec:a', 'libopus', '-b:a', '128k',
      ]
    case 'avi':
      return ['-codec:v', 'mpeg4', '-qscale:v', '6', '-codec:a', 'libmp3lame', '-preset', 'ultrafast']
    case 'mkv':
      return [
        '-codec:v', 'libx264', '-crf', '28', '-preset', 'ultrafast',
        '-codec:a', 'aac', '-b:a', '128k',
      ]
    case 'gif':
      // Scale down to 360px wide and 8fps to keep it manageable in wasm
      return [
        '-vf',
        'fps=8,scale=360:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3',
        '-loop', '0',
      ]
    case 'mp3':
      return ['-vn', '-codec:a', 'libmp3lame', '-qscale:a', '4']
    case 'wav':
      return ['-vn', '-codec:a', 'pcm_s16le']
    case 'mov':
      return [
        '-codec:v', 'libx264', '-crf', '28', '-preset', 'ultrafast',
        '-codec:a', 'aac', '-b:a', '128k',
      ]
    case 'wmv':
      return [
        '-codec:v', 'wmv2', '-qscale:v', '6',
        '-codec:a', 'wmav2', '-b:a', '128k',
      ]
    case 'flv':
      return [
        '-codec:v', 'libx264', '-crf', '28', '-preset', 'ultrafast',
        '-codec:a', 'aac', '-b:a', '128k', '-ar', '44100',
      ]
    case '3gp':
      return [
        '-codec:v', 'libx264', '-profile:v', 'baseline', '-level', '3.0',
        '-crf', '32', '-preset', 'ultrafast',
        '-codec:a', 'aac', '-b:a', '64k', '-ar', '22050',
      ]
    case 'ts':
      return [
        '-codec:v', 'libx264', '-crf', '28', '-preset', 'ultrafast',
        '-codec:a', 'aac', '-b:a', '128k',
        '-f', 'mpegts',
      ]
    case 'm4v':
      return [
        '-codec:v', 'libx264', '-crf', '28', '-preset', 'ultrafast',
        '-codec:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
      ]
    default:
      throw new Error(`Unsupported video output: .${outputFormat}`)
  }
}

// Formats where stream-copy (no re-encode) is worth trying first.
// Only container formats that natively accept H.264+AAC streams.
const STREAM_COPY_TARGETS = new Set(['mp4', 'mkv', 'mov', 'm4v', 'ts'])

export async function convertVideo(
  file: File,
  outputFormat: string,
  onProgress?: (info: ConversionProgressInfo) => void,
  signal?: AbortSignal,
): Promise<Blob> {
  if (!isFFmpegReady()) onProgress?.({ phase: 'loading' })

  return enqueueFFmpegJob(async () => {
    signal?.throwIfAborted()

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
      signal?.throwIfAborted()
      await ff.writeFile(inName, new Uint8Array(await file.arrayBuffer()))
      signal?.throwIfAborted()

      // ── Fast path: stream-copy (instant container remux) ──────────────────
      // Only attempt if the output format supports H.264+AAC natively.
      // We try copy first; if ffmpeg can't copy (wrong codec in source),
      // it will error — we catch that and fall through to full re-encode.
      if (STREAM_COPY_TARGETS.has(outputFormat)) {
        try {
          const copyArgs = outputFormat === 'mp4' || outputFormat === 'm4v'
            ? ['-c', 'copy', '-movflags', '+faststart']
            : ['-c', 'copy']

          await ff.exec(['-i', inName, ...copyArgs, outName])

          let copied: Uint8Array | null = null
          try { copied = await ff.readFile(outName) as Uint8Array } catch { /* file may not exist */ }

          if (copied && copied.length > 10_000) {
            return new Blob([copied], { type: OUTPUT_MIME[outputFormat] ?? 'video/mp4' })
          }
        } catch {
          // Stream copy failed (incompatible codec) — clean up and re-encode
        } finally {
          await ff.deleteFile(outName).catch(() => { /* ignore */ })
        }

        signal?.throwIfAborted()
      }

      // ── Full re-encode ────────────────────────────────────────────────────
      await ff.exec(['-i', inName, ...buildVideoArgs(outputFormat), outName])
      signal?.throwIfAborted()

      const data = await ff.readFile(outName)
      return new Blob([data as Uint8Array], { type: OUTPUT_MIME[outputFormat] ?? 'video/mp4' })
    } finally {
      ff.off('progress', handleProgress)
      await ff.deleteFile(inName).catch(() => { /* ignore */ })
      await ff.deleteFile(outName).catch(() => { /* ignore */ })
    }
  })
}