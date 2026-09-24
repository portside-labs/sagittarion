import { classifyType } from '@shared/coltypes'
import { Icon } from './Icons'

/**
 * The small symbol standing for a column's type, with the type spelled out in its tooltip.
 * Used wherever columns are listed, so the sidebar and result headers read the same way.
 */
export function TypeGlyph({
  declType,
  inferred,
  className,
  fallback
}: {
  declType: string | null | undefined
  /** The type was read off the values rather than declared. */
  inferred?: boolean
  className?: string
  /** Shown instead when the type is unknown. */
  fallback?: string
}) {
  const g = classifyType(declType)
  if (!g) return fallback ? <span className={className}>{fallback}</span> : null
  const declared = declType?.trim() ?? ''
  const spelled = declared && declared.toLowerCase() !== g.label.toLowerCase() ? ` · ${declared}` : ''
  const title = inferred ? `${g.label} (from the values)` : `${g.label}${spelled}`
  return (
    <span className={`type-glyph th-type family-${g.family} ${className ?? ''}`} title={title}>
      {g.icon ? <Icon name={g.icon} size={11} /> : g.glyph}
    </span>
  )
}
