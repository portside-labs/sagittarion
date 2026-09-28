// The code fonts offered in Settings, bundled so they look the same on every computer: regular and italic (comments
// are italic; Fira Code has no italic, so its comments are slanted), Latin only, with other characters from the default
// code font. Each goes by a name of its own, so a copy installed on this computer, which the default code font may use
// in all its weights, is left alone. All four are under the SIL Open Font License 1.1, carried in each font file.
import jetbrainsMono from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2?url'
import jetbrainsMonoItalic from '@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-italic.woff2?url'
import firaCode from '@fontsource/fira-code/files/fira-code-latin-400-normal.woff2?url'
import ibmPlexMono from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2?url'
import ibmPlexMonoItalic from '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-italic.woff2?url'
import sourceCodePro from '@fontsource/source-code-pro/files/source-code-pro-latin-400-normal.woff2?url'
import sourceCodeProItalic from '@fontsource/source-code-pro/files/source-code-pro-latin-400-italic.woff2?url'

const FACES: [family: string, url: string, style: 'normal' | 'italic'][] = [
  ['Bundled JetBrains Mono', jetbrainsMono, 'normal'],
  ['Bundled JetBrains Mono', jetbrainsMonoItalic, 'italic'],
  ['Bundled Fira Code', firaCode, 'normal'],
  ['Bundled IBM Plex Mono', ibmPlexMono, 'normal'],
  ['Bundled IBM Plex Mono', ibmPlexMonoItalic, 'italic'],
  ['Bundled Source Code Pro', sourceCodePro, 'normal'],
  ['Bundled Source Code Pro', sourceCodeProItalic, 'italic']
]

// Loaded only once something is set in one of them.
for (const [family, url, style] of FACES) document.fonts.add(new FontFace(family, `url("${url}") format("woff2")`, { style, weight: '400', display: 'swap' }))
