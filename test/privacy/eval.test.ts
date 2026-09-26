// Detection quality, measured. Recall matters most: a false positive costs a placeholder, a false negative can send
// a value to a third party. The deterministic tier's recall is asserted; the semantic tier is reported so the gap
// the Phase 3 model has to close stays visible.
//
// Holdout: set PRIVACY_HOLDOUT to a JSONL file of cases ({ text, expect: [{ value, type }], tier }) kept outside this
// repository and never used for tuning. PRIVACY_HOLDOUT_MIN_RECALL, when set, turns its recall into an assertion.
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PrivacyEngine } from '../../src/main/privacy/engine'
import { GlinerDetector } from '../../src/main/privacy/semantic/detector'
import { GLINER_PII_BASE } from '../../src/main/privacy/semantic/manifest'
import { GlinerRuntime } from '../../src/main/privacy/semantic/runtime'
import { PiiVault } from '../../src/main/privacy/vault'
import { CORPUS, type CorpusCase } from './corpus'
import { engine, policy } from './helpers'

interface Metrics {
  cases: number
  expected: number
  found: number
  protectedSpans: number
  spansOnTarget: number
  negativeTokens: number
  negativeTokensProtected: number
  misses: string[]
}

function occurrences(text: string, value: string): [number, number][] {
  const out: [number, number][] = []
  for (let i = text.indexOf(value); i >= 0; i = text.indexOf(value, i + 1)) out.push([i, i + value.length])
  return out
}

async function evaluate(cases: CorpusCase[], e: PrivacyEngine = engine()): Promise<Metrics> {
  const m: Metrics = { cases: cases.length, expected: 0, found: 0, protectedSpans: 0, spansOnTarget: 0, negativeTokens: 0, negativeTokensProtected: 0, misses: [] }
  for (const k of cases) {
    const [p] = await e.protectAll([{ text: k.text, ctx: { role: 'prose' } }], new PiiVault(), policy)
    const spans = p.replacements.map((r) => [r.start, r.end] as [number, number])
    const covered = (s: number, t: number) => {
      for (let i = s; i < t; i++) if (!/\s/.test(k.text[i]) && !spans.some(([a, b]) => a <= i && i < b)) return false
      return true
    }
    const targets = k.expect.flatMap((x) => occurrences(k.text, x.value).map((o) => ({ ...x, span: o })))
    for (const x of k.expect) {
      m.expected++
      const hit = occurrences(k.text, x.value).some(([s, t]) => covered(s, t))
      if (hit) m.found++
      else m.misses.push(`${k.id}: ${x.type}`)
    }
    m.protectedSpans += spans.length
    m.spansOnTarget += spans.filter(([a, b]) => targets.some((x) => a < x.span[1] && x.span[0] < b)).length
    // Words that are not part of any expected value: how many got protected anyway.
    for (const w of k.text.matchAll(/\S+/g)) {
      const s = w.index ?? 0
      const t = s + w[0].length
      if (targets.some((x) => s < x.span[1] && x.span[0] < t)) continue
      m.negativeTokens++
      if (spans.some(([a, b]) => a < t && s < b)) m.negativeTokensProtected++
    }
  }
  return m
}

function summary(m: Metrics) {
  const recall = m.expected ? m.found / m.expected : 1
  const precision = m.protectedSpans ? m.spansOnTarget / m.protectedSpans : 1
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0
  const fpr = m.negativeTokens ? m.negativeTokensProtected / m.negativeTokens : 0
  const round = (n: number) => Math.round(n * 1000) / 1000
  return { cases: m.cases, expected: m.expected, recall: round(recall), falseNegativeRate: round(1 - recall), precision: round(precision), f1: round(f1), falsePositiveRate: round(fpr), misses: m.misses }
}

describe('evaluation corpus', () => {
  it('finds everything the deterministic tier is expected to find, and almost nothing else', async () => {
    const det = summary(await evaluate(CORPUS.filter((k) => k.tier === 'deterministic')))
    const neg = summary(await evaluate(CORPUS.filter((k) => k.tier === 'negative')))
    const sem = summary(await evaluate(CORPUS.filter((k) => k.tier === 'semantic')))
    console.info('privacy eval', JSON.stringify({ deterministic: det, negative: { ...neg, misses: undefined }, semantic: sem }, null, 2))
    expect(det.misses).toEqual([])
    expect(det.recall).toBe(1)
    expect(det.precision).toBeGreaterThanOrEqual(0.9)
    expect(det.falsePositiveRate).toBeLessThanOrEqual(0.05)
    // Ordinary questions go out untouched.
    expect(neg.falsePositiveRate).toBe(0)
    // Known gaps, for the semantic model to close; reported, and allowed to improve.
    expect(sem.recall).toBeLessThan(1)
  })

  it('covers every category the spec asks for', () => {
    const tags = new Set(CORPUS.flatMap((k) => k.tags))
    for (const t of ['punctuation', 'unicode', 'multilingual', 'phone', 'typo', 'json', 'sql', 'csv', 'log', 'markdown', 'nested', 'long', 'mixed']) expect(tags, t).toContain(t)
  })

  const holdout = process.env.PRIVACY_HOLDOUT
  it.runIf(Boolean(holdout && existsSync(holdout)))('reports on the private holdout set', async () => {
    const cases = readFileSync(holdout!, 'utf8')
      .split('\n')
      .filter((l) => l.trim())
      .map((l, i) => ({ id: `holdout-${i + 1}`, tags: [], tier: 'deterministic', ...JSON.parse(l) }) as CorpusCase)
    const result = summary(await evaluate(cases))
    // Aggregates only: the holdout's own text stays out of logs.
    console.info('privacy holdout', JSON.stringify({ ...result, misses: result.misses.length }))
    const min = Number(process.env.PRIVACY_HOLDOUT_MIN_RECALL)
    if (Number.isFinite(min)) expect(result.recall).toBeGreaterThanOrEqual(min)
  })
})

// With the on-device model (SAGITTARION_GLINER_DIR pointing at its files): the same corpus through rules and model.
const modelDir = process.env.SAGITTARION_GLINER_DIR
describe.runIf(Boolean(modelDir && existsSync(path.join(modelDir, GLINER_PII_BASE.graph))))('evaluation corpus with the on-device model', () => {
  let runtime: GlinerRuntime
  beforeAll(async () => {
    runtime = await GlinerRuntime.load(modelDir!, GLINER_PII_BASE)
  })
  afterAll(async () => {
    await runtime?.release()
  })

  it('closes most of the semantic gap without losing anything the rules find', async () => {
    const withModel = () => new PrivacyEngine({ schemaDetection: true, semantic: new GlinerDetector((texts) => runtime.recognize(texts), GLINER_PII_BASE) })
    const det = summary(await evaluate(CORPUS.filter((k) => k.tier === 'deterministic'), withModel()))
    const neg = summary(await evaluate(CORPUS.filter((k) => k.tier === 'negative'), withModel()))
    const sem = summary(await evaluate(CORPUS.filter((k) => k.tier === 'semantic'), withModel()))
    console.info('privacy eval with model', JSON.stringify({ deterministic: det, negative: neg, semantic: sem }, null, 2))
    expect(det.recall).toBe(1)
    expect(det.precision).toBeGreaterThanOrEqual(0.9)
    expect(sem.recall).toBeGreaterThanOrEqual(0.7)
    expect(neg.falsePositiveRate).toBeLessThanOrEqual(0.05)
  })
})
