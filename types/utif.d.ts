declare module 'utif' {
  export interface IFD {
    width: number
    height: number
    [key: string]: unknown
  }

  export function decode(buffer: ArrayBuffer | Uint8Array): IFD[]
  export function decodeImage(buffer: ArrayBuffer | Uint8Array, ifd: IFD, ifds?: IFD[]): void
  export function toRGBA8(ifd: IFD): Uint8Array
  export function encodeImage(
    rgba: Uint8Array | Uint8ClampedArray,
    width: number,
    height: number,
  ): ArrayBuffer
}