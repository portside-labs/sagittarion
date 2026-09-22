import type {
  AppInfo,
  ConnectProgress,
  ConnectionConfig,
  DatabaseInfo,
  ExportRequest,
  PendingChange,
  QueryResponse,
  ReaddirResult,
  RowsRequest,
  RowsResponse,
  SchemaInfo,
  SessionInfo,
  TableDetails,
  TableRef
} from './types'
import type { AiResult, AiSettings, AiSettingsUpdate, AiTurn } from './ai'

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
    schema(sessionId: string): Promise<SchemaInfo>
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
    ask(sessionId: string, question: string, history?: AiTurn[]): Promise<AiResult>
  }
}
