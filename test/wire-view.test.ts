import { describe, expect, it } from 'vitest'
import { countMatches, markText, readableRequest, readableResponse } from '../src/renderer/src/lib/wire-view'

describe('reading what was sent', () => {
  it('turns an OpenAI chat request into labelled sections, tool definitions folded', () => {
    const body = JSON.stringify({
      model: 'gpt-x',
      messages: [
        { role: 'system', content: '## Protected values\nrules' },
        { role: 'user', content: 'orders for <|PII:EMAIL:27A922|>' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'search_schema', arguments: '{"query":"orders"}' } }] },
        { role: 'tool', tool_call_id: 'c1', content: 'orders(id int pk)' }
      ],
      tools: [{ type: 'function', function: { name: 'propose_query' } }],
      tool_choice: 'auto'
    })
    const sections = readableRequest(body)
    expect(sections.map((s) => s.label)).toEqual(['settings', 'system', 'user', 'assistant → search_schema', 'tool result · c1', 'tool definitions (1)'])
    expect(sections[1].text).toBe('## Protected values\nrules')
    expect(sections[3].text).toBe('{\n  "query": "orders"\n}')
    expect(sections[5]).toMatchObject({ collapsed: true, summary: 'propose_query' })
    // A long system prompt starts folded so the question is in view; short ones stay open.
    const long = readableRequest(JSON.stringify({ messages: [{ role: 'system', content: 'x'.repeat(900) }, { role: 'user', content: 'q' }] }))
    expect(long.map((s) => [s.label, Boolean(s.collapsed)])).toEqual([
      ['system', true],
      ['user', false]
    ])
    expect(sections[1].collapsed).toBeUndefined()
  })

  it('reads Anthropic requests and responses, with cached system blocks and tool use', () => {
    const request = readableRequest(
      JSON.stringify({
        model: 'claude-x',
        max_tokens: 2048,
        system: [{ type: 'text', text: 'rules' }, { type: 'text', text: 'schema', cache_control: { type: 'ephemeral' } }],
        messages: [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'describe_table', input: { table: 'users' } }] },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'users(id int pk)' }] }
        ]
      })
    )
    expect(request.map((s) => s.label)).toEqual(['settings', 'system', 'system · cached', 'user', 'assistant → describe_table', 'tool result · t1'])
    const response = readableResponse(
      JSON.stringify({ model: 'claude-x', stop_reason: 'tool_use', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', name: 'propose_query', input: { sql: 'SELECT 1' } }], usage: { input_tokens: 9 } })
    )
    expect(response.map((s) => s.label)).toEqual(['assistant', 'assistant → propose_query', 'details'])
  })

  it('reads OpenAI responses, embeddings and errors, and never throws on odd bodies', () => {
    const tool = readableResponse(
      JSON.stringify({ model: 'm', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ function: { name: 'propose_query', arguments: '{"sql":"SELECT 1"}' } }] } }] })
    )
    expect(tool.map((s) => s.label)).toEqual(['assistant → propose_query', 'details'])
    expect(readableRequest(JSON.stringify({ model: 'e', input: ['a', 'b'] })).map((s) => s.label)).toEqual(['settings', 'input 1', 'input 2'])
    expect(readableResponse(JSON.stringify({ data: [{ embedding: [0.1, 0.2, 0.3] }, { embedding: [0, 0, 1] }] }))[0].text).toBe('2 vectors of 3 numbers each. The numbers are in the raw view.')
    expect(readableResponse(JSON.stringify({ error: { message: 'Invalid key' } }))).toEqual([{ label: 'error', text: 'Invalid key' }])
    expect(readableResponse(null)).toEqual([{ label: 'response', text: 'No response arrived.' }])
    expect(readableRequest('not json')).toEqual([{ label: 'body', text: 'not json' }])
  })

  it('marks placeholders and search matches, and counts matches on the exact bytes', () => {
    const parts = markText('call <|PII:PERSON:A81F32|> at <|PII:PHONE:9C8721|>, Jack said "hi"', 'jack')
    expect(parts).toEqual([
      { text: 'call ', kind: 'plain' },
      { text: '<|PII:PERSON:A81F32|>', kind: 'placeholder' },
      { text: ' at ', kind: 'plain' },
      { text: '<|PII:PHONE:9C8721|>', kind: 'placeholder' },
      { text: ', ', kind: 'plain' },
      { text: 'Jack', kind: 'match' },
      { text: ' said "hi"', kind: 'plain' }
    ])
    // Bodies are JSON: a search with quotes also finds its escaped form.
    const body = JSON.stringify({ content: 'he said "hi" to Jack' })
    expect(countMatches([body, null, 'JACK'], 'said "hi"')).toEqual([1, 0, 0])
    expect(countMatches([body, 'jack'], 'Jack')).toEqual([1, 1])
    expect(countMatches([body], '   ')).toEqual([0])
  })
})
