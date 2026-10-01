import type {
  AppInfo,
  Catalog,
  ChatHistoryItem,
  ConnectProgress,
  ConnectionConfig,
  DatabaseInfo,
  ExportRequest,
  GroupStyle,
  ListObjectsRequest,
  ObjectDefinition,
  ObjectPage,
  ObjectRef,
  PendingChange,
  QueryResponse,
  ReaddirResult,
  RowsRequest,
  RowsResponse,
  SavedChat,
  SearchResult,
  SessionInfo,
  SshProfile,
  TableDetails,
  TableRef,
  WorkspaceState
} from './types'
import type { AiConnectionInput, AiProgressEvent, AiResult, AiSettings, AiSettingsUpdate, AiStreamEvent, AiTurn, AskOptions } from './ai'
import type { ConnectorInfo, ConnectorInput, ToolApprovalDecision, ToolApprovalRequest, ToolPermission } from './connectors'
import type { Instruction, InstructionInput } from './instructions'
import type { AiTranscript, SemanticModelStatus } from './privacy'

export interface OpenOptions {
  /** Open the configured database after connecting (default true). SQLite only; Postgres always opens. */
  openDatabase?: boolean
  /** Correlates progress events with this call. */
  requestId?: string
}

/**
 * How an open session's link to its database fares. The link can drop by itself, as an idle connection closed by the
 * server or the network does; the session stays open, and the next call that needs the database reconnects it.
 */
export type SessionLinkEvent =
  | { sessionId: string; state: 'dropped'; reason: string }
  /** A call needs the database and the link is being made again; `message` is the latest step. */
  | { sessionId: string; state: 'reconnecting'; message: string }
  | { sessionId: string; state: 'reconnected'; info: SessionInfo }
  /** The link stays down, for the next call to try again. */
  | { sessionId: string; state: 'reconnect-failed'; reason: string }

export interface ConnectProgressEvent extends ConnectProgress {
  requestId?: string
}

export type Unsubscribe = () => void

export interface Api {
  app: {
    info(): Promise<AppInfo>
    openExternal(url: string): Promise<void>
    /** The window's own background, which shows while it is resized: the theme's. */
    setBackgroundColor(color: string): Promise<void>
  }
  connections: {
    list(): Promise<ConnectionConfig[]>
    save(cfg: ConnectionConfig): Promise<ConnectionConfig>
    remove(id: string): Promise<void>
    /** Puts the given connections in a group, or in none when null: how a group is renamed or dissolved. */
    setGroup(ids: string[], group: string | null): Promise<void>
    /** A copy of a saved connection, secrets included, under a new name. */
    duplicate(id: string): Promise<ConnectionConfig>
    /** Looks of the groups, keyed by group name. */
    groupStyles(): Promise<Record<string, GroupStyle>>
    /** Colours a group in the list; null clears it. */
    setGroupColor(name: string, color: string | null): Promise<void>
  }
  /** Saved SSH hosts, reusable by any connection. */
  sshProfiles: {
    list(): Promise<SshProfile[]>
    save(profile: SshProfile): Promise<SshProfile>
    remove(id: string): Promise<void>
  }
  session: {
    open(cfg: ConnectionConfig, opts?: OpenOptions): Promise<SessionInfo>
    close(sessionId: string): Promise<void>
    onLink(cb: (e: SessionLinkEvent) => void): Unsubscribe
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
    /** Native picker for a database file on this computer. */
    pickSqliteFile(current?: string): Promise<string | null>
  }
  exportData(req: ExportRequest): Promise<{ saved: boolean; path?: string }>
  /** The open connections and their tabs, kept between launches. */
  workspace: {
    load(): Promise<WorkspaceState | null>
    save(state: WorkspaceState): Promise<void>
    /** Blocks until written: for the moment the window closes, when nothing asynchronous is safe. */
    flush(state: WorkspaceState): void
  }
  settings: {
    get(): Promise<AiSettings>
    update(u: AiSettingsUpdate): Promise<AiSettings>
    /** Checks that a connection answers: the active one, or one as typed into Settings before saving. */
    testProvider(input?: AiConnectionInput): Promise<{ ok: boolean; message: string }>
    listModels(input?: AiConnectionInput): Promise<string[]>
  }
  ai: {
    /**
     * Turn a plain-English question into a verified read-only query for the open database. `conversationId` scopes
     * Local AI Privacy's placeholders to one chat, so the same person keeps the same placeholder in follow-ups.
     */
    ask(sessionId: string, question: string, history?: AiTurn[], requestId?: string, conversationId?: string, opts?: AskOptions): Promise<AiResult>
    /** Stop a running ask; the pending call resolves with kind "cancelled". */
    cancel(requestId: string): Promise<void>
    /** Drop a chat's placeholders from memory; with `transcripts`, what its answers sent too (the chat was reset). */
    forget(conversationId: string, opts?: { transcripts?: boolean }): Promise<void>
    /**
     * Exactly what an ask sent to the model provider and got back, for the "What was sent" view; null once it is no
     * longer held. With `values`, placeholders the policy restores are paired with their values, while the chat
     * still holds them.
     */
    transcript(requestId: string, opts?: { values?: boolean }): Promise<AiTranscript | null>
    /** Step-by-step progress of running asks, keyed by requestId. */
    onProgress(cb: (e: AiProgressEvent) => void): Unsubscribe
    /** The answer of a running ask as it is written, for providers that stream. */
    onStream(cb: (e: AiStreamEvent) => void): Unsubscribe
    /** Answers a connector tool call waiting for approval. */
    approve(approvalId: string, decision: ToolApprovalDecision): Promise<void>
    /** Connector tool calls that need the user's approval before they run. */
    onApproval(cb: (req: ToolApprovalRequest) => void): Unsubscribe
  }
  /** Closed conversations, kept to find and continue: the latest 30, none older than 30 days. */
  chats: {
    history(): Promise<ChatHistoryItem[]>
    /** A past conversation, taken out of the history to be a tab again. */
    take(id: string): Promise<SavedChat | null>
    archive(chat: SavedChat): Promise<void>
    forget(id: string): Promise<void>
  }
  /** What the user tells the model about their data: for every database connection, or for chosen ones. */
  instructions: {
    list(): Promise<Instruction[]>
    save(input: InstructionInput): Promise<Instruction>
    setEnabled(id: string, enabled: boolean): Promise<Instruction>
    remove(id: string): Promise<void>
  }
  /** MCP servers whose tools the chat can use, like Claude Desktop's connectors. */
  connectors: {
    list(): Promise<ConnectorInfo[]>
    /** Creates or updates one; a secret whose value is null keeps the one saved. Starts it to read its tools. */
    save(input: ConnectorInput): Promise<ConnectorInfo>
    /** Starts it if it is not running, so its tools can be shown. */
    start(id: string): Promise<void>
    /** Starts it afresh and reads its tools again. */
    refresh(id: string): Promise<ConnectorInfo>
    setEnabled(id: string, enabled: boolean): Promise<ConnectorInfo>
    setToolPermission(id: string, tool: string, permission: ToolPermission): Promise<ConnectorInfo>
    /**
     * Signs in to a remote connector with OAuth: its sign-in page opens in the browser, and this resolves once the
     * connector runs signed in (or the sign-in was cancelled).
     */
    signIn(id: string): Promise<ConnectorInfo>
    cancelSignIn(id: string): Promise<void>
    /** Forgets its tokens. */
    signOut(id: string): Promise<ConnectorInfo>
    remove(id: string): Promise<void>
    /** A connector started, stopped, failed, or listed new tools. */
    onStatus(cb: (info: ConnectorInfo) => void): Unsubscribe
  }
  /** The on-device model behind semantic detection: whether it can run here, its download, its removal. */
  privacyModel: {
    status(): Promise<SemanticModelStatus>
    /** Downloads and checks the model; resolves with the status it ends in (installed, cancelled or failed). */
    install(): Promise<SemanticModelStatus>
    cancel(): Promise<void>
    /** Deletes the model's files and switches semantic detection off. */
    remove(): Promise<SemanticModelStatus>
    /** Status changes, including download progress. */
    onStatus(cb: (s: SemanticModelStatus) => void): Unsubscribe
  }
}
