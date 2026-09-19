import type { ReactNode } from 'react'

export function TitleBar({ left, center, right }: { left?: ReactNode; center?: ReactNode; right?: ReactNode }) {
  return (
    <div className="titlebar">
      <div className="titlebar-left">{left}</div>
      <div className="titlebar-center">{center}</div>
      <div className="titlebar-right">{right}</div>
    </div>
  )
}
