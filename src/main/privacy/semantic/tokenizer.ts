// DeBERTa-v3's tokenizer as the Hugging Face fast tokenizer runs it on words that are already split, the way GLiNER
// calls it: each word is stripped and normalized with SentencePiece's precompiled character map (and any Replace
// rules after it), given a leading ▁ and cut at spaces, and each piece is segmented into the vocabulary's most
// likely pieces (Unigram, Viterbi). Ported from tokenizers' Strip, Precompiled, Replace, Metaspace and Unigram; test/privacy/semantic/golden.test.ts checks the
// token ids against the reference for every text of the evaluation corpus and a set of Unicode edge cases.
//
// One deliberate difference: special tokens ([CLS], <<ENT>>, <<SEP>>…) written inside the user's text are ordinary
// characters here. The reference would read them as structure, which would let text rewrite the model's prompt.

const REPLACEMENT = '\u2581'
/** tokenizers' K_UNK_PENALTY: an unknown character costs this much less than the rarest known piece. */
const UNK_PENALTY = 10
/** Rust's char::is_whitespace, which the Strip normalizer uses (JavaScript's \s differs on U+0085 and U+FEFF). */
const EDGE_SPACE = /^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g

// darts-clone double-array units
const hasLeaf = (unit: number) => ((unit >>> 8) & 1) === 1
const valueOf = (unit: number) => unit & 0x7fffffff
const labelOf = (unit: number) => (unit & 0x800000ff) >>> 0
const offsetOf = (unit: number) => (unit >>> 10) << ((unit & 0x200) >>> 6)

/** SentencePiece's precompiled normalization: a double-array trie over UTF-8 bytes, and the strings it maps to. */
export class PrecompiledCharsmap {
  private readonly units: Uint32Array
  private readonly normalized: Buffer
  private readonly graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

  constructor(blob: Buffer) {
    const trieBytes = blob.length >= 4 ? blob.readUInt32LE(0) : -1
    if (trieBytes < 4 || trieBytes % 4 !== 0 || 4 + trieBytes > blob.length) throw new Error('The tokenizer character map is malformed.')
    this.units = new Uint32Array(trieBytes / 4)
    for (let i = 0; i < this.units.length; i++) this.units[i] = blob.readUInt32LE(4 + i * 4)
    this.normalized = blob.subarray(4 + trieBytes)
  }

  /** What the shortest key that prefixes `chunk` maps to, as spm_precompiled's transform; undefined without a match. */
  transform(chunk: string): string | undefined {
    const units = this.units
    let pos = offsetOf(units[0])
    for (const byte of Buffer.from(chunk, 'utf8')) {
      if (byte === 0) break
      pos ^= byte
      if (pos >= units.length) return undefined
      const unit = units[pos]
      if (labelOf(unit) !== byte) return undefined
      pos ^= offsetOf(unit)
      if (hasLeaf(unit)) {
        if (pos >= units.length) return undefined
        const start = valueOf(units[pos])
        let end = start
        while (end < this.normalized.length && this.normalized[end] !== 0) end++
        return this.normalized.toString('utf8', start, end)
      }
    }
    return undefined
  }

  /** Grapheme by grapheme, as tokenizers' Precompiled normalizer: whole short graphemes first, else each character. */
  normalize(text: string): string {
    let out = ''
    for (const { segment } of this.graphemes.segment(text)) {
      if (Buffer.byteLength(segment, 'utf8') < 6) {
        const whole = this.transform(segment)
        if (whole !== undefined) {
          out += whole
          continue
        }
      }
      for (const ch of segment) out += this.transform(ch) ?? ch
    }
    return out
  }
}

/** Metaspace with prepend_scheme "always" and split: spaces become ▁, a ▁ leads, and each ▁ starts a piece. */
export function metaspace(text: string): string[] {
  let t = text.replaceAll(' ', REPLACEMENT)
  if (!t) return []
  if (!t.startsWith(REPLACEMENT)) t = REPLACEMENT + t
  const pieces: string[] = []
  let start = 0
  for (let i = 1; i < t.length; i++) {
    if (t[i] === REPLACEMENT) {
      pieces.push(t.slice(start, i))
      start = i
    }
  }
  pieces.push(t.slice(start))
  return pieces
}

interface TokenizerJson {
  added_tokens?: { id: number; content: string; special?: boolean }[]
  normalizer?: {
    type: string
    normalizers?: { type: string; strip_left?: boolean; strip_right?: boolean; precompiled_charsmap?: string; pattern?: { Regex?: string; String?: string }; content?: string }[]
  }
  pre_tokenizer?: { type: string; pretokenizers?: { type: string; replacement?: string; prepend_scheme?: string; split?: boolean }[]; replacement?: string; prepend_scheme?: string; split?: boolean }
  post_processor?: { type: string; special_tokens?: Record<string, { ids: number[] }> }
  model?: { type: string; unk_id?: number | null; byte_fallback?: boolean; vocab?: [string, number][] }
}

/** Refuses a tokenizer definition this port does not implement, rather than tokenize differently from the model. */
function expect(ok: unknown, what: string): asserts ok {
  if (!ok) throw new Error(`The tokenizer is not the kind this app can run: ${what}.`)
}

export class UnigramTokenizer {
  readonly clsId: number
  readonly sepId: number
  readonly padId: number
  readonly unkId: number
  private readonly pieces = new Map<string, number>()
  private readonly scores: Float64Array
  private readonly maxPieceChars: number
  private readonly unkScore: number
  private readonly special = new Map<string, number>()
  private readonly charsmap: PrecompiledCharsmap
  private readonly replacements: [RegExp, string][] = []
  private readonly cache = new Map<string, number[]>()

  constructor(json: TokenizerJson) {
    const norms = json.normalizer?.type === 'Sequence' ? (json.normalizer.normalizers ?? []) : []
    expect(norms.length >= 2 && norms[0].type === 'Strip' && norms[0].strip_left && norms[0].strip_right, 'normalizer should strip both ends')
    expect(norms[1].type === 'Precompiled' && typeof norms[1].precompiled_charsmap === 'string', 'normalizer should be SentencePiece precompiled')
    for (const r of norms.slice(2)) {
      expect(r.type === 'Replace' && typeof r.content === 'string' && (typeof r.pattern?.Regex === 'string' || typeof r.pattern?.String === 'string'), `unsupported normalizer ${r.type}`)
      const source = r.pattern!.Regex ?? r.pattern!.String!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      this.replacements.push([new RegExp(source, 'gu'), r.content!])
    }
    const pre = json.pre_tokenizer?.type === 'Sequence' ? json.pre_tokenizer.pretokenizers : json.pre_tokenizer ? [json.pre_tokenizer] : []
    expect(pre?.length === 1 && pre[0].type === 'Metaspace' && pre[0].replacement === REPLACEMENT && pre[0].prepend_scheme === 'always' && pre[0].split === true, 'pre-tokenizer should be Metaspace')
    const model = json.model
    expect(model?.type === 'Unigram' && Array.isArray(model.vocab) && model.vocab.length > 0, 'model should be Unigram')
    expect(!model.byte_fallback, 'byte fallback is not supported')
    expect(typeof model.unk_id === 'number' && model.unk_id >= 0 && model.unk_id < model.vocab.length, 'an unknown token is required')
    const post = json.post_processor
    expect(post?.type === 'TemplateProcessing' && post.special_tokens?.['[CLS]']?.ids.length === 1 && post.special_tokens['[SEP]']?.ids.length === 1, 'post-processor should add [CLS] and [SEP]')

    this.charsmap = new PrecompiledCharsmap(Buffer.from(norms[1].precompiled_charsmap!, 'base64'))
    for (const t of json.added_tokens ?? []) if (t.special) this.special.set(t.content, t.id)
    const specialIds = new Set(this.special.values())
    this.scores = new Float64Array(model.vocab.length)
    let min = Infinity
    let longest = 1
    model.vocab.forEach(([piece, score], id) => {
      this.scores[id] = score
      if (score < min) min = score
      if (specialIds.has(id)) return
      if (!this.pieces.has(piece)) this.pieces.set(piece, id)
      longest = Math.max(longest, [...piece].length)
    })
    this.maxPieceChars = longest
    this.unkScore = min - UNK_PENALTY
    this.unkId = model.unk_id
    this.clsId = post.special_tokens['[CLS]'].ids[0]
    this.sepId = post.special_tokens['[SEP]'].ids[0]
    this.padId = this.special.get('[PAD]') ?? 0
  }

  /** The id of a special token such as <<ENT>>; throws if the tokenizer does not have it. */
  specialId(content: string): number {
    const id = this.special.get(content)
    if (id === undefined) throw new Error(`The tokenizer has no ${content} token.`)
    return id
  }

  normalize(word: string): string {
    let out = this.charsmap.normalize(word.replace(EDGE_SPACE, ''))
    for (const [re, content] of this.replacements) out = out.replace(re, content)
    return out
  }

  /** The ids of one word, as the reference tokenizes an item of a pre-split input. */
  encodeWord(word: string): number[] {
    const hit = this.cache.get(word)
    if (hit) return hit
    const ids: number[] = []
    for (const piece of metaspace(this.normalize(word))) ids.push(...this.encodePiece(piece))
    if (this.cache.size >= 50_000) this.cache.clear()
    this.cache.set(word, ids)
    return ids
  }

  /** The best-scoring segmentation (tokenizers' Unigram encode_optimized), unknown runs fused into one token. */
  encodePiece(piece: string): number[] {
    const chars = Array.from(piece)
    const n = chars.length
    const best = new Float64Array(n + 1)
    const from = new Int32Array(n + 1).fill(-1)
    const ids = new Int32Array(n + 1)
    for (let start = 0; start < n; start++) {
      const base = best[start]
      let single = false
      let sub = ''
      for (let end = start + 1; end <= n && end - start <= this.maxPieceChars; end++) {
        sub += chars[end - 1]
        const id = this.pieces.get(sub)
        if (id === undefined) continue
        const score = base + this.scores[id]
        if (from[end] < 0 || score > best[end]) {
          best[end] = score
          from[end] = start
          ids[end] = id
        }
        if (end === start + 1) single = true
      }
      if (!single) {
        const score = base + this.unkScore
        if (from[start + 1] < 0 || score > best[start + 1]) {
          best[start + 1] = score
          from[start + 1] = start
          ids[start + 1] = this.unkId
        }
      }
    }
    const out: number[] = []
    let unknown = ''
    for (let end = n; end > 0; ) {
      const start = from[end]
      if (ids[end] === this.unkId) unknown = chars.slice(start, end).join('') + unknown
      else {
        if (unknown) out.push(this.pieces.get(unknown) ?? this.unkId)
        unknown = ''
        out.push(ids[end])
      }
      end = start
    }
    if (unknown) out.push(this.pieces.get(unknown) ?? this.unkId)
    return out.reverse()
  }
}
