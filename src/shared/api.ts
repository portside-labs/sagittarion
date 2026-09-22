import type {
  AppInfo,
  Catalog,
  ConnectProgress,
  ConnectionConfig,
  DatabaseInfo,
  ExportRequest,
  ListObjectsRequest,
  ObjectDefinition,
  ObjectPage,
  ObjectRef,
  PendingChange,
  QueryResponse,
  ReaddirResult,
  RowsRequest,
  RowsResponse,
  SearchResult,
  SessionInfo,
  TableDetails,
  TableRef
} from './types'
import type { AiProgressEvent, AiResult, AiSettings, AiSettingsUpdate, AiTurn } from './ai'

export interface OpenOptions {
  /** Open the configured database after connecting (default true). SQLite only; Postgres always opens. */
  openDatabase?: boolean
  /** Correlates progress events with this call. */
  requestId?: string
}

export interface SessionClosedEvent {
  sessionId: string
  reason: string
}

export interface ConnectProgressEvent extends ConnectProgress {
  requestId?: string
}

export type Unsubscribe = () => void

export interface Api {
  app: {
    info(): Promise<AppInfo>
    openExternal(url: string): Promise<void>
  }
  connections: {
    list(): Promise<ConnectionConfig[]>
    save(cfg: ConnectionConfig): Promise<ConnectionConfig>
    remove(id: string): Promise<void>
  }
  session: {
    open(cfg: ConnectionConfig, opts?: OpenOptions): Promise<SessionInfo>
    close(sessionId: string): Promise<void>
    onClosed(cb: (e: SessionClosedEvent) => void): Unsubscribe
    onProgress(cb: (e: ConnectProgressEvent) => void): Unsubscribe
  }
  db: {
    /** SQLite only: open (or switch to) a file on an already connected SSH session. */
    open(sessionId: string, remotePath: string, readOnly: boolean): Promise<DatabaseInfo>
    /** Schema names and object counts: the first, cheap look at a database. Also refreshes the AI's schema index. */
    catalog(sessionId: string): Promise<Catalog>
    /** Object names of one family, paged with a keyset cursor. */
    listObjects(sessionId: string, req: ListObjectsRequest): Promise<ObjectPage>
    /** Objects and columns whose names contain the query. */
    searchObjects(sessionId: string, query: string, limit?: number): Promise<SearchResult>
    /** The DDL of one object, fetched on demand. */
    definition(sessionId: string, ref: ObjectRef): Promise<ObjectDefinition>
    tableDetails(sessionId: string, ref: TableRef): Promise<TableDetails>
    rows(sessionId: string, req: RowsRequest): Promise<RowsResponse>
    count(sessionId: string, ref: TableRef, where?: string): Promise<number>
    query(sessionId: string, sql: string, params?: unknown[], maxRows?: number): Promise<QueryResponse>
    cancel(sessionId: string): Promise<void>
    apply(sessionId: string, changes: PendingChange[]): Promise<number>
  }
  sftp: {
    readdir(sessionId: string, path: string): Promise<ReaddirResult>
    home(sessionId: string): Promise<string>
  }
  dialog: {
    pickPrivateKey(): Promise<string | null>
  }
  exportData(req: ExportRequest): Promise<{ saved: boolean; path?: string }>
  settings: {
    get(): Promise<AiSettings>
    update(u: AiSettingsUpdate): Promise<AiSettings>
    /** Checks that the provider answers with the given overrides on top of the saved settings. */
    testProvider(overrides?: AiSettingsUpdate): Promise<{ ok: boolean; message: string }>
    listModels(overrides?: AiSettingsUpdate): Promise<string[]>
  }
  ai: {
    /** Turn a plain-English question into a verified read-only query for the open database. */
    ask(sessionId: string, question: string, history?: AiTurn[], requestId?: string): Promise<AiResult>
    /** Stop a running ask; the pending call resolves with kind "cancelled". */
    cancel(requestId: string): Promise<void>
    /** Step-by-step progress of running asks, keyed by requestId. */
    onProgress(cb: (e: AiProgressEvent) => void): Unsubscribe
  }
}
