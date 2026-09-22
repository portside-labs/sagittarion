import type { DatabaseKind } from '@shared/types'
import { KIND_LABELS } from '@shared/types'
import postgresLogo from '@/assets/postgresql.svg'
import sqliteLogo from '@/assets/sqlite.svg'

const LOGOS: Record<DatabaseKind, string> = { postgres: postgresLogo, sqlite: sqliteLogo }

/** The database's own mark, sized for badges, cards and list rows. */
export function DbLogo({ kind, size = 20, className = '' }: { kind: DatabaseKind; size?: number; className?: string }) {
  return <img className={`db-logo ${kind} ${className}`} src={LOGOS[kind]} width={size} height={size} alt={KIND_LABELS[kind]} title={KIND_LABELS[kind]} draggable={false} />
}
