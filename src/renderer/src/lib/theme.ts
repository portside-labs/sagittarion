// The accent colour follows the open connection so the whole window says
// which database it is. With no colour chosen the accent is white.

export const DEFAULT_ACCENT = '#ffffff'

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function toHex([r, g, b]: [number, number, number]): string {
  return '#' + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
}

function luminance([r, g, b]: [number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function mix(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

/** Every accent-derived variable for a colour: the hover shade, soft fills, selection and readable text on it. */
export function accentVariables(hex: string): Record<string, string> {
  const rgb = parseHex(hex) ?? parseHex(DEFAULT_ACCENT)!
  const light = luminance(rgb) > 0.45
  const strong = mix(rgb, light ? [0, 0, 0] : [255, 255, 255], 0.14)
  const [r, g, b] = rgb.map(Math.round)
  return {
    '--accent': toHex(rgb),
    '--accent-strong': toHex(strong),
    '--accent-soft': `rgba(${r}, ${g}, ${b}, ${light ? 0.12 : 0.18})`,
    '--selection': `rgba(${r}, ${g}, ${b}, ${light ? 0.22 : 0.3})`,
    '--on-accent': light ? '#111318' : '#ffffff'
  }
}

export function applyAccent(hex: string | undefined): void {
  const vars = accentVariables(hex ?? DEFAULT_ACCENT)
  const root = document.documentElement.style
  for (const [k, v] of Object.entries(vars)) root.setProperty(k, v)
}
