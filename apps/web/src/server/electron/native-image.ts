import { readFileSync } from 'node:fs'
import { imageSize } from 'image-size'
import jpeg from 'jpeg-js'
import { PNG } from 'pngjs'

/**
 * nativeImage without Chromium's decoders: PNG and JPEG are decoded in pure
 * JS (pngjs, jpeg-js); other formats still report their size, which is most
 * of what the editors ask for (placing pictures, keeping aspect ratios).
 */

interface Decoded {
  width: number
  height: number
  /** straight-alpha RGBA */
  rgba: Buffer
}

function sniff(bytes: Buffer): 'png' | 'jpeg' | 'other' {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e) return 'png'
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg'
  return 'other'
}

export class NativeImage {
  private decodedCache: Decoded | null | undefined
  private readonly size: { width: number; height: number }

  private constructor(
    private readonly bytes: Buffer,
    size?: { width: number; height: number },
    decoded?: Decoded,
  ) {
    this.decodedCache = decoded
    if (size) {
      this.size = size
    } else {
      let measured = { width: 0, height: 0 }
      if (bytes.length > 0) {
        try {
          const s = imageSize(bytes)
          const swap = (s.orientation ?? 1) >= 5
          measured = swap
            ? { width: s.height ?? 0, height: s.width ?? 0 }
            : { width: s.width ?? 0, height: s.height ?? 0 }
        } catch {
          measured = { width: 0, height: 0 }
        }
      }
      this.size = measured
    }
  }

  static fromBuffer(buffer: Buffer | Uint8Array): NativeImage {
    return new NativeImage(Buffer.from(buffer))
  }

  static createEmpty(): NativeImage {
    return new NativeImage(Buffer.alloc(0))
  }

  static createFromPath(path: string): NativeImage {
    try {
      return new NativeImage(readFileSync(path))
    } catch {
      return NativeImage.createEmpty()
    }
  }

  static createFromBuffer(buffer: Buffer | Uint8Array): NativeImage {
    return NativeImage.fromBuffer(buffer)
  }

  static createFromDataURL(url: string): NativeImage {
    const m = /^data:[^;,]*(;base64)?,(.*)$/s.exec(url)
    if (!m) return NativeImage.createEmpty()
    const body = m[1] ? Buffer.from(m[2]!, 'base64') : Buffer.from(decodeURIComponent(m[2]!))
    return new NativeImage(body)
  }

  /** premultiplied BGRA, as Electron's createFromBitmap takes it */
  static createFromBitmap(
    buffer: Buffer | Uint8Array,
    options: { width: number; height: number },
  ): NativeImage {
    const { width, height } = options
    const rgba = Buffer.alloc(width * height * 4)
    for (let i = 0; i < rgba.length; i += 4) {
      const a = buffer[i + 3]!
      const un = (v: number) => (a === 0 ? 0 : Math.min(255, Math.round((v * 255) / a)))
      rgba[i] = un(buffer[i + 2]!)
      rgba[i + 1] = un(buffer[i + 1]!)
      rgba[i + 2] = un(buffer[i]!)
      rgba[i + 3] = a
    }
    return new NativeImage(Buffer.alloc(0), { width, height }, { width, height, rgba })
  }

  static async createThumbnailFromPath(
    path: string,
    _size: { width: number; height: number },
  ): Promise<NativeImage> {
    const image = NativeImage.createFromPath(path)
    if (image.isEmpty() || !image.decoded()) throw new Error('no thumbnail available on the web')
    return image
  }

  private decoded(): Decoded | null {
    if (this.decodedCache !== undefined) return this.decodedCache
    let result: Decoded | null = null
    try {
      const kind = sniff(this.bytes)
      if (kind === 'png') {
        const png = PNG.sync.read(this.bytes)
        result = { width: png.width, height: png.height, rgba: png.data }
      } else if (kind === 'jpeg') {
        const img = jpeg.decode(this.bytes, {
          useTArray: true,
          formatAsRGBA: true,
          maxMemoryUsageInMB: 1024,
        })
        result = { width: img.width, height: img.height, rgba: Buffer.from(img.data) }
      }
    } catch {
      result = null
    }
    this.decodedCache = result
    return result
  }

  isEmpty(): boolean {
    return this.size.width === 0 || this.size.height === 0
  }

  getSize(): { width: number; height: number } {
    return { ...this.size }
  }

  getAspectRatio(): number {
    return this.size.height ? this.size.width / this.size.height : 1
  }

  toPNG(): Buffer {
    if (sniff(this.bytes) === 'png') return this.bytes
    const d = this.decoded()
    if (!d) return Buffer.alloc(0)
    const png = new PNG({ width: d.width, height: d.height })
    d.rgba.copy(png.data)
    return PNG.sync.write(png)
  }

  toJPEG(quality: number): Buffer {
    if (sniff(this.bytes) === 'jpeg') return this.bytes
    const d = this.decoded()
    if (!d) return Buffer.alloc(0)
    return Buffer.from(
      jpeg.encode({ data: d.rgba, width: d.width, height: d.height }, quality).data,
    )
  }

  /** premultiplied BGRA */
  toBitmap(): Buffer {
    const d = this.decoded()
    if (!d) return Buffer.alloc(0)
    const out = Buffer.alloc(d.rgba.length)
    for (let i = 0; i < out.length; i += 4) {
      const a = d.rgba[i + 3]!
      out[i] = Math.round((d.rgba[i + 2]! * a) / 255)
      out[i + 1] = Math.round((d.rgba[i + 1]! * a) / 255)
      out[i + 2] = Math.round((d.rgba[i]! * a) / 255)
      out[i + 3] = a
    }
    return out
  }

  getBitmap(): Buffer {
    return this.toBitmap()
  }

  toDataURL(): string {
    const png = this.toPNG()
    return png.length ? `data:image/png;base64,${png.toString('base64')}` : 'data:image/png;base64,'
  }

  resize(options: { width?: number; height?: number }): NativeImage {
    const d = this.decoded()
    if (!d) return this
    const width = Math.max(
      1,
      Math.round(options.width ?? (d.width * (options.height ?? d.height)) / d.height),
    )
    const height = Math.max(1, Math.round(options.height ?? (d.height * width) / d.width))
    const rgba = Buffer.alloc(width * height * 4)
    for (let y = 0; y < height; y++) {
      const sy = Math.min(d.height - 1, Math.floor((y * d.height) / height))
      for (let x = 0; x < width; x++) {
        const sx = Math.min(d.width - 1, Math.floor((x * d.width) / width))
        d.rgba.copy(rgba, (y * width + x) * 4, (sy * d.width + sx) * 4, (sy * d.width + sx) * 4 + 4)
      }
    }
    return new NativeImage(Buffer.alloc(0), { width, height }, { width, height, rgba })
  }

  crop(rect: { x: number; y: number; width: number; height: number }): NativeImage {
    const d = this.decoded()
    if (!d) return this
    const rgba = Buffer.alloc(rect.width * rect.height * 4)
    for (let y = 0; y < rect.height; y++) {
      const from = ((rect.y + y) * d.width + rect.x) * 4
      d.rgba.copy(rgba, y * rect.width * 4, from, from + rect.width * 4)
    }
    return new NativeImage(
      Buffer.alloc(0),
      { width: rect.width, height: rect.height },
      {
        width: rect.width,
        height: rect.height,
        rgba,
      },
    )
  }

  addRepresentation(): void {}
  setTemplateImage(): void {}
  isTemplateImage(): boolean {
    return false
  }
  getScaleFactors(): number[] {
    return [1]
  }
}

export const nativeImage = {
  createEmpty: () => NativeImage.createEmpty(),
  createFromPath: (path: string) => NativeImage.createFromPath(path),
  createFromBuffer: (buffer: Buffer) => NativeImage.createFromBuffer(buffer),
  createFromDataURL: (url: string) => NativeImage.createFromDataURL(url),
  createFromBitmap: (buffer: Buffer, options: { width: number; height: number }) =>
    NativeImage.createFromBitmap(buffer, options),
  createThumbnailFromPath: (path: string, size: { width: number; height: number }) =>
    NativeImage.createThumbnailFromPath(path, size),
  createFromNamedImage: () => NativeImage.createEmpty(),
}
