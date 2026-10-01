// Answers in words, as markdown: headings, lists, tables, code. Built as React elements, never as HTML, so nothing in
// a reply can add markup to the page; links open in the browser, and remote images are not fetched.
import Markdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Element, ElementContent } from 'hast'
import { SqlCode } from './SqlCode'

/** Code fences highlighted as SQL; anything else is shown as plain code. */
const SQL_LANGUAGES = new Set(['sql', 'sqlite', 'postgres', 'postgresql', 'pgsql', 'psql', 'plpgsql'])

function textOf(node: Element | ElementContent): string {
  if (node.type === 'text') return node.value
  return 'children' in node ? node.children.map((c) => textOf(c as ElementContent)).join('') : ''
}

function languageOf(code: Element | undefined): string | undefined {
  const classes = code?.properties?.className
  const list = Array.isArray(classes) ? classes.map(String) : classes ? [String(classes)] : []
  return list.map((c) => /^language-([\w+-]+)$/.exec(c)?.[1]).find(Boolean)?.toLowerCase()
}

function openLink(href: string | undefined): void {
  if (href && /^https?:\/\//i.test(href)) void window.api.app.openExternal(href)
}

export function ChatMarkdown({ text, dialect, className = '' }: { text: string; dialect: 'sqlite' | 'postgres'; className?: string }) {
  const components: Components = {
    a: ({ href, children }) => (
      <a
        href={href}
        title={href}
        onClick={(e) => {
          e.preventDefault()
          openLink(href)
        }}
      >
        {children}
      </a>
    ),
    // The page's content policy blocks remote images anyway; say what was there instead.
    img: ({ alt }) => <span className="md-image">{alt ? `[image: ${alt}]` : '[image]'}</span>,
    pre: ({ node }) => {
      const code = node?.children.find((c): c is Element => c.type === 'element' && c.tagName === 'code')
      const source = (node ? textOf(code ?? node) : '').replace(/\n$/, '')
      const language = languageOf(code)
      if (language && SQL_LANGUAGES.has(language)) return <SqlCode sql={source} dialect={dialect} className="chat-sql" />
      return (
        <pre className="chat-code" data-language={language}>
          {source}
        </pre>
      )
    },
    code: ({ children }) => <code className="md-code">{children}</code>,
    table: ({ children }) => (
      <div className="md-table">
        <table>{children}</table>
      </div>
    )
  }
  return (
    <div className={`chat-markdown ${className}`}>
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </Markdown>
    </div>
  )
}
