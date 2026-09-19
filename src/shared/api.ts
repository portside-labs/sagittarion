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
  TableDetails
} from './types'

export interface ConnectOptions {
  /** Open the configured remote database after connecting (default true). */
  openDatabase?: boolean
  /** Correlates progress events with this connect call. */
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
  ssh: {
    connect(cfg: ConnectionConfig, opts?: ConnectOptions): Promise<SessionInfo>
    disconnect(sessionId: string): Promise<void>
    onClosed(cb: (e: SessionClosedEvent) => void): Unsubscribe
    onProgress(cb: (e: ConnectProgressEvent) => void): Unsubscribe
  }
  db: {
    open(sessionId: string, remotePath: string, readOnly: boolean): Promise<DatabaseInfo>
    schema(sessionId: string, includeSystem?: boolean): Promise<SchemaInfo>
    tableDetails(sessionId: string, table: string): Promise<TableDetails>
    rows(sessionId: string, req: RowsRequest): Promise<RowsResponse>
    count(sessionId: string, table: string, where?: string): Promise<number>
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
}
