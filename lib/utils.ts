import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

import * as fflate from 'fflate'

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export function fileToArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as ArrayBuffer)
    reader.onerror = () => reject(reader.error)
    reader.readAsArrayBuffer(file)
  })
}

export function fileToText(file: File, encoding = 'utf-8'): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsText(file, encoding)
  })
}

export function fileToDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export function dataURLToBlob(dataURL: string): Blob {
  const [header, base64] = dataURL.split(',')
  const mime = header.match(/:(.*?);/)?.[1] ?? 'application/octet-stream'
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

// BUG 9 FIX: when two converted files share the same output filename (e.g. the
// user converts two different copies of "photo.jpg" to PNG), the old code used
// the filename as an object key and the second entry silently overwrote the
// first in the ZIP.  Now we detect duplicates and append " (1)", " (2)", … to
// each colliding name so every file is preserved.
export async function downloadAllAsZip(
  files: Array<{ blob: Blob; filename: string }>
): Promise<void> {
  const zipInput: fflate.Zippable = {}
  const seen = new Map<string, number>()

  await Promise.all(
    files.map(async ({ blob, filename }) => {
      // Build a unique key for this entry
      let key = filename
      if (seen.has(filename)) {
        const count = seen.get(filename)! + 1
        seen.set(filename, count)
        const dot = filename.lastIndexOf('.')
        if (dot >= 0) {
          key = `${filename.substring(0, dot)} (${count})${filename.substring(dot)}`
        } else {
          key = `${filename} (${count})`
        }
      } else {
        seen.set(filename, 0)
      }
      zipInput[key] = new Uint8Array(await blob.arrayBuffer())
    })
  )

  const zipped = fflate.zipSync(zipInput, { level: 6 })
  downloadBlob(new Blob([zipped], { type: 'application/zip' }), 'converted-files.zip')
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

export function uid(): string {
  return Math.random().toString(36).slice(2, 9)
}