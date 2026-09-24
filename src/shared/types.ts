// Types shared between the main process, preload bridge and renderer.

export type DatabaseKind = 'sqlite' | 'postgres'

export const KIND_LABELS: Record<DatabaseKind, string> = {
  sqlite: 'SQLite',
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
  /** Optional group the connection is listed under: an app, an environment, whatever suits the user. */
  group?: string
  readOnly?: boolean
  lastUsedAt?: number
  createdAt?: number
  /** SQLite: the host holding the file when `remote` is set. Postgres: the tunnel host, used when pg.tunnel is set. */
  ssh: SshConfig
  /** SQLite: the file lives on the SSH host rather than on this computer. */
  remote?: boolean
  /** Use a saved SSH profile for the SSH host or tunnel instead of the inline `ssh` fields. */
  sshProfileId?: string
  /** SQLite only. Path of the database file, on this computer or on the SSH host; `~` is expanded there. */
  remotePath?: string
  /** Postgres only. */
  pg?: PostgresConfig
}

/** How a connection group looks in the list. Groups themselves are implied by the connections in them. */
export interface GroupStyle {
  color?: string
}

/** SSH details saved once and reused by any number of connections. */
export interface SshProfile extends SshConfig {
  id: string
  name: string
  createdAt?: number
  lastUsedAt?: number
}

export interface StoredSshProfile extends Omit<SshProfile, 'password' | 'passphrase'> {
  encryptedPassword?: string
  encryptedPassphrase?: string
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
  /** Approximate row count when the server can tell cheaply (Postgres statistics). */
  rowEstimate?: number | null
  error?: string
}

/** A foreign-key column pair. */
export interface Relation {
  schema?: string
  table: string
  column: string
  refSchema?: string
  refTable: string
  refColumn: string | null
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
  /** Foreign keys across the whole schema, for join-aware tooling. */
  relations?: Relation[]
}

// ---------------------------------------------------------------------------
// Catalog: the lazily loaded view of a schema used by the sidebar and the AI
// ---------------------------------------------------------------------------

export type ObjectKind = 'table' | 'view' | 'function' | 'index' | 'trigger'

/** Display order of object groups inside a schema. */
export const OBJECT_KINDS: ObjectKind[] = ['table', 'view', 'function', 'index', 'trigger']

export type ObjectCounts = Record<ObjectKind, number>

export interface SchemaSummary {
  name: string
  counts: ObjectCounts
}

/** Cheap first look at a database: schema names and how many objects each holds. */
export interface Catalog {
  kind: DatabaseKind
  defaultSchema?: string
  /** Empty for SQLite, which has a single implicit schema. */
  schemas: SchemaSummary[]
  totalObjects: number
  totalTables: number
}

/** One row of a lazily loaded object list: names only, no columns or definitions. */
export interface ObjectSummary {
  /** Stable identifier (Postgres oid, SQLite name), unique within its kind. */
  id: string
  kind: ObjectKind
  schema?: string
  name: string
  /** Finer kind: table | partitioned | foreign | view | matview | function | procedure | aggregate | window | trigger-function. */
  subtype?: string
  /** Index and trigger: the table they belong to. */
  table?: string
  /** Function: identity arguments, return type and language. */
  args?: string
  returns?: string | null
  language?: string
  columnCount?: number | null
  rowEstimate?: number | null
  comment?: string | null
}

export interface ListObjectsRequest {
  /** Restrict to one schema; omitted means every schema. */
  schema?: string
  /** Kinds of one family: table and view together, or a single index, trigger or function kind. */
  kinds: ObjectKind[]
  /** Opaque cursor from the previous page. */
  cursor?: string | null
  limit?: number
}

export interface ObjectPage {
  items: ObjectSummary[]
  /** Cursor for the next page, or null when this was the last one. */
  cursor: string | null
}

export interface ObjectRef {
  kind: ObjectKind
  schema?: string
  name: string
  id?: string
}

export interface ObjectDefinition extends ObjectRef {
  sql: string | null
}

export interface ColumnHit {
  schema?: string
  table: string
  tableKind: 'table' | 'view'
  tableId?: string
  column: string
  type: string
}

export interface SearchResult {
  query: string
  objects: ObjectSummary[]
  columns: ColumnHit[]
  truncated: boolean
}

export interface QueryOptions {
  /** Refuse writes at the database level for this call (SQLite query_only, Postgres read-only transaction). */
  readOnly?: boolean
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
  /** The type was read off the values rather than declared (SQLite query results). */
  inferred?: boolean
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

// ---------------------------------------------------------------------------
// Workspace kept between launches
// ---------------------------------------------------------------------------

/** What a query tab needs to reopen as it was: its text, row limit, last run and chat. */
export interface QueryTabSnapshot {
  sql: string
  limit: number
  lastRun?: {
    sql: string
    at: number
    ms: number
    statements: number
    /** null when the run failed, or when the results were too large to keep. */
    results: StatementResult[] | null
    error: string | null
    resultsDropped?: boolean
  }
  chat?: { messages: unknown[]; input: string }
}

export type WorkspaceTab =
  | { id: string; kind: 'table'; schema?: string; table: string; title: string }
  | { id: string; kind: 'query'; title: string; snapshot: QueryTabSnapshot }

/** One open connection's tabs. */
export interface WorkspaceConnection {
  connectionId: string
  activeTabId: string | null
  queryCounter: number
  tabs: WorkspaceTab[]
}

export interface WorkspaceState {
  version: 1
  activeConnectionId: string | null
  showConnect: boolean
  connections: WorkspaceConnection[]
}
