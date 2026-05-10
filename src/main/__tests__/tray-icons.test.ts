import { describe, expect, it, vi } from 'vitest'

// Electron's `nativeImage` isn't available in vitest's Node sandbox, so
// we capture what gets handed to it. The real Resvg renderer DOES run
// here — that's the most useful part of the assertion: we want to know
// the bundled SVG actually rasterizes into a non-empty PNG.
const reps: { scaleFactor: number; buf: Buffer }[] = []
let templateFlag = false

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: (buf: Buffer) => ({
      __buffer: buf,
      addRepresentation: (opts: { scaleFactor: number; buffer: Buffer }) => {
        reps.push({ scaleFactor: opts.scaleFactor, buf: opts.buffer })
      },
      setTemplateImage: (v: boolean) => {
        templateFlag = v
      },
      isEmpty: () => false,
    }),
  },
}))

describe('tray-icons.getAlertTrayIcon', () => {
  it('rasterizes the bundled Lucide SVG into a valid PNG buffer', async () => {
    const { getAlertTrayIcon } = await import('../tray-icons')
    const img = getAlertTrayIcon() as unknown as { __buffer: Buffer }
    const buf = img.__buffer
    // PNG magic bytes — confirms resvg actually emitted PNG.
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    // IHDR chunk type at offset 12.
    expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR')
    // 1x rendering at 16×16.
    expect(buf.readUInt32BE(16)).toBe(16)
    expect(buf.readUInt32BE(20)).toBe(16)
  })

  it('attaches a 2x retina representation', async () => {
    const { getAlertTrayIcon } = await import('../tray-icons')
    getAlertTrayIcon()
    const retina = reps.find((r) => r.scaleFactor === 2)
    expect(retina).toBeDefined()
    // 2x buffer is 32×32 pixels.
    expect(retina!.buf.readUInt32BE(16)).toBe(32)
    expect(retina!.buf.readUInt32BE(20)).toBe(32)
  })

  it('flags the image as a template on macOS-like platforms', async () => {
    const { getAlertTrayIcon } = await import('../tray-icons')
    getAlertTrayIcon()
    if (process.platform === 'darwin') {
      expect(templateFlag).toBe(true)
    }
  })

  it('caches the same NativeImage instance across calls', async () => {
    const { getAlertTrayIcon } = await import('../tray-icons')
    const a = getAlertTrayIcon()
    const b = getAlertTrayIcon()
    expect(a).toBe(b)
  })
})
