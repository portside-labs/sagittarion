// The model itself: the ONNX graph under ONNX Runtime's CPU provider, with the tokenizer and GLiNER's processing
// around it. Runs in the model's own process (host.ts); tests load it directly. Nothing here reaches the network.
import { readFile } from 'node:fs/promises'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import * as ort from 'onnxruntime-node'
import { buildBatch, decodeSpans, encodeWords, promptIds, splitWords, windows, type Encoded, type SpanModelSpec } from './gliner'
import type { SemanticModelManifest } from './manifest'
import { UnigramTokenizer } from './tokenizer'

/** A span in a text, by UTF-16 offsets, with the index of its label in the manifest. */
export interface RawSpan {
  start: number
  end: number
  label: number
  score: number
}

const INPUTS = ['input_ids', 'attention_mask', 'words_mask', 'text_lengths', 'span_idx', 'span_mask']

export class GlinerRuntime {
  private readonly prompt: number[]

  private constructor(
    private readonly session: ort.InferenceSession,
    private readonly tok: UnigramTokenizer,
    private readonly manifest: SemanticModelManifest,
    private readonly spec: SpanModelSpec
  ) {
    this.prompt = promptIds(tok, manifest.labels.map((l) => l.label), spec)
  }

  /** Loads a model directory the caller has already verified against the manifest. */
  static async load(dir: string, manifest: SemanticModelManifest, opts: { threads?: number } = {}): Promise<GlinerRuntime> {
    const config = JSON.parse(await readFile(path.join(dir, manifest.config), 'utf8')) as Record<string, unknown>
    const mismatch = (
      [
        ['span_mode', manifest.spanMode],
        ['max_width', manifest.maxWidth],
        ['ent_token', manifest.entToken],
        ['sep_token', manifest.sepToken],
        ['words_splitter_type', 'whitespace'],
        ['subtoken_pooling', 'first']
      ] as const
    ).find(([key, want]) => config[key] !== want)
    if (mismatch) throw new Error(`The model's configuration does not match what this app runs (${mismatch[0]}).`)
    const tok = new UnigramTokenizer(JSON.parse(await readFile(path.join(dir, manifest.tokenizer), 'utf8')))
    const session = await ort.InferenceSession.create(path.join(dir, manifest.graph), {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: opts.threads ?? Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2))),
      interOpNumThreads: 1,
      logSeverityLevel: 3
    })
    const missing = INPUTS.find((n) => !session.inputNames.includes(n))
    if (missing || !session.outputNames.includes('logits')) {
      await session.release()
      throw new Error(`The model's graph does not have the expected ${missing ?? 'logits'} ${missing ? 'input' : 'output'}.`)
    }
    return new GlinerRuntime(session, tok, manifest, { maxWidth: manifest.maxWidth, entToken: manifest.entToken, sepToken: manifest.sepToken })
  }

  /**
   * Spans in each text above the manifest's threshold, flat within each window. Every window runs on its own: the
   * graph quantizes activations dynamically, with one scale for the whole batch, so a text batched with others
   * would score differently from the same text alone. Alone is how the reference runs it, and the result of one
   * text never depends on what else is being checked.
   */
  async recognize(texts: string[]): Promise<RawSpan[][]> {
    const out: RawSpan[][] = []
    for (const text of texts) {
      const enc = encodeWords(this.tok, splitWords(text))
      const spans: RawSpan[] = []
      for (const [a, b] of windows(enc.words.length, this.manifest.window, this.manifest.overlap)) {
        if (b <= a) continue
        const part: Encoded = { words: enc.words.slice(a, b), ids: enc.ids.slice(a, b) }
        const [found] = await this.run([part])
        for (const s of found) spans.push({ start: part.words[s.start].start, end: part.words[s.end].end, label: s.label, score: s.score })
      }
      out.push(spans.sort((x, y) => x.start - y.start || x.end - y.end))
    }
    return out
  }

  private async run(rows: Encoded[]) {
    const b = buildBatch(this.tok, this.prompt, rows, this.spec)
    const feeds: Record<string, ort.Tensor> = {
      input_ids: new ort.Tensor('int64', b.inputIds, [b.size, b.seqLen]),
      attention_mask: new ort.Tensor('int64', b.attentionMask, [b.size, b.seqLen]),
      words_mask: new ort.Tensor('int64', b.wordsMask, [b.size, b.seqLen]),
      text_lengths: new ort.Tensor('int64', b.textLengths, [b.size, 1]),
      span_idx: new ort.Tensor('int64', b.spanIdx, [b.size, b.numSpans, 2]),
      span_mask: new ort.Tensor('bool', b.spanMask, [b.size, b.numSpans])
    }
    const result = await this.session.run(feeds)
    const logits = result.logits
    const [batch, words, width, classes] = logits.dims
    if (batch !== b.size || words !== b.maxWords || width !== this.spec.maxWidth || classes !== this.manifest.labels.length) {
      throw new Error(`The model returned scores of an unexpected shape (${logits.dims.join('×')}).`)
    }
    return decodeSpans(logits.data as Float32Array, b, width, classes, this.manifest.threshold)
  }

  async release(): Promise<void> {
    await this.session.release()
  }
}
