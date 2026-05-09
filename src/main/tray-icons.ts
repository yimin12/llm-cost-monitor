import { deflateSync } from 'node:zlib'
import { nativeImage, type NativeImage } from 'electron'

// 16×16 alert-icon mask (warning triangle with exclamation). 1 = pixel ON.
// Designed for macOS template images: the OS applies the system foreground
// color, so all we ship is the mask. Linux/Windows render it as white-ish.
//
// Layout: rounded apex (2-px flat top), narrow exclamation stem cut out
// rows 5–9, dot cut out row 11, and a 3-row flat base inset 1 pixel from
// each side so the bottom corners read as rounded rather than sharp.
const ALERT_MASK_16: ReadonlyArray<ReadonlyArray<number>> = [
  // row 0
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,0,1,1,0,0,0,0,0,0,0],
  [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
  [0,0,0,0,0,0,1,1,1,1,0,0,0,0,0,0],
  [0,0,0,0,0,1,1,0,0,1,1,0,0,0,0,0],
  [0,0,0,0,1,1,1,0,0,1,1,1,0,0,0,0],
  [0,0,0,0,1,1,1,0,0,1,1,1,0,0,0,0],
  [0,0,0,1,1,1,1,0,0,1,1,1,1,0,0,0],
  [0,0,0,1,1,1,1,0,0,1,1,1,1,0,0,0],
  [0,0,1,1,1,1,1,1,1,1,1,1,1,1,0,0],
  [0,0,1,1,1,1,1,0,0,1,1,1,1,1,0,0],
  [0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0],
  [0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0],
  [0,1,1,1,1,1,1,1,1,1,1,1,1,1,1,0],
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
]

// Minimal PNG encoder for a single grayscale+alpha 16×16 frame. We stay
// inside Node's built-in zlib + Buffer — no `sharp` / `pngjs` dep.
//
// PNG layout (color type 4 = grayscale + alpha, 8-bit):
//   8-byte signature
//   IHDR (13-byte data)
//   IDAT (deflate of 16 scanlines, each 1 filter byte + 32 sample bytes)
//   IEND

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

// CRC-32 (PNG variant) — same polynomial as Ethernet, init 0xFFFFFFFF.
function crc32(buf: Buffer): number {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!
    for (let b = 0; b < 8; b++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const t = Buffer.from(type, 'ascii')
  const crcInput = Buffer.concat([t, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(crcInput), 0)
  return Buffer.concat([len, t, data, crc])
}

function buildPng16x16Alpha(mask: ReadonlyArray<ReadonlyArray<number>>): Buffer {
  // IHDR: width=16, height=16, bitDepth=8, colorType=4, compression=0,
  // filter=0, interlace=0.
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(16, 0)
  ihdr.writeUInt32BE(16, 4)
  ihdr.writeUInt8(8, 8)
  ihdr.writeUInt8(4, 9)
  ihdr.writeUInt8(0, 10)
  ihdr.writeUInt8(0, 11)
  ihdr.writeUInt8(0, 12)

  // Raw scanlines: filter byte (0 = None) + 16 (gray, alpha) pairs per row.
  const raw = Buffer.alloc(16 * (1 + 16 * 2))
  let off = 0
  for (let y = 0; y < 16; y++) {
    raw[off++] = 0 // filter type
    for (let x = 0; x < 16; x++) {
      const on = mask[y]?.[x] === 1
      raw[off++] = 0xff // gray (white) — irrelevant when alpha=0
      raw[off++] = on ? 0xff : 0x00
    }
  }

  const idat = deflateSync(raw)

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

let cachedAlertIcon: NativeImage | null = null

export function getAlertTrayIcon(): NativeImage {
  if (cachedAlertIcon !== null) return cachedAlertIcon

  // macOS: prefer the native NSCaution system image. It's anti-aliased,
  // sized correctly for the menubar by AppKit, and matches the SF
  // Symbols / iOS visual language the rest of macOS uses. Setting it as
  // a template image makes the OS tint it with the system foreground
  // color (white on dark menubar, black on light), so we don't need a
  // separate dark-mode asset.
  if (process.platform === 'darwin') {
    try {
      const sys = nativeImage.createFromNamedImage('NSCaution', [0, 0, 0])
      if (!sys.isEmpty()) {
        sys.setTemplateImage(true)
        cachedAlertIcon = sys
        return sys
      }
    } catch {
      // Fall through to the hand-drawn fallback below.
    }
  }

  // Cross-platform fallback: hand-encoded 16×16 PNG. Used on Linux/
  // Windows where there is no NSImage catalogue, and as a safety net if
  // the named-image lookup ever returns empty on a future macOS.
  const buf = buildPng16x16Alpha(ALERT_MASK_16)
  const img = nativeImage.createFromBuffer(buf)
  if (process.platform === 'darwin') img.setTemplateImage(true)
  cachedAlertIcon = img
  return img
}
