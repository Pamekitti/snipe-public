/**
 * The mark the phone pins, and the tab shows.
 *
 * Safari "Add to Home Screen" asks this origin for `/apple-touch-icon.png`. When that path
 * fell through to the HTML page, iOS threw the response away and drew the first letter of
 * the title instead: a grey P for "PONS v2". Android Chrome does the same without a
 * manifest icon. The catch-all in `server.ts` used to serve the document at every path.
 *
 * Drawn here, not stored as a file, so a deploy cannot forget a binary. Built on first
 * request and cached. Must not throw: this module is imported by the live listener.
 */
import { deflateSync } from 'node:zlib'

const BG0: Rgb = [0x0b, 0x0e, 0x14]
const BG1: Rgb = [0x24, 0x2d, 0x3c]
const DISC: Rgb = [0x1a, 0x23, 0x32]
const DISC_HI: Rgb = [0x38, 0x48, 0x60]
const WELL: Rgb = [0x0c, 0x10, 0x16]
const RING: Rgb = [0x8e, 0xaf, 0xf0]
const RING_HI: Rgb = [0xe4, 0xee, 0xff]
const GLOW: Rgb = [0x66, 0xbe, 0xa5]
const CORE: Rgb = [0x7d, 0xd4, 0xbc]
const SPEC: Rgb = [0xf4, 0xff, 0xfb]

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <defs>
    <radialGradient id="bg" cx="38%" cy="32%" r="78%">
      <stop offset="0%" stop-color="#2c3648"/>
      <stop offset="100%" stop-color="#0b0e14"/>
    </radialGradient>
    <radialGradient id="disc" cx="38%" cy="32%" r="70%">
      <stop offset="0%" stop-color="#384860"/>
      <stop offset="100%" stop-color="#1a2332"/>
    </radialGradient>
    <radialGradient id="glow" cx="50%" cy="50%" r="34%">
      <stop offset="0%" stop-color="#66bea5"/>
      <stop offset="70%" stop-color="#66bea5" stop-opacity=".15"/>
      <stop offset="100%" stop-color="#66bea5" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="32" height="32" fill="url(#bg)"/>
  <circle cx="16" cy="17.1" r="11.2" fill="#000" opacity=".35"/>
  <circle cx="16" cy="16" r="10.6" fill="url(#disc)"/>
  <circle cx="16" cy="16" r="7.1" fill="#0c1016"/>
  <circle cx="16" cy="16" r="7.1" fill="url(#glow)"/>
  <circle cx="16" cy="16" r="10.55" fill="none" stroke="#8eaff0" stroke-width="2.15"/>
  <circle cx="16" cy="16" r="4.35" fill="none" stroke="#b7c9f2" stroke-width="1.15"/>
  <path fill="none" stroke="#8eaff0" stroke-width="2.15" stroke-linecap="round" d="M16 4.4v3.6M16 24v3.6M4.4 16h3.6M24 16h3.6"/>
  <circle cx="16" cy="16" r="2.35" fill="#66bea5"/>
  <circle cx="15.25" cy="15.2" r=".7" fill="#f4fffb"/>
</svg>
`

export const MANIFEST_JSON = JSON.stringify({
  name: 'PONS v2',
  short_name: 'PONS',
  display: 'standalone',
  start_url: '/',
  background_color: '#101317',
  theme_color: '#101317',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
  ],
})

export type AppIcons = {
  readonly png180: Buffer
  readonly png192: Buffer
  readonly png512: Buffer
  readonly png32: Buffer
  readonly ico: Buffer
}

let cached: AppIcons | null = null

export function loadAppIcons(): AppIcons | null {
  if (cached) return cached
  try {
    cached = buildIcons()
    return cached
  } catch {
    return null
  }
}

const TOUCH_PATHS = new Set([
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/apple-touch-icon-180x180.png',
  '/apple-touch-icon-180x180-precomposed.png',
  '/apple-touch-icon-167x167.png',
  '/apple-touch-icon-167x167-precomposed.png',
  '/apple-touch-icon-152x152.png',
  '/apple-touch-icon-152x152-precomposed.png',
])

/** Bytes and type for a same-origin icon path, or null if this is not one. */
export function iconResponse(pathname: string): { body: Buffer | string; type: string } | null {
  if (pathname === '/favicon.svg') return { body: FAVICON_SVG, type: 'image/svg+xml; charset=utf-8' }
  if (pathname === '/manifest.webmanifest') return { body: MANIFEST_JSON, type: 'application/manifest+json' }
  const icons = loadAppIcons()
  if (!icons) return null
  if (TOUCH_PATHS.has(pathname)) return { body: icons.png180, type: 'image/png' }
  if (pathname === '/icon-192.png') return { body: icons.png192, type: 'image/png' }
  if (pathname === '/icon-512.png') return { body: icons.png512, type: 'image/png' }
  if (pathname === '/favicon-32.png') return { body: icons.png32, type: 'image/png' }
  if (pathname === '/favicon.ico') return { body: icons.ico, type: 'image/x-icon' }
  return null
}

// ---------------------------------------------------------------------------
// Raster
// ---------------------------------------------------------------------------

type Rgb = readonly [number, number, number]

function buildIcons(): AppIcons {
  const png180 = encodePng(180, paint(180))
  const png192 = encodePng(192, paint(192))
  const png512 = encodePng(512, paint(512))
  const png32 = encodePng(32, paint(32))
  return { png180, png192, png512, png32, ico: wrapIco(png32) }
}

/**
 * A filled night-optic, not a line drawing. Geometry is in fractions of the canvas so
 * every size is the same mark. The disc stays inside the centre 80%, which is the
 * maskable safe zone Android crops to.
 */
function paint(size: number): Uint8Array {
  const rgba = new Uint8Array(size * size * 4)
  const c = size / 2
  const discR = size * 0.332
  const wellR = size * 0.222
  const bezelR = size * 0.332
  const bezelW = size * 0.07
  const innerR = size * 0.138
  const innerW = size * 0.034
  const tickW = size * 0.07
  const tickIn = size * 0.268
  const tickOut = size * 0.455
  const glowR = size * 0.24
  const coreR = size * 0.074
  const specR = size * 0.026
  const shadowR = size * 0.35
  const hiAngle = Math.PI * -3 / 4

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5
      const py = y + 0.5
      const dx = px - c
      const dy = py - c
      const d = Math.hypot(dx, dy)

      const bgT = clamp01(d / (size * 0.74))
      put(rgba, size, x, y, mix(BG1, BG0, bgT * bgT))

      const shadow = coverDisk(px, py, c, c + size * 0.02, shadowR)
      if (shadow > 0) blend(rgba, size, x, y, [0, 0, 0], shadow * 0.38)

      const disc = coverDisk(px, py, c, c, discR)
      if (disc > 0) {
        const q = d / discR
        const z = Math.sqrt(Math.max(0, 1 - q * q))
        const lit = mix(DISC, DISC_HI, z * 0.85)
        blend(rgba, size, x, y, lit, disc)
      }

      const well = coverDisk(px, py, c, c, wellR)
      if (well > 0) blend(rgba, size, x, y, WELL, well)

      const gt = d / glowR
      const glow = gt >= 1 ? 0 : (1 - gt) * (1 - gt)
      if (glow > 0) blend(rgba, size, x, y, GLOW, glow * 0.62)

      const bezel = coverRing(px, py, c, c, bezelR, bezelW)
      if (bezel > 0) {
        const hi = Math.max(0, Math.cos(Math.atan2(dy, dx) - hiAngle))
        blend(rgba, size, x, y, mix(RING, RING_HI, hi * hi), bezel)
      }

      const inner = coverRing(px, py, c, c, innerR, innerW)
      if (inner > 0) blend(rgba, size, x, y, RING, inner * 0.88)

      let tick = coverSeg(px, py, c, c - tickOut, c, c - tickIn, tickW)
      tick = Math.max(tick, coverSeg(px, py, c, c + tickIn, c, c + tickOut, tickW))
      tick = Math.max(tick, coverSeg(px, py, c - tickOut, c, c - tickIn, c, tickW))
      tick = Math.max(tick, coverSeg(px, py, c + tickIn, c, c + tickOut, c, tickW))
      if (tick > 0) blend(rgba, size, x, y, RING, tick)

      const core = coverDisk(px, py, c, c, coreR)
      if (core > 0) blend(rgba, size, x, y, CORE, core)
      const spec = coverDisk(px, py, c - size * 0.022, c - size * 0.024, specR)
      if (spec > 0) blend(rgba, size, x, y, SPEC, spec)
    }
  }
  return rgba
}

function put(rgba: Uint8Array, size: number, x: number, y: number, rgb: Rgb): void {
  const i = (y * size + x) * 4
  rgba[i] = rgb[0]
  rgba[i + 1] = rgb[1]
  rgba[i + 2] = rgb[2]
  rgba[i + 3] = 255
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const u = clamp01(t)
  return [
    Math.round(a[0] + (b[0] - a[0]) * u),
    Math.round(a[1] + (b[1] - a[1]) * u),
    Math.round(a[2] + (b[2] - a[2]) * u),
  ]
}

function clamp01(t: number): number {
  if (t > 1) return 1
  if (t < 0) return 0
  return t
}

function coverRing(px: number, py: number, cx: number, cy: number, r: number, width: number): number {
  return coverBand(Math.hypot(px - cx, py - cy) - r, width / 2)
}

function coverDisk(px: number, py: number, cx: number, cy: number, r: number): number {
  const d = Math.hypot(px - cx, py - cy)
  if (d <= r - 0.5) return 1
  if (d >= r + 0.5) return 0
  return r + 0.5 - d
}

function coverSeg(px: number, py: number, x1: number, y1: number, x2: number, y2: number, width: number): number {
  const dx = x2 - x1
  const dy = y2 - y1
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / len2))
  return coverBand(Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy)), width / 2)
}

function coverBand(dist: number, half: number): number {
  const ad = Math.abs(dist)
  if (ad <= half - 0.5) return 1
  if (ad >= half + 0.5) return 0
  return half + 0.5 - ad
}

function blend(rgba: Uint8Array, size: number, x: number, y: number, rgb: Rgb, alpha: number): void {
  const a = alpha > 1 ? 1 : alpha < 0 ? 0 : alpha
  if (a === 0) return
  const i = (y * size + x) * 4
  const inv = 1 - a
  rgba[i] = Math.round((rgba[i] ?? 0) * inv + rgb[0] * a)
  rgba[i + 1] = Math.round((rgba[i + 1] ?? 0) * inv + rgb[1] * a)
  rgba[i + 2] = Math.round((rgba[i + 2] ?? 0) * inv + rgb[2] * a)
}

// ---------------------------------------------------------------------------
// PNG / ICO
// ---------------------------------------------------------------------------

function encodePng(size: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    const dst = y * (size * 4 + 1)
    raw[dst] = 0
    raw.set(rgba.subarray(y * size * 4, (y + 1) * size * 4), dst + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr.writeUInt8(8, 8)
  ihdr.writeUInt8(6, 9)
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function chunk(type: string, data: Buffer): Buffer {
  const body = Buffer.concat([Buffer.from(type), data])
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function wrapIco(png: Buffer): Buffer {
  const header = Buffer.alloc(22)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header.writeUInt8(32, 6)
  header.writeUInt8(32, 7)
  header.writeUInt16LE(1, 10)
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(png.length, 14)
  header.writeUInt32LE(22, 18)
  return Buffer.concat([header, png])
}

const CRC_BYTES = 1 << 8
const CRC_BITS = 1 << 3
const CRC_TABLE = new Uint32Array(CRC_BYTES)
for (let n = 0; n < CRC_BYTES; n++) {
  let c = n
  for (let k = 0; k < CRC_BITS; k++) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  CRC_TABLE[n] = c
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ (buf[i] ?? 0)) & 0xff] ?? 0) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
