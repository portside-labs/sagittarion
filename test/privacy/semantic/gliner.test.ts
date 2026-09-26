// GLiNER's processing around the model: the tensors built for a text, the greedy decoding of span scores, and the
// windows long texts are read in. The golden test checks the same code against the reference on real text.
import { describe, expect, it } from 'vitest'
import { buildBatch, decodeSpans, encodeWords, promptIds, splitWords, windows } from '../../../src/main/privacy/semantic/gliner'
import type { UnigramTokenizer } from '../../../src/main/privacy/semantic/tokenizer'

/** One token per character, by code; a control character makes none. */
const tok = {
  clsId: 1,
  sepId: 2,
  padId: 0,
  specialId: (c: string) => (c === '<<ENT>>' ? 90 : 91),
  encodeWord: (w: string) => (w === '\u0007' ? [] : [...w].map((ch) => ch.charCodeAt(0)))
} as unknown as UnigramTokenizer
const spec = { maxWidth: 2, entToken: '<<ENT>>', sepToken: '<<SEP>>' }

describe('model inputs', () => {
  it('prompt, words and spans as the reference collates them', () => {
    const prompt = promptIds(tok, ['x'], spec)
    expect(prompt).toEqual([90, 120, 91])
    const b = buildBatch(tok, prompt, [encodeWords(tok, splitWords('ab c'))], spec)
    expect([...b.inputIds].map(Number)).toEqual([1, 90, 120, 91, 97, 98, 99, 2])
    expect([...b.attentionMask].map(Number)).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
    // The first token of each word carries its number; the prompt and the rest of a word carry 0.
    expect([...b.wordsMask].map(Number)).toEqual([0, 0, 0, 0, 1, 0, 2, 0])
    expect([...b.textLengths].map(Number)).toEqual([2])
    // Every start and width up to maxWidth; spans past the last word are masked out.
    expect([...b.spanIdx].map(Number)).toEqual([0, 0, 0, 1, 1, 1, 1, 2])
    expect([...b.spanMask]).toEqual([1, 1, 1, 0])
  })

  it('pads rows of different lengths', () => {
    const prompt = promptIds(tok, ['x'], spec)
    const b = buildBatch(tok, prompt, [encodeWords(tok, splitWords('abc')), encodeWords(tok, splitWords('d e'))], spec)
    expect([b.size, b.seqLen, b.maxWords, b.numSpans]).toEqual([2, 8, 2, 4])
    expect([...b.inputIds.slice(0, 8)].map(Number)).toEqual([1, 90, 120, 91, 97, 98, 99, 2])
    expect([...b.attentionMask.slice(0, 8)].map(Number)).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
    expect([...b.inputIds.slice(8)].map(Number)).toEqual([1, 90, 120, 91, 100, 101, 2, 0])
    expect([...b.attentionMask.slice(8)].map(Number)).toEqual([1, 1, 1, 1, 1, 1, 1, 0])
    expect([...b.spanMask]).toEqual([1, 0, 0, 0, 1, 1, 1, 0])
  })

  it('leaves out words that make no tokens, so later words keep their own offsets', () => {
    const enc = encodeWords(tok, splitWords('\u0007Jo Li'))
    expect(enc.words.map((w) => [w.text, w.start])).toEqual([
      ['Jo', 1],
      ['Li', 4]
    ])
  })
})

describe('span decoding', () => {
  /** Logits for one row of `words` words, width 2, 2 classes; `set` places a probability. */
  function logits(words: number, set: [start: number, width: number, cls: number, p: number][]) {
    const out = new Float32Array(words * 2 * 2).fill(-20)
    for (const [s, k, c, p] of set) out[(s * 2 + k) * 2 + c] = Math.log(p / (1 - p))
    return out
  }
  const decode = (words: number, set: [number, number, number, number][], length = words) => decodeSpans(logits(words, set), { size: 1, maxWords: words, lengths: [length] }, 2, 2, 0.5)[0]

  it('keeps the best span of any overlapping group, then the next that overlaps nothing kept', () => {
    const spans = decode(4, [
      [0, 1, 0, 0.9],
      [1, 0, 1, 0.95],
      [2, 1, 0, 0.8],
      [3, 0, 1, 0.7]
    ])
    // (1,1) wins; (0..1) overlaps it; (2..3) is next; (3,3) overlaps that.
    expect(spans.map((s) => [s.start, s.end, s.label])).toEqual([
      [1, 1, 1],
      [2, 3, 0]
    ])
  })

  it('reads the threshold as strictly greater, and one label per span', () => {
    expect(decode(1, [[0, 0, 0, 0.5]])).toEqual([])
    const both = decode(1, [
      [0, 0, 0, 0.6],
      [0, 0, 1, 0.7]
    ])
    expect(both.map((s) => s.label)).toEqual([1])
  })

  it('breaks ties in the reference order: start, then width, then class', () => {
    const tie = decode(3, [
      [1, 0, 1, 0.8],
      [0, 1, 0, 0.8]
    ])
    expect(tie.map((s) => [s.start, s.end])).toEqual([[0, 1]])
  })

  it('ignores spans past the end of a row', () => {
    expect(decode(3, [[1, 1, 0, 0.9]], 2)).toEqual([])
  })
})

describe('windows over long texts', () => {
  it('reads short texts whole and long ones in overlapping windows', () => {
    expect(windows(10, 256, 32)).toEqual([[0, 10]])
    expect(windows(600, 256, 32)).toEqual([
      [0, 256],
      [224, 480],
      [448, 600]
    ])
    expect(windows(0, 256, 32)).toEqual([[0, 0]])
  })
})
