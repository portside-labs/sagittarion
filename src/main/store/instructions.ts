import { promises as fs } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { MAX_INSTRUCTION_CHARS, type Instruction, type InstructionInput } from '@shared/instructions'

function migrate(raw: any): Instruction | null {
  if (!raw || typeof raw.id !== 'string' || typeof raw.text !== 'string') return null
  const now = Date.now()
  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : '',
    text: raw.text,
    enabled: raw.enabled !== false,
    scope: raw.scope === 'selected' ? 'selected' : 'all',
    connectionIds: Array.isArray(raw.connectionIds) ? raw.connectionIds.filter((x: unknown): x is string => typeof x === 'string') : [],
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : now,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : now
  }
}

/** The user's instructions to the model, in instructions.json. */
export class InstructionStore {
  private cache: Instruction[] | null = null

  constructor(private readonly file: string) {}

  private async load(): Promise<Instruction[]> {
    if (this.cache) return this.cache
    try {
      const parsed = JSON.parse(await fs.readFile(this.file, 'utf8'))
      this.cache = (Array.isArray(parsed?.instructions) ? parsed.instructions : []).map(migrate).filter((i: Instruction | null): i is Instruction => i !== null)
    } catch {
      this.cache = []
    }
    return this.cache!
  }

  private async persist(list: Instruction[]): Promise<void> {
    this.cache = list
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = this.file + '.tmp'
    await fs.writeFile(tmp, JSON.stringify({ version: 1, instructions: list }, null, 2), { encoding: 'utf8', mode: 0o600 })
    await fs.rename(tmp, this.file)
  }

  async list(): Promise<Instruction[]> {
    return (await this.load()).map((i) => ({ ...i, connectionIds: [...i.connectionIds] })).sort((a, b) => a.createdAt - b.createdAt)
  }

  async save(input: InstructionInput): Promise<Instruction> {
    const text = typeof input.text === 'string' ? input.text.trim() : ''
    if (!text) throw new Error('Write the instruction first.')
    if (text.length > MAX_INSTRUCTION_CHARS) {
      throw new Error(`Keep an instruction under ${MAX_INSTRUCTION_CHARS.toLocaleString('en-US')} characters: it is sent with every question.`)
    }
    const list = await this.load()
    const id = input.id || randomUUID()
    const existing = list.find((i) => i.id === id)
    const now = Date.now()
    const saved: Instruction = {
      id,
      name: (typeof input.name === 'string' ? input.name.trim() : '') || text.split('\n')[0].slice(0, 60),
      text,
      enabled: input.enabled !== false,
      scope: input.scope === 'selected' ? 'selected' : 'all',
      connectionIds: Array.isArray(input.connectionIds) ? [...new Set(input.connectionIds.filter((x) => typeof x === 'string'))] : [],
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }
    await this.persist(existing ? list.map((i) => (i.id === id ? saved : i)) : [...list, saved])
    return { ...saved }
  }

  async setEnabled(id: string, enabled: boolean): Promise<Instruction> {
    const list = await this.load()
    const found = list.find((i) => i.id === id)
    if (!found) throw new Error('That instruction no longer exists.')
    const next = { ...found, enabled, updatedAt: Date.now() }
    await this.persist(list.map((i) => (i.id === id ? next : i)))
    return { ...next }
  }

  async remove(id: string): Promise<void> {
    await this.persist((await this.load()).filter((i) => i.id !== id))
  }

  /** A database connection was deleted: instructions for it forget it. */
  async forgetConnection(connectionId: string): Promise<void> {
    const list = await this.load()
    if (!list.some((i) => i.connectionIds.includes(connectionId))) return
    await this.persist(list.map((i) => ({ ...i, connectionIds: i.connectionIds.filter((x) => x !== connectionId) })))
  }
}
