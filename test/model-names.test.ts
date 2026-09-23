import { describe, expect, it } from 'vitest'
import { modelTitle, prettyModelName } from '../src/shared/ai'

describe('model titles', () => {
  it('reads catalogue titles for known ids', () => {
    expect(modelTitle('anthropic', 'claude-haiku-4-5-20251001')).toBe('Claude Haiku 4.5')
    expect(modelTitle('groq', 'openai/gpt-oss-120b')).toBe('GPT-OSS 120B')
    expect(modelTitle('openai', 'gpt-5.4-mini')).toBe('GPT-5.4 mini')
  })

  it('makes readable names for ids a provider lists', () => {
    const cases: Array<[string, string]> = [
      ['claude-sonnet-4-6', 'Claude Sonnet 4.6'],
      ['claude-opus-4-1-20250805', 'Claude Opus 4.1'],
      ['claude-3-5-sonnet-20241022', 'Claude 3.5 Sonnet'],
      ['gpt-4o', 'GPT-4o'],
      ['gpt-4o-mini-2024-07-18', 'GPT-4o mini'],
      ['gpt-4.1-nano', 'GPT-4.1 nano'],
      ['o3-mini', 'o3 mini'],
      ['gemini-2.5-flash-lite', 'Gemini 2.5 Flash Lite'],
      ['llama-3.3-70b-versatile', 'Llama 3.3 70B Versatile'],
      ['meta-llama/llama-4-scout-17b-16e-instruct', 'Llama 4 Scout 17B 16e Instruct'],
      ['llama3.2:latest', 'Llama 3.2'],
      ['qwen2.5-coder:7b', 'Qwen 2.5 Coder 7B'],
      ['deepseek-r1:8b', 'DeepSeek R1 8B'],
      ['mistral-small-latest', 'Mistral Small'],
      ['my_custom_model', 'My Custom Model']
    ]
    for (const [id, title] of cases) expect(prettyModelName(id), id).toBe(title)
  })

  it('falls back to the id itself when nothing readable is left', () => {
    expect(prettyModelName('latest')).toBe('latest')
  })
})
