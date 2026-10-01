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
