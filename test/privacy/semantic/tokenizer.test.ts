// The tokenizer port on its own: SentencePiece's character map against what the Rust implementation makes of the same
// strings (fixtures from scripts/gliner-golden.py), and the Unigram segmentation on a vocabulary small enough to
// reason about.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { metaspace, PrecompiledCharsmap, UnigramTokenizer } from '../../../src/main/privacy/semantic/tokenizer'

const fixtures = path.join(__dirname, '../fixtures')
const charsmap = readFileSync(path.join(fixtures, 'nmt-nfkc.charsmap'))
const golden = JSON.parse(readFileSync(path.join(fixtures, 'gliner-golden.json'), 'utf8')) as { normalizer: [string, string][] }

describe('SentencePiece character map', () => {
  it('normalizes every string exactly as the Rust implementation does', () => {
    const map = new PrecompiledCharsmap(charsmap)
    const wrong = golden.normalizer.filter(([input, expected]) => map.normalize(input) !== expected).map(([input]) => JSON.stringify(input))
    expect(wrong).toEqual([])
    expect(golden.normalizer.length).toBeGreaterThan(90)
    // For the record: compatibility forms fold, control characters go.
    expect(map.normalize('ﬁle ＡＢＣ ①')).toBe('file ABC 1')
    expect(map.normalize('a\u0007b')).toBe('ab')
  })

  it('refuses a malformed map', () => {
    expect(() => new PrecompiledCharsmap(Buffer.from([1, 0, 0]))).toThrow(/malformed/)
    expect(() => new PrecompiledCharsmap(Buffer.from([0xff, 0xff, 0, 0, 1, 2]))).toThrow(/malformed/)
  })
})

/** A tokenizer.json with a handful of pieces; scores are log probabilities, higher is likelier. */
function tokenizerJson(overrides: Record<string, unknown> = {}) {
  const pieces: [string, number][] = [
    ['[PAD]', 0],
    ['[CLS]', 0],
    ['[SEP]', 0],
    ['[UNK]', 0],
    ['▁', -2],
    ['▁he', -3],
    ['▁hello', -4],
    ['llo', -4],
    ['h', -5],
    ['e', -5],
    ['l', -5],
    ['o', -5],
    ['▁a', -3],
    ['▁b', -3],
    ['[', -6],
    [']', -6],
    ['C', -6],
    ['L', -6],
    ['S', -6]
  ]
  return {
    added_tokens: [
      { id: 0, content: '[PAD]', special: true },
      { id: 1, content: '[CLS]', special: true },
      { id: 2, content: '[SEP]', special: true },
      { id: 3, content: '[UNK]', special: true },
      { id: 19, content: '<<ENT>>', special: true }
    ],
    normalizer: {
      type: 'Sequence',
      normalizers: [
        { type: 'Strip', strip_left: true, strip_right: true },
        { type: 'Precompiled', precompiled_charsmap: charsmap.toString('base64') },
        { type: 'Replace', pattern: { Regex: ' {2,}' }, content: ' ' }
      ]
    },
    pre_tokenizer: { type: 'Sequence', pretokenizers: [{ type: 'Metaspace', replacement: '▁', prepend_scheme: 'always', split: true }] },
    post_processor: { type: 'TemplateProcessing', special_tokens: { '[CLS]': { ids: [1] }, '[SEP]': { ids: [2] } } },
    model: { type: 'Unigram', unk_id: 3, byte_fallback: false, vocab: pieces },
    ...overrides
  }
}

describe('Unigram tokenizer', () => {
  const tok = new UnigramTokenizer(tokenizerJson())
  const ids = (word: string) => tok.encodeWord(word)

  it('picks the likeliest segmentation', () => {
    // "▁hello" (-4) beats "▁he" + "llo" (-7) and every split into letters.
    expect(ids('hello')).toEqual([6])
    expect(ids('he')).toEqual([5])
    expect(ids('ello')).toEqual([4, 9, 7])
  })

  it('fuses a run of unknown characters into one [UNK]', () => {
    expect(ids('h€€l')).toEqual([4, 8, 3, 10])
    expect(ids('€')).toEqual([4, 3])
  })

  it('reads special tokens inside text as ordinary characters', () => {
    expect(ids('[CLS]')).toEqual([4, 14, 16, 17, 18, 15])
    expect(ids('[CLS]')).not.toContain(tok.clsId)
    expect(tok.specialId('<<ENT>>')).toBe(19)
    expect(() => tok.specialId('<<SEP>>')).toThrow(/no <<SEP>> token/)
  })

  it('strips, normalizes and cuts at spaces with a leading ▁', () => {
    expect(metaspace('a b')).toEqual(['▁a', '▁b'])
    expect(metaspace('▁a▁▁b')).toEqual(['▁a', '▁', '▁b'])
    expect(metaspace('')).toEqual([])
    expect(tok.normalize('  a   b  ')).toBe('a b')
    expect(ids('a  b')).toEqual([12, 13])
    // A control character normalizes away: the word has no tokens at all.
    expect(ids('\u0007')).toEqual([])
  })

  it('refuses tokenizers it does not implement exactly', () => {
    expect(() => new UnigramTokenizer(tokenizerJson({ model: { type: 'BPE', vocab: [] } }))).toThrow(/Unigram/)
    expect(() => new UnigramTokenizer(tokenizerJson({ model: { type: 'Unigram', unk_id: 3, byte_fallback: true, vocab: [['a', 0]] } }))).toThrow(/byte fallback/)
    expect(() => new UnigramTokenizer(tokenizerJson({ normalizer: { type: 'NFC' } }))).toThrow(/strip/)
    expect(() => new UnigramTokenizer(tokenizerJson({ pre_tokenizer: { type: 'Whitespace' } }))).toThrow(/Metaspace/)
  })
})
