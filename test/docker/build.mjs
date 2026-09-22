// Builds the Docker images used by test/docker.test.ts. Run directly or let the
// test call it. The build context (.context/) holds a fixture database and a
// throwaway ed25519 key pair; both are gitignored.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const context = path.join(here, '.context')
export const keyPath = path.join(context, 'id_ed25519')
export const IMAGES = {
  alpine: 'sagittarion-test-alpine',
  bare: 'sagittarion-test-alpine-bare'
}
/** Any Alpine-flavoured base image; override when the default cannot be pulled. */
export const BASE = process.env.DOCKER_BASE || 'alpine:3.20'

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with ${r.status}`)
}

export function prepareContext() {
  fs.mkdirSync(context, { recursive: true })
  const fixture = path.join(here, '..', 'fixtures', 'sample.db')
  if (!fs.existsSync(fixture)) run('python3', [path.join(here, '..', 'fixtures', 'make-sample-db.py'), fixture])
  fs.copyFileSync(fixture, path.join(context, 'sample.db'))
  if (!fs.existsSync(keyPath)) run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', keyPath])
  fs.copyFileSync(keyPath + '.pub', path.join(context, 'authorized_keys'))
}

export function imageExists(tag) {
  return spawnSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' }).status === 0
}

export function buildImages({ force = false, base = BASE } = {}) {
  prepareContext()
  for (const [name, tag] of Object.entries(IMAGES)) {
    if (!force && imageExists(tag)) continue
    const file = path.join(here, `${name === 'bare' ? 'alpine-bare' : name}.Dockerfile`)
    console.log(`building ${tag} from ${base}`)
    run('docker', ['build', '-q', '--build-arg', `BASE=${base}`, '-t', tag, '-f', file, context])
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const baseIdx = process.argv.indexOf('--base')
  buildImages({ force: process.argv.includes('--force'), base: baseIdx >= 0 ? process.argv[baseIdx + 1] : BASE })
  console.log('images ready')
}
