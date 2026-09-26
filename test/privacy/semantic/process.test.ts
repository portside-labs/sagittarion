// The model's own process: started on first use, one load shared by concurrent requests, answers routed back to
// whoever asked, and every waiting request failed when it cannot load, crashes, hangs or is unloaded. With the model
// files present (SAGITTARION_GLINER_DIR), the real process runs too: Node, onnxruntime-node, no Python.
import { fork } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { ModelUnavailableError, SemanticModelClient, type HostHandle } from '../../../src/main/privacy/semantic/client'
import type { HostReply, HostRequest } from '../../../src/main/privacy/semantic/host'
import { GLINER_PII_BASE as manifest } from '../../../src/main/privacy/semantic/manifest'

type Behaviour = (req: HostRequest, reply: (r: HostReply) => void, exit: () => void) => void

const answer: Behaviour = (req, reply) =>
  reply(req.type === 'load' ? { type: 'ready', ms: 5, rss: 100 } : { type: 'result', id: req.id, ms: 1, rss: 100, spans: req.texts.map((t) => [{ start: 0, end: t.length, label: 0, score: 0.9 }]) })

function harness(behaviour: Behaviour = answer, opts: Partial<ConstructorParameters<typeof SemanticModelClient>[0]> = {}) {
  const spawned: { posted: HostRequest[]; killed: boolean }[] = []
  let prepared = 0
  let unloaded = 0
  const client = new SemanticModelClient({
    prepare: async () => {
      prepared++
      return { dir: '/models/x', manifest }
    },
    spawn: (): HostHandle => {
      const h = { posted: [] as HostRequest[], killed: false }
      spawned.push(h)
      let onMessage: (r: HostReply) => void = () => {}
      let onExit: () => void = () => {}
      return {
        post: (req) => {
          h.posted.push(req)
          setTimeout(() => behaviour(req, (r) => onMessage(r), () => onExit()), 1)
        },
        onMessage: (f) => (onMessage = f),
        onExit: (f) => (onExit = f),
        kill: () => {
          h.killed = true
          setTimeout(() => onExit(), 1)
        }
      }
    },
    onUnload: () => unloaded++,
    ...opts
  })
  return { client, spawned, counts: () => ({ prepared, unloaded }) }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('the model process', () => {
  it('starts on first use, loads once for concurrent requests, and routes each answer back', async () => {
    const { client, spawned, counts } = harness()
    expect(client.running).toBe(false)
    const [a, b] = await Promise.all([client.recognize(['one']), client.recognize(['three', 'four'])])
    expect(a).toEqual([[{ start: 0, end: 3, label: 0, score: 0.9 }]])
    expect(b.map((s) => s[0].end)).toEqual([5, 4])
    expect(spawned).toHaveLength(1)
    expect(counts().prepared).toBe(1)
    expect(spawned[0].posted.map((p) => p.type)).toEqual(['load', 'recognize', 'recognize'])
    expect(await client.recognize([])).toEqual([])
  })

  it('fails the request when the model cannot load, and tries again next time', async () => {
    let fail = true
    const { client, spawned } = harness((req, reply) => (req.type === 'load' && fail ? reply({ type: 'error', message: 'Load model failed' }) : answer(req, reply, () => {})))
    await expect(client.recognize(['x'])).rejects.toThrow('The on-device model could not start: Load model failed')
    expect(spawned[0].killed).toBe(true)
    fail = false
    await expect(client.recognize(['x'])).resolves.toHaveLength(1)
    expect(spawned).toHaveLength(2)
  })

  it('fails every waiting request when the process dies, and starts a new one next time', async () => {
    const { client, spawned, counts } = harness((req, reply, exit) => (req.type === 'load' ? answer(req, reply, exit) : exit()))
    const results = await Promise.allSettled([client.recognize(['a']), client.recognize(['b'])])
    expect(results.map((r) => r.status === 'rejected' && (r.reason as Error).message)).toEqual(['The on-device model stopped unexpectedly.', 'The on-device model stopped unexpectedly.'])
    expect(results.every((r) => r.status === 'rejected' && r.reason instanceof ModelUnavailableError)).toBe(true)
    expect(counts().unloaded).toBe(1)
    await expect(client.recognize(['c'])).rejects.toThrow(/stopped unexpectedly/)
    expect(spawned).toHaveLength(2)
  })

  it('gives up on a model that stops answering', async () => {
    const { client, spawned } = harness((req, reply) => (req.type === 'load' ? answer(req, reply, () => {}) : undefined), { requestTimeoutMs: 30 })
    await expect(client.recognize(['a'])).rejects.toThrow('The on-device model stopped answering.')
    expect(spawned[0].killed).toBe(true)
    const slow = harness(() => {}, { loadTimeoutMs: 30 })
    await expect(slow.client.recognize(['a'])).rejects.toThrow('The on-device model took too long to load.')
  })

  it('never starts when the files fail their check', async () => {
    const { client, spawned } = harness(answer, {
      prepare: async () => {
        throw new Error('The on-device model file tokenizer.json does not match its pinned SHA-256.')
      }
    })
    await expect(client.recognize(['a'])).rejects.toThrow(/tokenizer.json does not match/)
    expect(spawned).toHaveLength(0)
  })

  it('ends after a quiet spell, and on request, giving its memory back', async () => {
    const { client, spawned, counts } = harness(answer, { idleMs: 40 })
    await client.recognize(['a'])
    expect(client.running).toBe(true)
    await sleep(100)
    expect(client.running).toBe(false)
    expect(spawned[0].killed).toBe(true)
    expect(counts().unloaded).toBe(1)
    await client.recognize(['b'])
    client.unload()
    expect(spawned[1].killed).toBe(true)
    expect(counts().unloaded).toBe(2)
  })

  it('lets a cancelled ask stop waiting without disturbing the others', async () => {
    const { client } = harness((req, reply, exit) => (req.type === 'load' ? answer(req, reply, exit) : setTimeout(() => answer(req, reply, exit), 30)))
    const controller = new AbortController()
    const cancelled = client.recognize(['a'], controller.signal)
    const other = client.recognize(['bb'])
    await sleep(10)
    controller.abort(new Error('cancelled'))
    await expect(cancelled).rejects.toThrow('cancelled')
    await expect(other).resolves.toEqual([[{ start: 0, end: 2, label: 0, score: 0.9 }]])
    await expect(client.recognize(['a'], AbortSignal.abort(new Error('already')))).rejects.toThrow('already')
  })

  const dir = process.env.SAGITTARION_GLINER_DIR
  it.runIf(Boolean(dir && existsSync(path.join(dir, manifest.graph))))('runs the real model in a child process: Node and onnxruntime-node only', async () => {
    const host = path.join(__dirname, '../../../src/main/privacy/semantic/host.ts')
    const children: ReturnType<typeof fork>[] = []
    const stats: { event: string; ms: number; rss: number }[] = []
    const client = new SemanticModelClient({
      prepare: async () => ({ dir: dir!, manifest }),
      spawn: () => {
        const child = fork(host, [], { execArgv: ['--import', 'tsx'], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
        children.push(child)
        return {
          post: (req) => child.send(req),
          onMessage: (f) => child.on('message', (m) => f(m as HostReply)),
          onExit: (f) => child.on('exit', () => f()),
          kill: () => child.kill()
        }
      },
      onStats: (s) => stats.push(s)
    })
    try {
      const [found] = await client.recognize(['Xiomara Quispe filed the complaint yesterday.'])
      expect(found.map((s) => [s.start, s.end, manifest.labels[s.label].label])).toEqual([[0, 14, 'name']])
      expect(stats[0]).toMatchObject({ event: 'ready' })
      // The process is Node running this repository's code; nothing else was started.
      expect(children).toHaveLength(1)
      expect(children[0].spawnfile).toBe(process.execPath)
      // Killing it fails the next request cleanly rather than hanging.
      children[0].kill('SIGKILL')
      await sleep(200)
      expect(client.running).toBe(false)
    } finally {
      client.unload()
    }
  })
})
