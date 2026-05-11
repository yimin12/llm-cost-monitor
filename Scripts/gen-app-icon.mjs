// One-shot generator for the macOS/Linux app icon. Renders a 1024×1024 PNG
// matching the brand mark on the dropdown header: a Lucide `zap` glyph on a
// purple-gradient squircle. electron-builder rejects anything below 512×512
// for `mac.icon` / `linux.icon`, so this is the canonical source.
//
// Run: node Scripts/gen-app-icon.mjs

import { writeFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#7C3AED"/>
      <stop offset="1" stop-color="#4338CA"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="1024" height="1024" rx="224" ry="224" fill="url(#bg)"/>
  <g transform="translate(512 512) scale(28) translate(-12 -12)" fill="none" stroke="#FFFFFF" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 14a1 1 0 0 1-.78-1.63l9.9-10.2a.5.5 0 0 1 .86.46l-1.92 6.02A1 1 0 0 0 13 10h7a1 1 0 0 1 .78 1.63l-9.9 10.2a.5.5 0 0 1-.86-.46l1.92-6.02A1 1 0 0 0 11 14z"/>
  </g>
</svg>`

const out = new Resvg(SVG, { fitTo: { mode: 'width', value: 1024 } }).render().asPng()
writeFileSync('resources/icons/app-icon.png', out)
console.log(`wrote resources/icons/app-icon.png (${out.length} bytes)`)
