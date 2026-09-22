// Types shared between the main process, preload bridge and renderer.

export type DatabaseKind = 'sqlite' | 'postgres'

export const KIND_LABELS: Record<DatabaseKind, string> = {
  sqlite: 'SQLite over SSH',
  postgres: 'PostgreSQL'
}

export type AuthMethod = 'password' | 'key' | 'agent'

/** How to reach a host over SSH. Used for the SQLite file host and for Postgres tunnels. */
export interface SshConfig {
  host: string
  port: number
  username: string
  auth: AuthMethod
  /** Password for `password` auth. Persisted (encrypted) only when savePassword is set. */
  password?: string
  savePassword?: boolean
  /** Local path to a private key for `key` auth. */
  privateKeyPath?: string
  passphrase?: string
  savePassphrase?: boolean
}

/** Mirrors libpq's sslmode. `prefer` tries TLS first and falls back to plain if the server has none. */
export type SslMode = 'prefer' | 'require' | 'verify-full' | 'disable'

export interface PostgresConfig {
  host: string
  port: number
  database: string
  user: string
  password?: string
  savePassword?: boolean
  sslMode: SslMode
  /** Reach the server through the SSH host in ConnectionConfig.ssh. */
  tunnel: boolean
}

export interface ConnectionConfig {
  id: string
  name: string
  kind: DatabaseKind
  /** Optional accent colour shown in the sidebar and title bar. */
  color?: string
  readOnly?: boolean
  lastUsedAt?: number
  createdAt?: number
  /** SQLite: the host holding the file. Postgres: the tunnel host, used when pg.tunnel is set. */
  ssh: SshConfig
  /** SQLite only. Path of the file on the remote host; `~` is expanded remotely. */
  remotePath?: string
  /** Postgres only. */
  pg?: PostgresConfig
}

type StoredSsh = Omit<SshConfig, 'password' | 'passphrase'> & { encryptedPassword?: string; encryptedPassphrase?: string }
type StoredPg = Omit<PostgresConfig, 'password'> & { encryptedPassword?: string }

/** Persisted shape: never contains plaintext secrets. */
export interface StoredConnection extends Omit<ConnectionConfig, 'ssh' | 'pg'> {
  ssh: StoredSsh
  pg?: StoredPg
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export interface TaggedInt {
  $type: 'int'
  value: string
}
export interface TaggedFloat {
  $type: 'float'
  /** 'nan', 'inf', '-inf', or a decimal/float literal such as '2.0', '12.50' or '1e+300'. */
  value: string
}
export interface TaggedBlob {
  $type: 'blob'
  base64: string
  size: number
  truncated: boolean
}
export type CellValue = null | boolean | number | string | TaggedInt | TaggedFloat | TaggedBlob

export function isTagged(v: CellValue): v is TaggedInt | TaggedFloat | TaggedBlob {
  return typeof v === 'object' && v !== null && '$type' in v
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** Identifies a table or view. `schema` is unset for SQLite. */
export interface TableRef {
  schema?: string
  name: string
}

export interface ColumnInfo {
  cid: number
  name: string
  type: string
  notnull: boolean
  dflt: string | null
  /** 0 = not part of PK, otherwise 1-based position within the PK. */
  pk: number
  /** 0 normal, 1 hidden (virtual table), 2 and 3 = computed by the server and not editable. */
  hidden: number
  /** Human label for special columns, e.g. "identity (always)" or "generated". */
  extra?: string
}

export interface TableMeta extends TableRef {
  type: 'table' | 'view'
  sql: string | null
  columns: ColumnInfo[]
  withoutRowid: boolean
  rowidAlias: 'rowid' | '_rowid_' | 'oid' | null
  pk: string[]
  comment?: string | null
  error?: string
}

export interface IndexMeta {
  name: string
  schema?: string
  table: string
  sql: string | null
  auto: boolean
}

export interface TriggerMeta {
  name: string
  schema?: string
  table: string
  sql: string | null
}

export interface SchemaInfo {
  kind: DatabaseKind
  /** Schema that bare table names refer to (Postgres: usually "public"). */
  defaultSchema?: string
  /** All non-system schemas, in display order. */
  schemas?: string[]
  tables: TableMeta[]
  views: TableMeta[]
  indexes: IndexMeta[]
  triggers: TriggerMeta[]
}

export interface IndexDetail {
  name: string
  unique: boolean
  origin: string
  partial: boolean
  columns: (string | null)[]
  sql: string | null
}

export interface ForeignKeyDetail {
  id: number
  seq: number
  table: string
  from: string
  to: string | null
  onUpdate: string
  onDelete: string
}

export interface TableDetails extends TableMeta {
  indexes: IndexDetail[]
  foreignKeys: ForeignKeyDetail[]
  triggers: { name: string; sql: string | null }[]
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface ResultColumn {
  name: string
  declType?: string
  pk?: number
  notnull?: boolean
  dflt?: string | null
  hidden?: number
}

export interface RowsResult {
  kind: 'rows'
  sql: string
  columns: ResultColumn[]
  rows: CellValue[][]
  rowCount: number
  truncated: boolean
  durationMs: number
}
export interface ExecResult {
  kind: 'exec'
  sql: string
  changes: number
  lastRowId: number | null
  durationMs: number
}
export interface ErrorResult {
  kind: 'error'
  sql: string
  message: string
  durationMs: number
}
export type StatementResult = RowsResult | ExecResult | ErrorResult

export interface QueryResponse {
  results: StatementResult[]
  durationMs: number
  /** True if the connection is inside an explicit transaction after this call. */
  tx: boolean
}

export interface RowsRequest {
  table: string
  schema?: string
  offset: number
  limit: number
  orderBy?: string
  orderDir?: 'asc' | 'desc'
  where?: string
  withCount?: boolean
}

export interface RowsResponse {
  table: string
  schema?: string
  columns: ResultColumn[]
  rows: CellValue[][]
  /** Parallel to rows; null when rows are addressed by primary key instead. */
  rowids: CellValue[] | null
  rowidAlias: 'rowid' | '_rowid_' | 'oid' | null
  pk: string[]
  isView: boolean
  total: number | null
  sql: string
  durationMs: number
  tx: boolean
}

export type RowKey =
  | { rowid: CellValue; alias: 'rowid' | '_rowid_' | 'oid' }
  | { pk: Record<string, CellValue> }

export type PendingChange =
  | { type: 'update'; table: string; schema?: string; key: RowKey; values: Record<string, CellValue> }
  | { type: 'insert'; table: string; schema?: string; values: Record<string, CellValue> }
  | { type: 'delete'; table: string; schema?: string; key: RowKey }

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface DatabaseInfo {
  kind: DatabaseKind
  /** What is open: the file path for SQLite, "database on host" for Postgres. */
  label: string
  /** e.g. "SQLite 3.50.4" or "PostgreSQL 16.3". */
  serverVersion: string
  readonly: boolean
  /** Extra facts for the status bar, in display order. */
  details: { label: string; value: string }[]
  /** SQLite only. */
  path?: string
  home?: string
  hostname?: string
  fileSize?: number
}

export interface SessionInfo {
  sessionId: string
  connectionId: string
  name: string
  kind: DatabaseKind
  color?: string
  /** Where we are connected: user@host for SQLite, user@host/database for Postgres. */
  target: string
  /** Set once a database has been opened on this session. */
  db: DatabaseInfo | null
  /** SQLite: interpreter used on the remote host. */
  interpreter?: string
  serverBanner?: string
  homeDir?: string | null
  /** Postgres: "user@host" of the SSH tunnel, when one is used. */
  tunnel?: string | null
}

export interface FileEntry {
  name: string
  path: string
  isDir: boolean
  isSymlink: boolean
  size: number
  mtime: number
}

export interface ReaddirResult {
  path: string
  parent: string | null
  entries: FileEntry[]
}

export interface ConnectProgress {
  stage: 'connecting' | 'authenticating' | 'tunnel' | 'probing' | 'starting-agent' | 'opening' | 'schema' | 'done'
  message: string
}

export type ExportFormat = 'csv' | 'json' | 'sql'

export interface ExportRequest {
  format: ExportFormat
  columns: string[]
  rows: CellValue[][]
  tableName?: string
  suggestedName: string
}

export interface AppInfo {
  version: string
  platform: NodeJS.Platform
  encryptionAvailable: boolean
  homeDir: string
  sshDir: string
}
