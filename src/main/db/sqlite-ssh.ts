import type {
  Catalog,
  DatabaseInfo,
  ListObjectsRequest,
  ObjectDefinition,
  ObjectPage,
  ObjectRef,
  PendingChange,
  QueryOptions,
  QueryResponse,
  Relation,
  RowsRequest,
  RowsResponse,
  SchemaInfo,
  SearchResult,
  TableDetails,
  TableMeta,
  TableRef
} from '@shared/types'
import { formatBytes } from '@shared/export'
import { Session } from '../ssh/session'
import type { DatabaseDriver } from './driver'
import { catalogFromSchema, definitionFromSchema, objectsFromSchema, relationsFromSchema, searchSchema, tablesFromSchema } from './catalog'

/** SQLite file on a remote host, driven through the Python helper over SSH. */
export class SqliteSshDriver implements DatabaseDriver {
  readonly kind = 'sqlite' as const
  /** SQLite files are small enough to load whole; the lazy calls are answered from this. */
  private cached: Promise<SchemaInfo> | null = null

  constructor(readonly session: Session) {}

  async open(remotePath: string, readOnly: boolean): Promise<DatabaseInfo> {
    this.cached = null
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

  /** Always fresh; also refreshes what the lazy calls answer from. */
  schema(): Promise<SchemaInfo> {
    const p = this.session.schema()
    this.cached = p.catch((err) => {
      this.cached = null
      throw err
    })
    return p
  }

  private snapshot(): Promise<SchemaInfo> {
    return this.cached ?? this.schema()
  }

  async catalog(): Promise<Catalog> {
    return catalogFromSchema(await this.schema())
  }

  async listObjects(req: ListObjectsRequest): Promise<ObjectPage> {
    return objectsFromSchema(await this.snapshot(), req)
  }

  async searchObjects(query: string, limit = 100): Promise<SearchResult> {
    return searchSchema(await this.snapshot(), query, limit)
  }

  async definition(ref: ObjectRef): Promise<ObjectDefinition> {
    return definitionFromSchema(await this.snapshot(), ref)
  }

  async tablesMeta(refs: TableRef[]): Promise<TableMeta[]> {
    return tablesFromSchema(await this.snapshot(), refs)
  }

  async relationsFor(refs: TableRef[]): Promise<Relation[]> {
    return relationsFromSchema(await this.snapshot(), refs)
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

  query(sql: string, params: unknown[] = [], maxRows = 1000, options?: QueryOptions): Promise<QueryResponse> {
    return this.session.query(sql, params, maxRows, options)
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
