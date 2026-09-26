// The TypeScript port against the reference GLiNER implementation (fixtures from scripts/gliner-golden.py). Word
// splitting is checked always; tokenization and the entities found need the model files, so they run when
// SAGITTARION_GLINER_DIR points at a directory laid out as the manifest lists them.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { encodeWords, promptIds, splitWords } from '../../../src/main/privacy/semantic/gliner'
import { GLINER_PII_BASE as manifest } from '../../../src/main/privacy/semantic/manifest'
import { GlinerRuntime } from '../../../src/main/privacy/semantic/runtime'
import { UnigramTokenizer } from '../../../src/main/privacy/semantic/tokenizer'

interface GoldenCase {
  text: string
  words: [string, number, number][]
  input_ids: number[]
  words_mask: number[]
  entities: { start: number; end: number; text: string; label: string; score: number }[]
}

const golden = JSON.parse(readFileSync(path.join(__dirname, '../fixtures/gliner-golden.json'), 'utf8')) as { labels: string[]; threshold: number; cases: GoldenCase[] }
const dir = process.env.SAGITTARION_GLINER_DIR
const haveModel = Boolean(dir && existsSync(path.join(dir, manifest.graph)))

/** The reference reports offsets in code points; JavaScript strings count UTF-16 units. */
const cp = (text: string, utf16: number) => Array.from(text.slice(0, utf16)).length

describe('GLiNER port: golden cases from the reference implementation', () => {
  it('pins the same labels and threshold as the manifest', () => {
    expect(golden.labels).toEqual(manifest.labels.map((l) => l.label))
    expect(golden.threshold).toBe(manifest.threshold)
    expect(golden.cases.length).toBeGreaterThan(80)
  })

  it('splits every text into the same words at the same offsets', () => {
    for (const c of golden.cases) {
      const words = splitWords(c.text).map((w) => [w.text, cp(c.text, w.start), cp(c.text, w.end)])
      expect(words, JSON.stringify(c.text)).toEqual(c.words)
    }
  })

  describe.runIf(haveModel)('with the model files', () => {
    let tok: UnigramTokenizer
    let runtime: GlinerRuntime

    beforeAll(async () => {
      tok = new UnigramTokenizer(JSON.parse(readFileSync(path.join(dir!, manifest.tokenizer), 'utf8')))
      runtime = await GlinerRuntime.load(dir!, manifest)
    })
    afterAll(async () => {
      await runtime?.release()
    })

    it('produces the same token ids and word masks', () => {
      const prompt = promptIds(tok, golden.labels, manifest)
      const mismatches: string[] = []
      for (const c of golden.cases) {
        const enc = encodeWords(tok, splitWords(c.text))
        const ids = [tok.clsId, ...prompt, ...enc.ids.flat(), tok.sepId]
        const mask = [0, ...prompt.map(() => 0), ...enc.ids.flatMap((t, w) => t.map((_, k) => (k === 0 ? w + 1 : 0))), 0]
        if (JSON.stringify(ids) !== JSON.stringify(c.input_ids) || JSON.stringify(mask) !== JSON.stringify(c.words_mask)) mismatches.push(JSON.stringify(c.text))
      }
      expect(mismatches).toEqual([])
    })

    it('finds the same entities with the same scores', async () => {
      const found = await runtime.recognize(golden.cases.map((c) => c.text))
      golden.cases.forEach((c, i) => {
        const got = found[i].map((s) => ({ start: cp(c.text, s.start), end: cp(c.text, s.end), text: c.text.slice(s.start, s.end), label: golden.labels[s.label], score: s.score }))
        expect(got.map(({ score: _, ...rest }) => rest), JSON.stringify(c.text)).toEqual(c.entities.map(({ score: _, ...rest }) => rest))
        got.forEach((g, k) => expect(Math.abs(g.score - c.entities[k].score), JSON.stringify(c.text)).toBeLessThan(2e-3))
      })
    })
  })
})
