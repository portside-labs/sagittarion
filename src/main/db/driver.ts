import type {
  Catalog,
  DatabaseInfo,
  DatabaseKind,
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

/** What every database backend must provide to the UI. */
export interface DatabaseDriver {
  readonly kind: DatabaseKind
  info(): DatabaseInfo | null
  /** Everything at once. Fine for SQLite files; on big Postgres databases prefer the catalog calls below. */
  schema(): Promise<SchemaInfo>
  /** Schema names and object counts: the first, cheap look at a database. */
  catalog(): Promise<Catalog>
  /** Names of objects of one family, paged with a keyset cursor. */
  listObjects(req: ListObjectsRequest): Promise<ObjectPage>
  /** Objects and columns whose names contain the query. */
  searchObjects(query: string, limit?: number): Promise<SearchResult>
  /** The DDL of one object, fetched on demand. */
  definition(ref: ObjectRef): Promise<ObjectDefinition>
  /** Column metadata for a batch of tables. */
  tablesMeta(refs: TableRef[]): Promise<TableMeta[]>
  /** Foreign keys that touch any of the given tables, on either side. */
  relationsFor(refs: TableRef[]): Promise<Relation[]>
  tableDetails(ref: TableRef): Promise<TableDetails>
  count(ref: TableRef, where?: string): Promise<number>
  rows(req: RowsRequest): Promise<RowsResponse>
  query(sql: string, params?: unknown[], maxRows?: number, options?: QueryOptions): Promise<QueryResponse>
  cancel(): Promise<void>
  apply(changes: PendingChange[]): Promise<number>
  close(): Promise<void>
}
