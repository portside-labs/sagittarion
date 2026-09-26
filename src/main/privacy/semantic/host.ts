// The on-device model's own process: an Electron utility process (plain Node, no window, no Python) that loads the
// ONNX graph with onnxruntime-node and answers recognition requests one at a time. The main process starts it when a
// check needs the model and ends it when the model has sat idle; a crash or a hung inference here cannot take the
// app down, and the asks that were waiting fail closed. Tests run the same file under Node's child_process.fork.
import type { SemanticModelManifest } from './manifest'
import { GlinerRuntime, type RawSpan } from './runtime'

export type HostRequest = { type: 'load'; dir: string; manifest: SemanticModelManifest } | { type: 'recognize'; id: number; texts: string[] }

export type HostReply =
  | { type: 'ready'; ms: number; rss: number }
  | { type: 'result'; id: number; spans: RawSpan[][]; ms: number; rss: number }
  | { type: 'error'; id?: number; message: string }

interface Port {
  post(reply: HostReply): void
  listen(handler: (request: HostRequest) => void): void
}

function connect(): Port {
  const parent = process.parentPort
  if (parent) return { post: (r) => parent.postMessage(r), listen: (h) => parent.on('message', (e) => h(e.data as HostRequest)) }
  const send = process.send?.bind(process)
  if (send) return { post: (r) => send(r), listen: (h) => process.on('message', (m) => h(m as HostRequest)) }
  throw new Error('The model process was started without a channel to the app.')
}

const port = connect()
let runtime: GlinerRuntime | null = null
let queue: Promise<void> = Promise.resolve()

async function handle(request: HostRequest): Promise<void> {
  const started = performance.now()
  try {
    if (request.type === 'load') {
      await runtime?.release()
      runtime = await GlinerRuntime.load(request.dir, request.manifest)
      port.post({ type: 'ready', ms: Math.round(performance.now() - started), rss: process.memoryUsage().rss })
    } else {
      if (!runtime) throw new Error('The model is not loaded.')
      const spans = await runtime.recognize(request.texts)
      port.post({ type: 'result', id: request.id, spans, ms: Math.round(performance.now() - started), rss: process.memoryUsage().rss })
    }
  } catch (err) {
    // Messages from ONNX Runtime and this code describe the failure, never the text being read.
    port.post({ type: 'error', ...(request.type === 'recognize' ? { id: request.id } : {}), message: err instanceof Error ? err.message : String(err) })
  }
}

// One request at a time, in the order they came.
port.listen((request) => {
  queue = queue.then(() => handle(request))
})
