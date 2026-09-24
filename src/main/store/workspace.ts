import { promises as fs, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { WorkspaceState } from '@shared/types'

/** The open connections and their tabs, so a launch picks up where the last one stopped. */
export class WorkspaceStore {
  constructor(private readonly file: string) {}

  async load(): Promise<WorkspaceState | null> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.file, 'utf8'))
      return isWorkspace(parsed) ? parsed : null
    } catch {
      return null
    }
  }

  async save(state: WorkspaceState): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await fs.writeFile(tmp, JSON.stringify(state), 'utf8')
    await fs.rename(tmp, this.file)
  }

  /** Blocking write for the moment the window is closing, when a pending promise might never settle. */
  saveSync(state: WorkspaceState): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(state), 'utf8')
    renameSync(tmp, this.file)
  }
}

function isWorkspace(x: unknown): x is WorkspaceState {
  return typeof x === 'object' && x !== null && (x as WorkspaceState).version === 1 && Array.isArray((x as WorkspaceState).connections)
}
