// Instructions: what the user tells the model about their data, such as what "revenue" means or which tables to
// prefer. Each is sent with every question on every database connection (a global one), or only on the ones chosen.

export type InstructionScope = 'all' | 'selected'

export interface Instruction {
  id: string
  name: string
  /** Plain text or markdown, as the user wrote it. */
  text: string
  enabled: boolean
  scope: InstructionScope
  /** The saved database connections it applies to, when scope is "selected". */
  connectionIds: string[]
  createdAt: number
  updatedAt: number
}

export type InstructionInput = Pick<Instruction, 'id' | 'name' | 'text' | 'enabled' | 'scope' | 'connectionIds'>

/** Enough for a page of definitions; instructions ride along with every request, so they are kept short. */
export const MAX_INSTRUCTION_CHARS = 8000

export function emptyInstruction(): InstructionInput {
  return { id: '', name: '', text: '', enabled: true, scope: 'all', connectionIds: [] }
}

export function instructionApplies(i: Pick<Instruction, 'enabled' | 'text' | 'scope' | 'connectionIds'>, connectionId: string | undefined): boolean {
  if (!i.enabled || !i.text.trim()) return false
  return i.scope === 'all' || (Boolean(connectionId) && i.connectionIds.includes(connectionId!))
}

/** The instructions for a database connection: the global ones first, then its own, each in the order made. */
export function instructionsFor(list: Instruction[], connectionId: string | undefined): Instruction[] {
  return list
    .filter((i) => instructionApplies(i, connectionId))
    .sort((a, b) => (a.scope === b.scope ? a.createdAt - b.createdAt : a.scope === 'all' ? -1 : 1))
}

/**
 * The instructions for a chat across several databases: the global ones, then each one written for some of them, once,
 * with the keys of those it is for.
 */
export function instructionsAcross(list: Instruction[], dbs: { key: string; connectionId?: string }[]): { name: string; text: string; databases?: string[] }[] {
  const out: { name: string; text: string; databases?: string[] }[] = instructionsFor(list, undefined).map((i) => ({ name: i.name, text: i.text }))
  const own = new Map<string, { instruction: Instruction; keys: string[] }>()
  for (const db of dbs) {
    for (const i of instructionsFor(list, db.connectionId)) {
      if (i.scope === 'all') continue
      const entry = own.get(i.id) ?? { instruction: i, keys: [] }
      entry.keys.push(db.key)
      own.set(i.id, entry)
    }
  }
  const ordered = [...own.values()].sort((a, b) => a.instruction.createdAt - b.instruction.createdAt)
  for (const { instruction, keys } of ordered) out.push({ name: instruction.name, text: instruction.text, databases: keys })
  return out
}
