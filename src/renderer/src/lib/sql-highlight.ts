// The colours of SQL, wherever it is shown: the editor and the queries in the chat. Keywords and literals stand out;
// names and punctuation stay in the text colour. The colours themselves are CSS variables (--syntax-*).
import { HighlightStyle } from '@codemirror/language'
import { tags as t } from '@lezer/highlight'

export const sqlHighlightStyle = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.controlKeyword, t.definitionKeyword, t.modifier, t.typeName, t.bool, t.null], color: 'var(--syntax-keyword)' },
  { tag: [t.string, t.special(t.string), t.character], color: 'var(--syntax-string)' },
  { tag: [t.number, t.integer, t.float], color: 'var(--syntax-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--syntax-comment)', fontStyle: 'italic' },
  { tag: t.invalid, color: 'var(--danger)' }
])
