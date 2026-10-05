// How data moves, read from the database's own definitions: the triggers on a table (and, in PostgreSQL, the functions
// they run) and what they write; the views and the tables they read. A few tables at a time, after an ask has used
// them, so no ask waits for it; each is read again after a week.
import type { DataLink } from '@shared/knowledge'
import type { ObjectRef, TableRef } from '@shared/types'
import type { SchemaIndex } from '../ai/schema-index'
import { definitionFacts, type TableUse } from './sql-facts'

export interface DefinitionReader {
  /** The triggers on a table, with their SQL. */
  triggers(ref: TableRef): Promise<{ name: string; sql: string | null }[]>
  /** An object's DDL, or null. */
  definition(ref: ObjectRef): Promise<string | null>
}

export type FlowLink = Pick<DataLink, 'from' | 'to' | 'kind' | 'via'>

const RESCAN_MS = 7 * 86_400_000

/** The tables to read next: those not read in the last week, up to `budget`. */
export function toScan(keys: string[], scanned: Record<string, number>, budget: number, now = Date.now()): string[] {
  return [...new Set(keys)].filter((k) => !(scanned[k] && now - scanned[k] < RESCAN_MS)).slice(0, budget)
}

/** Reads how data moves around these tables. Problems reading one are skipped: this is best effort. */
export async function scanFlow(index: SchemaIndex, reader: DefinitionReader, keys: string[]): Promise<{ links: FlowLink[]; scanned: string[] }> {
  const links: FlowLink[] = []
  const scanned: string[] = []
  const keyOf = (u: TableUse) => index.find(u.name, u.schema)?.key
  const add = (from: string | undefined, to: string | undefined, kind: FlowLink['kind'], via: string) => {
    if (from && to && from !== to && !links.some((l) => l.from === from && l.to === to && l.via === via)) links.push({ from, to, kind, via })
  }
  for (const key of keys) {
    const t = index.tables.get(key)
    if (!t) continue
    try {
      if (t.type === 'view') {
        const sql = await reader.definition({ kind: 'view', schema: t.ref.schema, name: t.ref.name })
        if (sql) for (const r of definitionFacts(sql).reads) add(keyOf(r), key, 'feeds', `view ${t.ref.name}`)
      } else {
        for (const trigger of await reader.triggers(t.ref)) {
          if (!trigger.sql) continue
          const facts = definitionFacts(trigger.sql)
          for (const w of facts.writes) add(key, keyOf(w), 'writes', `trigger ${trigger.name}`)
          // PostgreSQL: the trigger runs a function, which does the writing.
          for (const call of facts.calls.slice(0, 2)) {
            const dot = call.lastIndexOf('.')
            const body = await reader.definition({ kind: 'function', schema: dot > 0 ? call.slice(0, dot) : t.ref.schema, name: dot > 0 ? call.slice(dot + 1) : call })
            if (!body) continue
            const fn = definitionFacts(body)
            const via = `trigger ${trigger.name} (function ${call})`
            for (const w of fn.writes) {
              add(key, keyOf(w), 'writes', via)
              for (const r of fn.reads) add(keyOf(r), keyOf(w), 'feeds', `function ${call}`)
            }
          }
        }
      }
      scanned.push(key)
    } catch {
      /* best effort: tried again another time */
    }
  }
  return { links, scanned }
}
