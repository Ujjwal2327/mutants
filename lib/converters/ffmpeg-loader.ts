import type { FFmpeg } from '@ffmpeg/ffmpeg'

// Shared singleton – loaded once across audio and video converters.
// Uses @ffmpeg/core (single-threaded) which does NOT require
// SharedArrayBuffer or COOP/COEP headers.
let _ff: FFmpeg | null = null
let _loading: Promise<FFmpeg> | null = null

// ── Job counter ───────────────────────────────────────────────────────────────
// Date.now() is NOT safe for generating unique ffmpeg virtual-filesystem
// filenames when multiple conversions are fired at the same time (e.g. "Convert
// all"), because all the calls land within the same millisecond and every file
// ends up with the same name. An auto-incrementing counter is guaranteed unique
// within the page session regardless of timing.
let _jobCounter = 0
export function nextJobId(): number {
  return ++_jobCounter
}

// ── Serialisation queue ───────────────────────────────────────────────────────
// ffmpeg.wasm is single-threaded: running two exec() calls on the same instance
// concurrently corrupts both outputs (they share the same virtual FS and the
// same internal state machine). We serialize all jobs through a promise chain
// so only one conversion is active at a time, while still letting the UI kick
// off all conversions immediately and show individual progress for each one.
let _queue: Promise<unknown> = Promise.resolve()

export function enqueueFFmpegJob<T>(job: () => Promise<T>): Promise<T> {
  const result = _queue.then(job)
  // Swallow errors on the chain tail so a failed job doesn't block the queue.
  _queue = result.catch(() => { })
  return result
}

export function isFFmpegReady(): boolean {
  return _ff?.loaded ?? false
}

export async function getFFmpeg(): Promise<FFmpeg> {
  if (_ff?.loaded) return _ff
  if (_loading) return _loading

  _loading = (async (): Promise<FFmpeg> => {
    const { FFmpeg } = await import('@ffmpeg/ffmpeg')
    const { toBlobURL } = await import('@ffmpeg/util')

    const ff = new FFmpeg()
    const base = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd'
    await ff.load({
      coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
    })
    _ff = ff
    return ff
  })()

  return _loading
}