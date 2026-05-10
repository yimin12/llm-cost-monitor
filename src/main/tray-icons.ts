import { Resvg } from '@resvg/resvg-js'
import { nativeImage, type NativeImage } from 'electron'

// Tray icons — sourced from Lucide (MIT, https://lucide.dev). Lucide is a
// continuation of Feather Icons and is widely used for iOS-style minimal
// line icons; using a real icon library beats hand-drawing a 16×16 pixel
// matrix.
//
// `stroke="currentColor"` from upstream is replaced with `#fff` so the
// rendered PNG has opaque pixels exactly where the icon strokes are. On
// macOS the image is flagged as a template — AppKit uses the alpha
// channel as a mask and tints non-transparent pixels with the system
// foreground color (white on dark menubar, black on light), so we don't
// ship a separate light/dark asset.

const TRIANGLE_ALERT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
  <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/>
  <path d="M12 9v4"/>
  <path d="M12 17h.01"/>
</svg>`

// Lucide `zap` — matches the lightning-bolt brand mark on the dropdown
// header so the menubar and window agree on identity.
const ZAP_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
  <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>
</svg>`

function renderSvgToPng(svg: string, sizePx: number): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: sizePx },
    background: 'rgba(0,0,0,0)',
  })
  return resvg.render().asPng()
}

function buildIcon(svg: string): NativeImage {
  // Render at 1x (16 pt) and 2x (32 pt) so retina menubars get a sharp
  // representation. addRepresentation lets one NativeImage hold both,
  // and AppKit picks the right one for the active display.
  const png1x = renderSvgToPng(svg, 16)
  const png2x = renderSvgToPng(svg, 32)
  const img = nativeImage.createFromBuffer(png1x)
  img.addRepresentation({ scaleFactor: 2, width: 16, height: 16, buffer: png2x })
  if (process.platform === 'darwin') img.setTemplateImage(true)
  return img
}

let cachedAlertIcon: NativeImage | null = null
let cachedBaseIcon: NativeImage | null = null

export function getAlertTrayIcon(): NativeImage {
  if (cachedAlertIcon === null) cachedAlertIcon = buildIcon(TRIANGLE_ALERT_SVG)
  return cachedAlertIcon
}

export function getBaseTrayIcon(): NativeImage {
  if (cachedBaseIcon === null) cachedBaseIcon = buildIcon(ZAP_SVG)
  return cachedBaseIcon
}
