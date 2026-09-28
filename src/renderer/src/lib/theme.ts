// The window's colours: a theme for the surfaces, text and code, code colours and a code font that can be chosen over
// the theme's, and a white accent. Group colours mark the tabs of a group, not the window.

/**
 * Code colours offered in Settings, in the order shown: keywords, strings, numbers and comments. Their colours are the
 * [data-syntax] blocks in styles.css, and every theme's own are one of them.
 */
export const SYNTAX_PALETTES = [
  { id: 'blossom', label: 'Blossom' },
  { id: 'twilight', label: 'Twilight' },
  { id: 'iris', label: 'Iris' },
  { id: 'meadow', label: 'Meadow' },
  { id: 'ember', label: 'Ember' },
  { id: 'classic', label: 'Classic' },
  { id: 'ocean', label: 'Ocean' },
  { id: 'mono', label: 'Mono' }
] as const

export type SyntaxId = (typeof SYNTAX_PALETTES)[number]['id']

/** The themes offered in Settings, in the order shown. Their colours are the [data-theme] blocks in styles.css. */
export const THEMES = [
  { id: 'charcoal', label: 'Charcoal', syntax: 'blossom' },
  { id: 'cobalt', label: 'Cobalt', syntax: 'blossom' },
  { id: 'midnight', label: 'Midnight', syntax: 'twilight' },
  { id: 'plum', label: 'Plum', syntax: 'iris' },
  { id: 'moss', label: 'Moss', syntax: 'meadow' },
  { id: 'umber', label: 'Umber', syntax: 'ember' }
] as const satisfies readonly { id: string; label: string; syntax: SyntaxId }[]

export type ThemeId = (typeof THEMES)[number]['id']

export const DEFAULT_THEME: ThemeId = 'charcoal'

export function isThemeId(v: unknown): v is ThemeId {
  return THEMES.some((t) => t.id === v)
}

export function isSyntaxId(v: unknown): v is SyntaxId {
  return SYNTAX_PALETTES.some((p) => p.id === v)
}

/**
 * Fonts for the SQL editor, bundled (fonts.ts) so each looks the same on every computer, under names of their own.
 * Characters a font lacks come from the default code font.
 */
export const CODE_FONTS = [
  { id: 'jetbrains-mono', label: 'JetBrains Mono', family: '"Bundled JetBrains Mono", var(--mono)' },
  { id: 'fira-code', label: 'Fira Code', family: '"Bundled Fira Code", var(--mono)' },
  { id: 'ibm-plex-mono', label: 'IBM Plex Mono', family: '"Bundled IBM Plex Mono", var(--mono)' },
  { id: 'source-code-pro', label: 'Source Code Pro', family: '"Bundled Source Code Pro", var(--mono)' }
] as const

export type CodeFontId = (typeof CODE_FONTS)[number]['id']

export function isCodeFontId(v: unknown): v is CodeFontId {
  return CODE_FONTS.some((f) => f.id === v)
}

/** The CSS font family for a chosen code font; nothing for the theme's, which the editor has already. */
export function codeFontFamily(id: CodeFontId | null): string | undefined {
  return CODE_FONTS.find((f) => f.id === id)?.family
}

/** Code colours chosen over the theme's, or the theme's own again with null. */
export function applySyntax(syntax: SyntaxId | null): void {
  const root = document.documentElement
  if (syntax) root.dataset.syntax = syntax
  else delete root.dataset.syntax
}

/** Puts the page in a theme, and gives the window the same background: it shows while the window is resized. */
export function applyTheme(theme: ThemeId): void {
  const root = document.documentElement
  if (root.dataset.theme === theme) return
  root.dataset.theme = theme
  const bg = getComputedStyle(root).getPropertyValue('--bg').trim()
  if (bg) window.api.app.setBackgroundColor(bg).catch(() => {})
}

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
