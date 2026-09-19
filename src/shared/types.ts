// Types shared between the main process, preload bridge and renderer.

export type AuthMethod = 'password' | 'key' | 'agent'

export interface ConnectionConfig {
  id: string
  name: string
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
  /** Path of the SQLite file on the remote host. `~` is expanded remotely. */
  remotePath: string
  readOnly?: boolean
  /** Optional accent colour shown in the sidebar and title bar. */
  color?: string
  lastUsedAt?: number
  createdAt?: number
}

/** Persisted shape: never contains plaintext secrets. */
export interface StoredConnection extends Omit<ConnectionConfig, 'password' | 'passphrase'> {
  encryptedPassword?: string
  encryptedPassphrase?: string
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
  /** 'nan', 'inf', '-inf', or the Python repr of an integral float such as '2.0' or '1e+300'. */
  value: string
}
export interface TaggedBlob {
  $type: 'blob'
  base64: string
  size: number
  truncated: boolean
}
export type CellValue = null | number | string | TaggedInt | TaggedFloat | TaggedBlob

export function isTagged(v: CellValue): v is TaggedInt | TaggedFloat | TaggedBlob {
  return typeof v === 'object' && v !== null && '$type' in v
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface ColumnInfo {
  cid: number
  name: string
  type: string
  notnull: boolean
  dflt: string | null
  /** 0 = not part of PK, otherwise 1-based position within the PK. */
  pk: number
  /** 0 normal, 1 hidden (virtual table), 2 generated virtual, 3 generated stored. */
  hidden: number
}

export interface TableMeta {
  name: string
  type: 'table' | 'view'
  sql: string | null
  columns: ColumnInfo[]
  withoutRowid: boolean
  rowidAlias: 'rowid' | '_rowid_' | 'oid' | null
  pk: string[]
  error?: string
}

export interface IndexMeta {
  name: string
  table: string
  sql: string | null
  auto: boolean
}

export interface TriggerMeta {
  name: string
  table: string
  sql: string | null
}

export interface SchemaInfo {
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
  offset: number
  limit: number
  orderBy?: string
  orderDir?: 'asc' | 'desc'
  where?: string
  withCount?: boolean
}

export interface RowsResponse {
  table: string
  columns: ResultColumn[]
  rows: CellValue[][]
  /** Parallel to rows; null for views and WITHOUT ROWID tables. */
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
  | { type: 'update'; table: string; key: RowKey; values: Record<string, CellValue> }
  | { type: 'insert'; table: string; values: Record<string, CellValue> }
  | { type: 'delete'; table: string; key: RowKey }

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface DatabaseInfo {
  path: string
  readonly: boolean
  sqliteVersion: string
  pythonVersion: string
  fileSize: number
  pageSize: number
  pageCount: number
  journalMode: string
  home: string
  hostname: string
  writable: boolean
}

export interface SessionInfo {
  sessionId: string
  connectionId: string
  name: string
  host: string
  port: number
  username: string
  color?: string
  /** Set once a database has been opened on this session. */
  db: DatabaseInfo | null
  /** Interpreter used on the remote host, e.g. "python3". */
  interpreter: string
  serverBanner: string
  homeDir: string | null
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
  stage: 'connecting' | 'authenticating' | 'probing' | 'starting-agent' | 'opening' | 'schema' | 'done'
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
