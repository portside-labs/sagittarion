import type { ReactNode } from 'react'

export type IconName =
  | 'table'
  | 'view'
  | 'index'
  | 'trigger'
  | 'function'
  | 'grip'
  | 'layout'
  | 'key'
  | 'chevron-right'
  | 'chevron-down'
  | 'play'
  | 'stop'
  | 'refresh'
  | 'plus'
  | 'minus'
  | 'x'
  | 'folder'
  | 'file'
  | 'database'
  | 'search'
  | 'columns'
  | 'download'
  | 'filter'
  | 'home'
  | 'arrow-up'
  | 'arrow-left'
  | 'arrow-right'
  | 'code'
  | 'panel'
  | 'trash'
  | 'check'
  | 'unplug'
  | 'terminal'
  | 'lock'
  | 'copy'
  | 'settings'
  | 'sparkles'

const paths: Record<IconName, ReactNode> = {
  table: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 10h18M9 10v10M15 10v10" />
    </>
  ),
  view: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  index: (
    <>
      <path d="M4 6h16M4 12h10M4 18h6" />
      <path d="M17 15l3 3-3 3" />
    </>
  ),
  trigger: <path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" />,
  grip: (
    <>
      <circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  layout: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 12h18M14 3v18" />
    </>
  ),
  function: (
    <>
      <path d="M15 4c-2.2 0-3.4 1.2-3.8 3.4L9.6 17.2C9.2 19.3 8 20 6 20" />
      <path d="M7 10h8" />
      <path d="M14 14l4 6M18 14l-4 6" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="15" r="4" />
      <path d="M10.85 12.15L19 4M18 5l3 3M15 8l3 3" />
    </>
  ),
  'chevron-right': <path d="M9 6l6 6-6 6" />,
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  play: <path d="M6 4l14 8-14 8V4z" fill="currentColor" stroke="none" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  refresh: (
    <>
      <path d="M21 12a9 9 0 1 1-3-6.7" />
      <path d="M21 3v6h-6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" />,
  file: (
    <>
      <path d="M6 2h8l6 6v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" />
      <path d="M14 2v6h6" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-4-4" />
    </>
  ),
  columns: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16M15 4v16" />
    </>
  ),
  download: (
    <>
      <path d="M12 3v12M6 9l6 6 6-6" />
      <path d="M4 21h16" />
    </>
  ),
  filter: <path d="M3 5h18l-7 8v6l-4 2v-8L3 5z" />,
  home: (
    <>
      <path d="M3 11l9-8 9 8" />
      <path d="M5 10v10h14V10" />
    </>
  ),
  'arrow-up': <path d="M12 19V5M5 12l7-7 7 7" />,
  'arrow-left': <path d="M19 12H5M12 19l-7-7 7-7" />,
  'arrow-right': <path d="M5 12h14M12 5l7 7-7 7" />,
  code: <path d="M8 6l-6 6 6 6M16 6l6 6-6 6" />,
  panel: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M15 4v16" />
    </>
  ),
  trash: (
    <>
      <path d="M4 7h16M10 11v6M14 11v6" />
      <path d="M6 7l1 13h10l1-13M9 7V4h6v3" />
    </>
  ),
  check: <path d="M5 13l4 4L19 7" />,
  unplug: (
    <>
      <path d="M16 8l4-4M2 22l4-4" />
      <path d="M7 12l5 5 3-3a4 4 0 0 0 0-5.7l-.3-.3M17 12l-5-5-3 3a4 4 0 0 0 0 5.7l.3.3" />
    </>
  ),
  terminal: (
    <>
      <path d="M4 17l6-5-6-5M12 19h8" />
    </>
  ),
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="12" height="12" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </>
  ),
  sparkles: (
    <>
      <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z" />
      <path d="M19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8L19 16z" />
    </>
  )
}

export function Icon({ name, size = 14, className = '', title }: { name: IconName; size?: number; className?: string; title?: string }) {
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
    >
      {title ? <title>{title}</title> : null}
      {paths[name]}
    </svg>
  )
}
