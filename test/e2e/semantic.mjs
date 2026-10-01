// End-to-end check of the on-device model in the built app: with the model installed, a question holding a name that
// only the model can find is asked of a mock OpenAI-compatible provider, which records every byte it receives.
//
//   SAGITTARION_GLINER_DIR=<model dir> npm run test:e2e:model
//
// <model dir> holds the manifest's files (gliner_config.json, tokenizer.json, onnx/model_quint8.onnx). Without it the
// script says so and exits: the model is a 196 MB download that CI does not fetch.
import { _electron as electron } from 'playwright'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const artifacts = path.join(root, 'test', 'e2e', 'artifacts')
const modelSrc = process.env.SAGITTARION_GLINER_DIR
const FILES = ['gliner_config.json', 'tokenizer.json', 'onnx/model_quint8.onnx']
if (!modelSrc || !FILES.every((f) => fs.existsSync(path.join(modelSrc, f)))) {
  console.log('SAGITTARION_GLINER_DIR not set to a model directory; skipping the on-device model flow')
  process.exit(0)
}

const received = []
const server = http.createServer((req, res) => {
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const send = (obj) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(obj))
    }
    if (req.url.endsWith('/models')) return send({ data: [{ id: 'mock-sql' }] })
    received.push(body)
    const question = [...JSON.parse(body).messages].reverse().find((m) => m.role === 'user').content
    const person = (question.match(/<\|PII:PERSON:[0-9A-F]{6}\|>/) ?? [])[0]
    const args = person
      ? { sql: `SELECT id, name, email FROM users WHERE name = '${person}' LIMIT 200`, explanation: `The user named ${person}.`, tables_used: ['users'] }
      : { sql: 'SELECT 1', explanation: 'No name was protected.', tables_used: [] }
    send({ model: 'mock-sql', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'propose_query', arguments: JSON.stringify(args) } }] } }], usage: {} })
  })
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))

// A fresh profile with the model installed where the app keeps it; links, so nothing large is copied.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sagittarion-semantic-'))
const userData = path.join(tmp, 'userData')
const modelDir = path.join(userData, 'models', 'gliner-pii-base', '1.0')
for (const f of FILES) {
  fs.mkdirSync(path.dirname(path.join(modelDir, f)), { recursive: true })
  fs.symlinkSync(path.resolve(modelSrc, f), path.join(modelDir, f))
}
const db = path.join(tmp, 'demo.db')
fs.copyFileSync(path.join(root, 'test', 'fixtures', 'sample.db'), db)
fs.mkdirSync(artifacts, { recursive: true })

const app = await electron.launch({ args: [path.join(root, 'out', 'main', 'index.js')], env: { ...process.env, SAGITTARION_USER_DATA: userData, NODE_ENV: 'production' } })
const page = await app.firstWindow()
const errors = []
page.on('pageerror', (e) => errors.push(String(e)))
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()))
await page.waitForLoadState('domcontentloaded')

try {
  await page.getByTestId('open-settings').click()
  await page.getByTestId('settings-tab-models').click()
  await page.getByTestId('ai-type-local').click()
  await page.getByTestId('ai-local-type').selectOption('openai-compatible')
  await page.getByTestId('ai-base-url').fill(`http://127.0.0.1:${server.address().port}/v1`)
  await page.getByTestId('ai-model').fill('mock-sql')
  // The mock runs on this computer, so protect local models too.
  await page.getByTestId('privacy-local').check()
  await page.getByTestId('privacy-model').locator('.badge', { hasText: 'Installed' }).waitFor()
  assert.ok(await page.getByTestId('privacy-semantic').isEnabled(), 'the switch is offered once the model is installed')
  await page.getByTestId('privacy-semantic').check()
  await page.getByTestId('privacy-detectors').screenshot({ path: path.join(artifacts, 'semantic-settings.png') })
  await page.getByTestId('settings-save').click()
  await page.locator('.toast.success', { hasText: 'Settings saved' }).waitFor()
  await page.keyboard.press('Escape')

  await page.getByTestId('choose-sqlite').click()
  await page.getByPlaceholder('Production analytics').fill('Semantic demo')
  await page.getByTestId('sqlite-path').fill(db)
  await page.getByTestId('connect-button').click()
  await page.getByTestId('tree-table-users').waitFor({ timeout: 30000 })
  await page.getByTestId('new-query-tab').click()
  await page.getByTestId('ask-input').fill('show the user Xiomara Quispe and her email')
  await page.getByTestId('ask-button').click()
  await page.getByTestId('ask-result').waitFor({ timeout: 60000 })

  const sent = received.join('\n')
  assert.ok(received.length >= 1, 'the provider was asked')
  assert.ok(!/Xiomara|Quispe/.test(sent), 'the name the model found never reached the provider')
  assert.match(sent, /<\|PII:PERSON:[0-9A-F]{6}\|>/, 'the provider saw a placeholder instead')
  const editor = await page.locator('.tab-pane:not([hidden]) .query-tab .cm-content').textContent()
  assert.match(editor, /name = 'Xiomara Quispe'/, 'the SQL was restored on this computer')
  // The model ran in its own Electron utility process (Node and onnxruntime-node), not in the window or the main process.
  const processes = await app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ type: m.type, name: m.name ?? '' })))
  assert.ok(
    processes.some((p) => p.type === 'Utility' && p.name === 'Sagittarion privacy model'),
    'the model process is running'
  )
  assert.deepEqual(errors, [])
  console.log('on-device model protected a name the rules miss; the provider saw only a placeholder')
  console.log('E2E (on-device model) passed.')
} finally {
  await app.close()
  server.close()
  fs.rmSync(tmp, { recursive: true, force: true })
}
