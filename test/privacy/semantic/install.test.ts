// Getting the model onto this computer: every file checked against the manifest as it arrives, nothing kept from a
// failed or cancelled download, altered files caught before they run, and Settings told what is going on.
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { SemanticModelStatus } from '../../../src/shared/privacy'
import type { HostHandle } from '../../../src/main/privacy/semantic/client'
import type { HostReply, HostRequest } from '../../../src/main/privacy/semantic/host'
import { SemanticModel } from '../../../src/main/privacy/semantic/manager'
import { GLINER_PII_BASE, type SemanticModelManifest } from '../../../src/main/privacy/semantic/manifest'
import { ModelIntegrityError, ModelStore } from '../../../src/main/privacy/semantic/store'

const files: Record<string, Buffer> = { 'config.json': Buffer.from('{"span_mode":"markerV0"}'), 'onnx/graph.onnx': randomBytes(300_000) }
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')
const manifest: SemanticModelManifest = {
  ...GLINER_PII_BASE,
  id: 'test-model',
  version: '9',
  graph: 'onnx/graph.onnx',
  config: 'config.json',
  files: Object.entries(files).map(([p, b]) => ({ path: p, size: b.length, sha256: sha(b) }))
}

/** What the server does with a file: serve it, or misbehave. */
let mode: 'ok' | 'altered' | 'longer' | 'missing' | 'slow' | 'wrong-length' = 'ok'
let server: http.Server
let base = ''

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const file = files[decodeURIComponent((req.url ?? '/').slice(1))]
    if (!file || (mode === 'missing' && req.url?.includes('graph'))) {
      res.writeHead(404).end()
      return
    }
    let body = file
    if (req.url?.includes('graph') && mode === 'altered') body = Buffer.from(file.map((x, i) => (i === 1000 ? x ^ 1 : x)))
    if (req.url?.includes('graph') && mode === 'longer') body = Buffer.concat([file, Buffer.from('extra')])
    if (mode === 'wrong-length' && req.url?.includes('graph')) {
      res.writeHead(200, { 'content-length': String(file.length + 1) })
      res.end(Buffer.concat([file, Buffer.from('x')]))
      return
    }
    if (mode === 'slow' && req.url?.includes('graph')) {
      res.writeHead(200, { 'content-length': String(body.length) })
      res.write(body.subarray(0, 1000))
      return // never finishes
    }
    res.writeHead(200, { 'content-length': String(body.length) }).end(body)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(() => {
  server.closeAllConnections()
  server.close()
})

const roots: string[] = []
afterEach(() => {
  mode = 'ok'
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function store() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'models-'))
  roots.push(root)
  return new ModelStore({ root, manifest, fetch: globalThis.fetch, urlFor: (f) => `${base}/${f.path}` })
}

/** Nothing but the final directory, when there is one: no staging folders left over. */
const leftovers = (s: ModelStore) => readdirSync(path.dirname(s.dir)).filter((n) => n !== path.basename(s.dir))

describe('model files', () => {
  it('downloads, checks and installs every file, reporting progress to the end', async () => {
    const s = store()
    const progress: number[] = []
    expect(await s.installed()).toBe(false)
    await s.install((received) => progress.push(received))
    expect(await s.installed()).toBe(true)
    await s.verify()
    expect(progress.at(-1)).toBe(s.size)
    expect(progress.every((v, i) => i === 0 || v >= progress[i - 1])).toBe(true)
    expect(leftovers(s)).toEqual([])
  })

  it('keeps nothing when a file does not match its digest or size, or is missing', async () => {
    for (const [m, problem] of [
      ['altered', 'digest'],
      ['longer', 'size'],
      ['wrong-length', 'size'],
      ['missing', 'download']
    ] as const) {
      mode = m
      const s = store()
      const err = await s.install(() => {}).catch((e: unknown) => e)
      expect(err, m).toBeInstanceOf(ModelIntegrityError)
      expect((err as ModelIntegrityError).problem, m).toBe(problem)
      expect(existsSync(s.dir), m).toBe(false)
      expect(leftovers(s), m).toEqual([])
    }
  })

  it('keeps nothing from a cancelled download', async () => {
    mode = 'slow'
    const s = store()
    const controller = new AbortController()
    const pending = s.install((received) => {
      if (received > 0 && received < s.size) controller.abort()
    }, controller.signal)
    await expect(pending).rejects.toThrow()
    expect(existsSync(s.dir)).toBe(false)
    expect(leftovers(s)).toEqual([])
  })

  it('catches a file altered after installation, and removes everything', async () => {
    const s = store()
    await s.install(() => {})
    writeFileSync(path.join(s.dir, 'onnx/graph.onnx'), Buffer.alloc(files['onnx/graph.onnx'].length))
    await expect(s.verify()).rejects.toMatchObject({ problem: 'digest', file: 'onnx/graph.onnx' })
    // Sizes still match, so it still counts as installed; the check before loading is what stops it.
    expect(await s.installed()).toBe(true)
    // A download interrupted by quitting leaves a staging folder; removal clears it too.
    writeFileSync(path.join(path.dirname(s.dir), `.${manifest.version}.download-abc`), '')
    await s.remove()
    expect(await s.installed()).toBe(false)
    expect(readdirSync(path.dirname(s.dir))).toEqual([])
  })
})

/** A model process that answers every request with one span, and can be told to fail. */
function fakeHosts() {
  const hosts: { handle: HostHandle; posted: HostRequest[]; killed: boolean }[] = []
  const spawn = (): HostHandle => {
    let onMessage: (r: HostReply) => void = () => {}
    let onExit: () => void = () => {}
    const h = {
      posted: [] as HostRequest[],
      killed: false,
      handle: {
        post: (req: HostRequest) => {
          h.posted.push(req)
          queueMicrotask(() => onMessage(req.type === 'load' ? { type: 'ready', ms: 1, rss: 1 } : { type: 'result', id: req.id, ms: 1, rss: 1, spans: req.texts.map((t) => [{ start: 0, end: t.length, label: 0, score: 0.9 }]) }))
        },
        onMessage: (f: (r: HostReply) => void) => (onMessage = f),
        onExit: (f: () => void) => (onExit = f),
        kill: () => {
          h.killed = true
          queueMicrotask(() => onExit())
        }
      }
    }
    hosts.push(h)
    return h.handle
  }
  return { hosts, spawn }
}

describe('the model in Settings', () => {
  function model(opts: { unsupported?: string } = {}) {
    const s = store()
    const statuses: SemanticModelStatus[] = []
    const { hosts, spawn } = fakeHosts()
    const m = new SemanticModel({ store: s, spawn, unsupported: opts.unsupported ?? null, onStatus: (x) => statuses.push(x) })
    return { m, s, statuses, hosts }
  }

  it('says why it cannot run here, and never offers a detector', async () => {
    const { m, statuses } = model({ unsupported: 'The on-device model needs 64-bit Windows.' })
    expect(await m.status()).toMatchObject({ state: 'unsupported', message: 'The on-device model needs 64-bit Windows.', model: { id: 'test-model', size: m.info.size } })
    expect(await m.install()).toMatchObject({ state: 'unsupported' })
    expect(await m.detector()).toBeNull()
    expect(statuses).toEqual([])
  })

  it('goes from not installed through downloading to installed, and back when removed', async () => {
    const { m, statuses, hosts } = model()
    expect(await m.status()).toMatchObject({ state: 'not-installed', model: { source: 'huggingface.co/knowledgator/gliner-pii-base-v1.0', license: 'Apache-2.0' } })
    expect(await m.detector()).toBeNull()
    expect(await m.install()).toMatchObject({ state: 'installed' })
    expect(statuses[0]).toMatchObject({ state: 'downloading', received: 0 })
    expect(statuses.at(-1)).toMatchObject({ state: 'installed' })
    const detector = await m.detector()
    expect(detector).not.toBeNull()
    // The first check starts the model's process, which is given the checked directory and manifest.
    const [found] = await detector!.detect(['Ana Lima'])
    expect(found).toMatchObject([{ value: 'Ana Lima', type: 'PERSON_NAME' }])
    expect(hosts).toHaveLength(1)
    expect(hosts[0].posted[0]).toMatchObject({ type: 'load', manifest: { id: 'test-model' } })
    expect(await m.remove()).toMatchObject({ state: 'not-installed' })
    expect(hosts[0].killed).toBe(true)
    expect(await m.detector()).toBeNull()
  })

  it('reports a failed download, and a model whose files were altered', async () => {
    const { m, s, statuses, hosts } = model()
    mode = 'altered'
    expect(await m.install()).toMatchObject({ state: 'failed', message: 'The on-device model file onnx/graph.onnx does not match its pinned SHA-256.' })
    mode = 'ok'
    expect(await m.install()).toMatchObject({ state: 'installed' })
    writeFileSync(path.join(s.dir, 'config.json'), '{"span_mode":"markerV1"}')
    const detector = await m.detector()
    await expect(detector!.detect(['Ana'])).rejects.toThrow(/config.json does not match/)
    // The process was never started on altered files, and Settings shows why.
    expect(hosts).toHaveLength(0)
    expect(statuses.at(-1)).toMatchObject({ state: 'failed', message: 'The on-device model file config.json does not match its pinned SHA-256. Download it again.' })
  })

  it('cancels a download, leaving it not installed', async () => {
    const { m, s } = model()
    mode = 'slow'
    const pending = m.install()
    await new Promise((r) => setTimeout(r, 100))
    m.cancel()
    expect(await pending).toMatchObject({ state: 'not-installed' })
    expect(await s.installed()).toBe(false)
  })
})
