// Everything a SQLite session does through sqlite_agent.py, whether the
// helper runs on this computer or on an SSH host.
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import type { ConnectProgress, PendingChange, QueryOptions, QueryResponse, ReaddirResult, RowsRequest, RowsResponse, SchemaInfo, TableDetails } from '@shared/types'
import { AgentError, type PythonAgent } from './agent'

/** What sqlite_agent.py reports after opening a file. */
export interface SqliteOpenInfo {
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

export abstract class AgentSession extends EventEmitter {
  readonly id = randomBytes(8).toString('hex')
  protected agent: PythonAgent | null = null
  protected onProgress: ((p: ConnectProgress) => void) | undefined
  interpreter: string | null = null
  homeDir: string | null = null
  db: SqliteOpenInfo | null = null
  closed = false

  /** Where the helper runs, for messages: "this computer" or a host name. */
  abstract readonly where: string
  abstract connect(): Promise<void>
  /** Start the helper and wait until it is listening. */
  protected abstract spawnAgent(): Promise<PythonAgent>
  abstract readdir(dir: string): Promise<ReaddirResult>
  abstract home(): Promise<string>
  abstract close(): void

  protected progress(stage: ConnectProgress['stage'], message: string): void {
    this.onProgress?.({ stage, message })
  }

  async startAgent(): Promise<PythonAgent> {
    if (this.agent && !this.agent.hasExited) return this.agent
    const agent = await this.spawnAgent()
    agent.on('exit', (info) => {
      if (this.agent === agent) {
        this.agent = null
        this.db = null
        this.emit('agent-exit', info)
      }
    })
    this.agent = agent
    return agent
  }

  protected requireAgent(): PythonAgent {
    if (!this.agent || this.agent.hasExited) {
      throw new AgentError('Not connected to a database. Reconnect to continue.')
    }
    return this.agent
  }

  // ---------------------------------------------------------------------
  // Database operations
  // ---------------------------------------------------------------------

  async openDatabase(remotePath: string, readonly = false, create = false): Promise<SqliteOpenInfo> {
    const agent = await this.startAgent()
    this.progress('opening', `Opening ${remotePath}…`)
    const res = await agent.request<SqliteOpenInfo & { id: number; ok: true }>('open', {
      path: remotePath,
      readonly,
      create
    })
    const { id: _id, ok: _ok, ...info } = res as any
    this.db = info as SqliteOpenInfo
    this.homeDir = this.db.home
    return this.db
  }

  async schema(includeSystem = false): Promise<SchemaInfo> {
    const res = await this.requireAgent().request('schema', { include_system: includeSystem })
    return { kind: 'sqlite', tables: res.tables, views: res.views, indexes: res.indexes, triggers: res.triggers, relations: res.relations ?? [] }
  }

  async tableDetails(table: string): Promise<TableDetails> {
    const { id: _id, ok: _ok, durationMs: _d, tx: _tx, ...rest } = await this.requireAgent().request('table_details', { table })
    return rest as TableDetails
  }

  async count(table: string, where?: string): Promise<number> {
    const res = await this.requireAgent().request('count', { table, where })
    return res.total
  }

  async rows(req: RowsRequest): Promise<RowsResponse> {
    const res = await this.requireAgent().request('rows', {
      table: req.table,
      offset: req.offset,
      limit: req.limit,
      order_by: req.orderBy,
      order_dir: req.orderDir,
      where: req.where,
      with_count: req.withCount ?? false
    })
    return {
      table: res.table,
      columns: res.columns,
      rows: res.rows,
      rowids: res.rowids,
      rowidAlias: res.rowidAlias,
      pk: res.pk,
      isView: res.isView,
      total: res.total,
      sql: res.sql,
      durationMs: res.durationMs,
      tx: res.tx
    }
  }

  async query(sql: string, params: unknown[] = [], maxRows = 1000, options?: QueryOptions): Promise<QueryResponse> {
    const res = await this.requireAgent().request('query', { sql, params, max_rows: maxRows, read_only: Boolean(options?.readOnly) })
    return { results: res.results, durationMs: res.durationMs, tx: res.tx }
  }

  cancel(): void {
    this.agent?.cancel()
  }

  async apply(changes: PendingChange[]): Promise<number> {
    const res = await this.requireAgent().request('apply', { changes })
    return res.applied
  }

  async ping(): Promise<boolean> {
    if (!this.agent || this.agent.hasExited) return false
    try {
      await this.agent.request('ping')
      return true
    } catch {
      return false
    }
  }
}
