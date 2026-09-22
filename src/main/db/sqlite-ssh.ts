import type { DatabaseInfo, PendingChange, QueryResponse, RowsRequest, RowsResponse, SchemaInfo, TableDetails, TableRef } from '@shared/types'
import { formatBytes } from '@shared/export'
import { Session } from '../ssh/session'
import type { DatabaseDriver } from './driver'

/** SQLite file on a remote host, driven through the Python helper over SSH. */
export class SqliteSshDriver implements DatabaseDriver {
  readonly kind = 'sqlite' as const

  constructor(readonly session: Session) {}

  async open(remotePath: string, readOnly: boolean): Promise<DatabaseInfo> {
    await this.session.openDatabase(remotePath, readOnly)
    return this.info()!
  }

  info(): DatabaseInfo | null {
    const db = this.session.db
    if (!db) return null
    return {
      kind: 'sqlite',
      label: db.path,
      serverVersion: `SQLite ${db.sqliteVersion}`,
      readonly: db.readonly,
      path: db.path,
      home: db.home,
      hostname: db.hostname,
      fileSize: db.fileSize,
      details: [
        { label: 'helper', value: `${this.session.interpreter ?? 'python3'} ${db.pythonVersion}` },
        { label: 'size', value: formatBytes(db.fileSize) },
        { label: 'journal', value: db.journalMode }
      ]
    }
  }

  schema(): Promise<SchemaInfo> {
    return this.session.schema()
  }

  tableDetails(ref: TableRef): Promise<TableDetails> {
    return this.session.tableDetails(ref.name)
  }

  count(ref: TableRef, where?: string): Promise<number> {
    return this.session.count(ref.name, where)
  }

  rows(req: RowsRequest): Promise<RowsResponse> {
    return this.session.rows(req)
  }

  query(sql: string, params: unknown[] = [], maxRows = 1000): Promise<QueryResponse> {
    return this.session.query(sql, params, maxRows)
  }

  async cancel(): Promise<void> {
    this.session.cancel()
  }

  apply(changes: PendingChange[]): Promise<number> {
    return this.session.apply(changes)
  }

  async close(): Promise<void> {
    this.session.close()
  }
}
