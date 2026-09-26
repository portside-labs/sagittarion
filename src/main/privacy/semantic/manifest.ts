// The on-device model, pinned. This manifest ships inside the app and is what a download is checked against: every
// file by size and SHA-256, from one commit of the publisher's repository, never a moving "latest". Changing the
// model means changing this file, its version and the golden fixtures (scripts/gliner-golden.py).
import type { SensitiveEntityType } from '@shared/privacy'

export interface ModelFile {
  /** Path inside the model directory, and inside the repository at `revision`. */
  path: string
  size: number
  sha256: string
}

export interface ModelLabel {
  /** What the model is asked to find, in its own words. */
  label: string
  /**
   * The entity it becomes. Null asks for the label only to absorb text that would otherwise be mistaken for
   * something else (a date is not a name), and drops it.
   */
  type: SensitiveEntityType | null
}

export interface SemanticModelManifest {
  id: string
  version: string
  name: string
  publisher: string
  license: string
  source: { host: string; repo: string; revision: string }
  files: ModelFile[]
  /** The ONNX graph among the files. */
  graph: string
  tokenizer: string
  config: string
  /** What the exported graph was built for; the runtime checks the config says the same before loading. */
  spanMode: 'markerV0'
  maxWidth: number
  entToken: string
  sepToken: string
  /** In prompt order; the order is part of what the golden fixtures pin. */
  labels: ModelLabel[]
  threshold: number
  /** Long texts are read in windows of this many words, overlapping by `overlap`. */
  window: number
  overlap: number
}

export const GLINER_PII_BASE: SemanticModelManifest = {
  id: 'gliner-pii-base',
  version: '1.0',
  name: 'GLiNER PII base',
  publisher: 'Knowledgator and Wordcab',
  license: 'Apache-2.0',
  source: { host: 'huggingface.co', repo: 'knowledgator/gliner-pii-base-v1.0', revision: '61726e0ad791dcab3e29339bbec3ad42ded65641' },
  files: [
    { path: 'gliner_config.json', size: 3902, sha256: 'e33d3da38e0d369fa7574668d3798ca6c7d2b23cba7d628507112eeb426aaccb' },
    { path: 'tokenizer.json', size: 8649232, sha256: 'ee028763434d18611c1c36356ea1d050e90a9fa94ede57fac48b39f85f818ad1' },
    { path: 'onnx/model_quint8.onnx', size: 196757174, sha256: '0514c8fd86d0513ce5351a3267f132b57d5bcd8f99a90d43cde1228092881d19' }
  ],
  graph: 'onnx/model_quint8.onnx',
  tokenizer: 'tokenizer.json',
  config: 'gliner_config.json',
  spanMode: 'markerV0',
  maxWidth: 12,
  entToken: '<<ENT>>',
  sepToken: '<<SEP>>',
  labels: [
    { label: 'name', type: 'PERSON_NAME' },
    { label: 'location address', type: 'STREET_ADDRESS' },
    { label: 'location city', type: 'CITY' },
    { label: 'location state', type: 'STATE' },
    { label: 'location country', type: 'COUNTRY' },
    { label: 'organization', type: 'ORGANIZATION' },
    { label: 'organization medical facility', type: 'ORGANIZATION' },
    { label: 'password', type: 'PASSWORD' },
    { label: 'phone number', type: 'PHONE_NUMBER' },
    { label: 'date', type: null }
  ],
  threshold: 0.5,
  window: 256,
  overlap: 32
}

export function modelUrl(m: SemanticModelManifest, file: ModelFile): string {
  return `https://${m.source.host}/${m.source.repo}/resolve/${m.source.revision}/${file.path}`
}

export function modelSize(m: SemanticModelManifest): number {
  return m.files.reduce((n, f) => n + f.size, 0)
}

/** The graph's digest identifies the model in audit records. */
export function modelDigest(m: SemanticModelManifest): string {
  return m.files.find((f) => f.path === m.graph)!.sha256
}
