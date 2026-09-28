// Every theme colours the same things: a variable set by one theme and missed by another would keep the colour of
// whichever theme came first. Code colours chosen over a theme's, and the fonts offered for the editor, are checked
// against the stylesheet and the bundled fonts the same way.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CODE_FONTS, DEFAULT_THEME, SYNTAX_PALETTES, THEMES, codeFontFamily, isCodeFontId, isSyntaxId, isThemeId } from '../src/renderer/src/lib/theme'

const css = readFileSync(resolve(__dirname, '../src/renderer/src/styles.css'), 'utf8')
const fonts = readFileSync(resolve(__dirname, '../src/renderer/src/fonts.ts'), 'utf8')

/** The variables an attribute's block sets, with their values. */
function block(attr: string, id: string): Record<string, string> {
  const m = new RegExp(`\\[${attr}="${id}"\\]\\s*\\{([^}]*)\\}`).exec(css)
  expect(m, `styles.css has a block for ${attr}="${id}"`).not.toBeNull()
  return Object.fromEntries([...m![1].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((v) => [v[1], v[2].trim()]))
}

const SYNTAX_VARS = ['--syntax-comment', '--syntax-keyword', '--syntax-number', '--syntax-string']

describe('themes', () => {
  it('set the same variables, each to its own colours', () => {
    const blocks = THEMES.map((t) => block('data-theme', t.id))
    const names = Object.keys(blocks[0]).sort()
    expect(names.length).toBeGreaterThan(10)
    for (const b of blocks) expect(Object.keys(b).sort()).toEqual(names)
    expect(new Set(blocks.map((b) => b['--bg'])).size).toBe(THEMES.length)
  })

  it('leave the surfaces out of the shared variables', () => {
    const root = /^:root\s*\{([^}]*)\}/m.exec(css)![1]
    for (const name of Object.keys(block('data-theme', DEFAULT_THEME))) expect(root).not.toContain(`${name}:`)
  })

  it('start on the default until one is chosen', () => {
    // The default's block also covers :root, so the page is themed before one is applied.
    expect(css).toMatch(new RegExp(`:root,\\s*\\[data-theme="${DEFAULT_THEME}"\\]\\s*\\{`))
    expect(isThemeId('cobalt')).toBe(true)
    expect(isThemeId('solarized')).toBe(false)
    expect(isThemeId(undefined)).toBe(false)
  })
})

describe('code colours', () => {
  it('set the four code colours and nothing else', () => {
    for (const p of SYNTAX_PALETTES) expect(Object.keys(block('data-syntax', p.id)).sort()).toEqual(SYNTAX_VARS)
  })

  it('include every theme’s own, as the palette the theme names', () => {
    for (const t of THEMES) {
      const theme = block('data-theme', t.id)
      const own = block('data-syntax', t.syntax)
      for (const v of SYNTAX_VARS) expect(theme[v], `${t.id} ${v}`).toBe(own[v])
    }
  })

  it('come after the themes, so a chosen palette wins over the theme on the same element', () => {
    const lastTheme = Math.max(...THEMES.map((t) => css.indexOf(`[data-theme="${t.id}"]`)))
    for (const p of SYNTAX_PALETTES) expect(css.indexOf(`[data-syntax="${p.id}"]`)).toBeGreaterThan(lastTheme)
    expect(isSyntaxId('ocean')).toBe(true)
    expect(isSyntaxId('neon')).toBe(false)
  })
})

describe('code fonts', () => {
  it('are each bundled, and fall back to the default code font', () => {
    for (const f of CODE_FONTS) {
      expect(fonts).toContain(`@fontsource/${f.id}/`)
      // Registered under the name the editor asks for, and not under the font's own, which an installed copy keeps.
      const family = /^"([^"]+)", var\(--mono\)$/.exec(f.family)![1]
      expect(fonts).toContain(`['${family}', `)
      expect(family).not.toBe(f.label)
    }
    expect(codeFontFamily(null)).toBeUndefined()
    expect(isCodeFontId('fira-code')).toBe(true)
    expect(isCodeFontId('comic-sans')).toBe(false)
  })
})
