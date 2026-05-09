import { describe, expect, it, vi } from 'vitest'

// Electron's `nativeImage` isn't available in vitest's Node sandbox. We mock
// just enough of it to let the encoder run end-to-end and assert on the
// PNG bytes it hands to createFromBuffer.
vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: (buf: Buffer) => ({
      __buffer: buf,
      setTemplateImage: () => {},
    }),
  },
}))

describe('tray-icons.getAlertTrayIcon', () => {
  it('produces a valid PNG buffer (signature + IHDR + IDAT + IEND)', async () => {
    const { getAlertTrayIcon } = await import('../tray-icons')
    const img = getAlertTrayIcon() as unknown as { __buffer: Buffer }
    const buf = img.__buffer
    // PNG magic.
    expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    // IHDR chunk: starts at offset 8, type bytes are at 12..16.
    expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR')
    // Width + height = 16 each.
    expect(buf.readUInt32BE(16)).toBe(16)
    expect(buf.readUInt32BE(20)).toBe(16)
    // colorType = 4 (grayscale + alpha).
    expect(buf.readUInt8(25)).toBe(4)
    // The buffer must contain an IEND chunk near the end.
    expect(buf.subarray(-8, -4).toString('ascii')).toBe('IEND')
  })

  it('caches the same NativeImage instance across calls', async () => {
    const { getAlertTrayIcon } = await import('../tray-icons')
    const a = getAlertTrayIcon()
    const b = getAlertTrayIcon()
    expect(a).toBe(b)
  })
})
