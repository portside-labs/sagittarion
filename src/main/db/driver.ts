import type {
  DatabaseInfo,
  DatabaseKind,
  PendingChange,
  QueryOptions,
  QueryResponse,
  RowsRequest,
  RowsResponse,
  SchemaInfo,
  TableDetails,
  TableRef
} from '@shared/types'

/** What every database backend must provide to the UI. */
export interface DatabaseDriver {
  readonly kind: DatabaseKind
  info(): DatabaseInfo | null
  schema(): Promise<SchemaInfo>
  tableDetails(ref: TableRef): Promise<TableDetails>
  count(ref: TableRef, where?: string): Promise<number>
  rows(req: RowsRequest): Promise<RowsResponse>
  query(sql: string, params?: unknown[], maxRows?: number, options?: QueryOptions): Promise<QueryResponse>
  cancel(): Promise<void>
  apply(changes: PendingChange[]): Promise<number>
  close(): Promise<void>
}
