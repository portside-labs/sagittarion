// GLiNER's span model, run from Node: words split as the reference splits them, the prompt of labels, the tensors
// the ONNX graph takes, and the greedy decoding of its span scores. Mirrors the gliner package (0.2.29:
// WhitespaceTokenSplitter, UniEncoderSpanProcessor, SpanDecoder); test/privacy/semantic/golden.test.ts compares the
// result with the reference on the evaluation corpus. Pure functions: the inference itself is in runtime.ts.
import type { UnigramTokenizer } from './tokenizer'

export interface Word {
  text: string
  /** UTF-16 offsets into the text. */
  start: number
  end: number
}

/**
 * The reference's `\w+(?:[-_]\w+)*|\S` with Python's meanings: \w is a letter, a number or "_" (combining marks are
 * not), and whitespace is what str.isspace() says, which includes U+001C..U+001F and U+0085 but not U+FEFF.
 */
const WORD_RE = /[\p{L}\p{N}_]+(?:[-_][\p{L}\p{N}_]+)*|[^\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/gu

export function splitWords(text: string): Word[] {
  return [...text.matchAll(WORD_RE)].map((m) => ({ text: m[0], start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }))
}

export interface SpanModelSpec {
  /** Longest span in words; the graph was exported for this. */
  maxWidth: number
  /** Special tokens of the prompt. */
  entToken: string
  sepToken: string
}

/** One text as the model sees it: its words and each word's token ids. Words that make no tokens are left out. */
export interface Encoded {
  words: Word[]
  ids: number[][]
}

export function encodeWords(tok: UnigramTokenizer, words: Word[]): Encoded {
  const kept: Word[] = []
  const ids: number[][] = []
  for (const w of words) {
    const t = tok.encodeWord(w.text)
    // The reference numbers words by the tokens it meets, so a word without tokens would shift every later word onto
    // the wrong text. Dropping it keeps offsets right; no text of the golden set has one.
    if (!t.length) continue
    kept.push(w)
    ids.push(t)
  }
  return { words: kept, ids }
}

export interface Batch {
  size: number
  /** Tokens per row, padded. */
  seqLen: number
  /** Words per row, padded: the L of the logits. */
  maxWords: number
  numSpans: number
  inputIds: BigInt64Array
  attentionMask: BigInt64Array
  wordsMask: BigInt64Array
  textLengths: BigInt64Array
  spanIdx: BigInt64Array
  spanMask: Uint8Array
  /** Words in each row. */
  lengths: number[]
}

/** Token ids of the label prompt: <<ENT>> label … <<SEP>>, one word each, as UniEncoderSpanProcessor builds it. */
export function promptIds(tok: UnigramTokenizer, labels: string[], spec: SpanModelSpec): number[] {
  const ent = tok.specialId(spec.entToken)
  const out: number[] = []
  for (const label of labels) out.push(ent, ...tok.encodeWord(label))
  out.push(tok.specialId(spec.sepToken))
  return out
}

/** The inputs of the exported span model for several texts at once, padded as the reference's collator pads them. */
export function buildBatch(tok: UnigramTokenizer, prompt: number[], rows: Encoded[], spec: SpanModelSpec): Batch {
  const size = rows.length
  const lengths = rows.map((r) => r.words.length)
  const maxWords = Math.max(1, ...lengths)
  const tokens = rows.map((r) => [tok.clsId, ...prompt, ...r.ids.flat(), tok.sepId])
  const seqLen = Math.max(...tokens.map((t) => t.length))
  const numSpans = maxWords * spec.maxWidth
  const b: Batch = {
    size,
    seqLen,
    maxWords,
    numSpans,
    inputIds: new BigInt64Array(size * seqLen).fill(BigInt(tok.padId)),
    attentionMask: new BigInt64Array(size * seqLen),
    wordsMask: new BigInt64Array(size * seqLen),
    textLengths: new BigInt64Array(size),
    spanIdx: new BigInt64Array(size * numSpans * 2),
    spanMask: new Uint8Array(size * numSpans),
    lengths
  }
  rows.forEach((row, r) => {
    const t = tokens[r]
    for (let i = 0; i < t.length; i++) {
      b.inputIds[r * seqLen + i] = BigInt(t[i])
      b.attentionMask[r * seqLen + i] = 1n
    }
    // The first token of each word carries its 1-based index; the prompt, the rest of a word and [SEP] carry 0.
    let at = 1 + prompt.length
    row.ids.forEach((ids, w) => {
      b.wordsMask[r * seqLen + at] = BigInt(w + 1)
      at += ids.length
    })
    const L = lengths[r]
    b.textLengths[r] = BigInt(L)
    for (let s = 0; s < L; s++) {
      for (let k = 0; k < spec.maxWidth; k++) {
        const j = r * numSpans + s * spec.maxWidth + k
        b.spanIdx[j * 2] = BigInt(s)
        b.spanIdx[j * 2 + 1] = BigInt(s + k)
        b.spanMask[j] = s + k < L ? 1 : 0
      }
    }
  })
  return b
}

export interface WordSpan {
  /** Word indices, inclusive. */
  start: number
  end: number
  label: number
  score: number
}

/** torch.sigmoid on float32 logits, rounded back to float32 as the reference compares them. */
function sigmoid(x: number): number {
  return Math.fround(1 / (1 + Math.exp(-x)))
}

/**
 * SpanDecoder with flat_ner and without multi_label: every (start, width, class) above the threshold, best score
 * first, keeping each span that overlaps none already kept; ties keep the reference's order (start, width, class).
 * `logits` is [batch, maxWords, maxWidth, classes].
 */
export function decodeSpans(logits: Float32Array, batch: Pick<Batch, 'size' | 'maxWords' | 'lengths'>, maxWidth: number, classes: number, threshold: number): WordSpan[][] {
  const out: WordSpan[][] = []
  for (let r = 0; r < batch.size; r++) {
    const L = batch.lengths[r]
    const candidates: WordSpan[] = []
    for (let s = 0; s < L; s++) {
      for (let k = 0; k < maxWidth && s + k < L; k++) {
        const base = ((r * batch.maxWords + s) * maxWidth + k) * classes
        for (let c = 0; c < classes; c++) {
          const score = sigmoid(logits[base + c])
          if (score > threshold) candidates.push({ start: s, end: s + k, label: c, score })
        }
      }
    }
    candidates.sort((a, b) => b.score - a.score)
    const kept: WordSpan[] = []
    for (const c of candidates) if (!kept.some((k) => !(c.start > k.end || k.start > c.end))) kept.push(c)
    out.push(kept.sort((a, b) => a.start - b.start))
  }
  return out
}

/**
 * Long texts in overlapping windows of words, so no window outgrows what the model reads well. Spans found in the
 * overlap of two windows come back from both; the privacy engine merges overlapping detections anyway.
 */
export function windows(count: number, size: number, overlap: number): [number, number][] {
  if (count <= size) return [[0, count]]
  const out: [number, number][] = []
  const step = Math.max(1, size - overlap)
  for (let start = 0; ; start += step) {
    const end = Math.min(count, start + size)
    out.push([start, end])
    if (end === count) break
  }
  return out
}
