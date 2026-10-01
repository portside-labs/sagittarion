// The PATH a terminal would have. An app opened from the Dock or Finder gets a bare one (/usr/bin:/bin:…) without
// Homebrew, nvm, Volta or uv, so a connector's `npx` or `uvx` would not be found. It is read once from the user's
// login shell, and the usual places are added should that fail.
import { spawn } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'

const START = '__SAGITTARION_PATH_START__'
const END = '__SAGITTARION_PATH_END__'

function commonDirs(): string[] {
  const home = os.homedir()
  return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.cargo', 'bin'), path.join(home, '.volta', 'bin'), path.join(home, '.bun', 'bin')]
}

function merge(...lists: string[][]): string {
  const seen = new Set<string>()
  const out: string[] = []
  for (const list of lists) {
    for (const dir of list) {
      if (!dir || seen.has(dir)) continue
      seen.add(dir)
      out.push(dir)
    }
  }
  return out.join(path.delimiter)
}

/** The login shell's PATH, between markers so that whatever its rc files print is ignored. */
function readLoginPath(timeoutMs: number): Promise<string> {
  const shell = process.env['SHELL'] || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh')
  return new Promise((resolve, reject) => {
    const child = spawn(shell, ['-ilc', `printf '%s%s%s' '${START}' "$PATH" '${END}'`], { env: process.env, stdio: ['ignore', 'pipe', 'ignore'] })
    let out = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('The login shell did not answer in time.'))
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d))
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', () => {
      clearTimeout(timer)
      const at = out.lastIndexOf(START)
      const end = out.indexOf(END, at)
      if (at < 0 || end < 0) reject(new Error('The login shell printed no PATH.'))
      else resolve(out.slice(at + START.length, end))
    })
  })
}

let cached: Promise<string> | null = null

/** The PATH for local connectors: the login shell's, then this process's, then the usual tool directories. */
export function connectorPath(timeoutMs = 5000): Promise<string> {
  const own = (process.env['PATH'] ?? '').split(path.delimiter)
  if (process.platform === 'win32') return Promise.resolve(merge(own))
  cached ??= readLoginPath(timeoutMs)
    .then((login) => merge(login.split(path.delimiter), own, commonDirs()))
    .catch(() => merge(own, commonDirs()))
  return cached
}
