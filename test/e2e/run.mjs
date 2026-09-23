// End-to-end test: drives the built Electron app with Playwright against the
// mock SSH server. Run with `npm run test:e2e`. Screenshots land in
// test/e2e/artifacts/.
import { _electron as electron } from 'playwright'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ssh2 from 'ssh2'
const { utils } = ssh2
import { ensureSampleDb, startMockServer } from '../mock-ssh/server.mjs'
import { loadFixture } from '../pg-server.mjs'
import pg from 'pg'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const artifacts = path.join(root, 'test', 'e2e', 'artifacts')
fs.mkdirSync(artifacts, { recursive: true })
const isMac = process.platform === 'darwin'
const mod = isMac ? 'Meta' : 'Control'

function assert(cond, msg) {
  if (!cond) throw new Error('Assertion failed: ' + msg)
}

/** Query the database file directly (via python3, which the tests need anyway) to verify what the GUI wrote. */
function sqlite(db, sql) {
  const script =
    'import sqlite3, sys\n' +
    'c = sqlite3.connect(sys.argv[1])\n' +
    'for row in c.execute(sys.argv[2]):\n' +
    '    print("|".join("" if v is None else str(v) for v in row))\n'
  const r = spawnSync('python3', ['-c', script, db, sql], { encoding: 'utf8' })
  if (r.status !== 0) throw new Error(r.stderr)
  return r.stdout.trim()
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sagittarion-e2e-'))
  const userData = path.join(tmp, 'userData')
  fs.mkdirSync(userData)
  const db = path.join(tmp, 'e2e.db')
  fs.copyFileSync(ensureSampleDb(), db)

  const server = await startMockServer({ noise: true })
  // Pre-trust the mock server's host key so no native dialog appears.
  const parsed = utils.parseKey(server.hostKey)
  const pub = parsed.getPublicSSH()
  fs.writeFileSync(
    path.join(userData, 'known_hosts.json'),
    JSON.stringify([
      {
        host: server.host,
        port: server.port,
        keyType: parsed.type,
        fingerprint: 'SHA256:' + createHash('sha256').update(pub).digest('base64').replace(/=+$/, ''),
        key: pub.toString('base64'),
        addedAt: Date.now()
      }
    ])
  )

  const launchOptions = {
    args: [path.join(root, 'out', 'main', 'index.js')],
    env: { ...process.env, SAGITTARION_USER_DATA: userData, NODE_ENV: 'production' }
  }
  let app = await electron.launch(launchOptions)
  const consoleErrors = []
  let page = await app.firstWindow()
  const watchConsole = () => {
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text())
    })
    page.on('pageerror', (e) => consoleErrors.push(String(e)))
  }
  watchConsole()
  await page.waitForLoadState('domcontentloaded')
  const shot = (name) => page.screenshot({ path: path.join(artifacts, name + '.png') })

  try {
    // ------------------------------------------------------------ settings dialog
    await page.getByTestId('open-settings').click()
    await page.getByTestId('settings-dialog').waitFor()
    await page.getByTestId('send-sample-values').check()
    await page.getByTestId('settings-save').click()
    await page.locator('.toast.success', { hasText: 'Settings saved' }).waitFor()
    await shot('00a-settings')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-testid=settings-dialog]'))

    // ------------------------------------------------------------ local SQLite: the default
    await page.getByTestId('choose-sqlite').waitFor()
    await shot('00-choose-kind')
    await page.getByTestId('choose-sqlite').click()
    assert((await page.getByTestId('conn-kind').textContent()).includes('SQLite'), 'the form names the database type')
    assert((await page.getByTestId('sqlite-remote').isChecked()) === false, 'a new SQLite connection is local by default')
    await page.getByPlaceholder('Production analytics').fill('E2E local file')
    await page.getByTestId('sqlite-path').fill(db)
    await shot('01-connect-local')
    await page.getByTestId('connect-button').click()
    await page.getByTestId('tree-table-users').waitFor({ timeout: 30000 })
    assert((await page.locator('.statusbar').textContent()).includes('This computer'), 'status bar says the file is local')
    console.log('local file connected; schema loaded')
    await shot('01b-workspace-empty')
    await page.getByTestId('disconnect-button').click()
    await page.getByTestId('new-connection').waitFor()

    // ------------------------------------------------------------ remote SQLite over SSH, saving the host as a profile
    await page.getByTestId('new-connection').click()
    await page.getByTestId('choose-sqlite').click()
    await page.getByPlaceholder('Production analytics').fill('E2E mock host')
    await page.getByTestId('sqlite-remote').check()
    await page.getByPlaceholder('db.example.com').fill(server.host)
    await page.locator('input[type=number]').fill(String(server.port))
    await page.getByPlaceholder('ubuntu').fill(server.username)
    await page.getByRole('button', { name: 'Password', exact: true }).click()
    await page.locator('input[type=password]').fill(server.password)
    await page.getByTestId('ssh-save-profile').check()
    await page.getByTestId('ssh-profile-name').fill('E2E SSH')
    await page.getByTestId('sqlite-path').fill(db)
    await shot('01-connect')

    // Remote file browser round trip
    await page.getByTestId('sqlite-browse').click()
    await page.getByText('Choose a database on the remote host').waitFor({ timeout: 20000 })
    await page.locator('.fb-row.db', { hasText: 'e2e.db' }).waitFor({ timeout: 20000 })
    await shot('02-file-browser')
    await page.locator('.fb-row.db', { hasText: 'e2e.db' }).dblclick()
    const picked = await page.getByTestId('sqlite-path').inputValue()
    assert(fs.realpathSync(picked) === fs.realpathSync(db), `file browser filled the path (got ${picked})`)

    await page.getByTestId('connect-button').click()
    await page.getByTestId('tree-table-users').waitFor({ timeout: 30000 })
    console.log('connected; schema loaded')
    const profiles = JSON.parse(fs.readFileSync(path.join(userData, 'ssh-profiles.json'), 'utf8')).profiles
    assert(profiles.length === 1 && profiles[0].name === 'E2E SSH' && profiles[0].host === server.host, 'the SSH details were saved as a profile')
    assert(!('password' in profiles[0]), 'the profile stores no plaintext password')
    const savedConns = JSON.parse(fs.readFileSync(path.join(userData, 'connections.json'), 'utf8')).connections
    const remoteConn = savedConns.find((c) => c.name === 'E2E mock host')
    assert(remoteConn && remoteConn.sshProfileId === profiles[0].id && !remoteConn.ssh.host, 'the connection references the profile instead of holding SSH details')

    // Sidebar filter: instant local matches for names, column matches via the server search.
    await page.getByTestId('tree-filter').fill('ord')
    await page.getByTestId('tree-table-orders').waitFor()
    await page.getByTestId('tree-view-order_summary').waitFor()
    assert((await page.getByTestId('tree-table-users').count()) === 0, 'filter hides tables that do not match')
    await page.getByTestId('tree-filter').fill('email')
    await page.locator('.tree-col.hit', { hasText: 'email' }).first().waitFor({ timeout: 10000 })
    await shot('01a-filter')
    await page.getByTestId('tree-filter').fill('')
    await page.getByTestId('tree-table-users').waitFor()
    // Indexes and triggers are groups of the schema, loaded when opened.
    await page.getByTestId('tree-group--index').click()
    await page.getByTestId('tree-index-idx_orders_user').waitFor()
    await page.getByTestId('tree-group--trigger').click()
    await page.getByTestId('tree-trigger-orders_touch_user').waitFor()
    // Expanding a table fetches its columns.
    await page.getByTestId('tree-table-orders').locator('.tree-toggle').click()
    await page.locator('.tree-col .col-name', { hasText: 'status' }).first().waitFor()

    // ------------------------------------------------------------ table browsing
    await page.getByTestId('tree-table-users').click()
    const grid = page.getByTestId('table-grid')
    await grid.locator('tbody tr').first().waitFor({ timeout: 20000 })
    const tableTab = page.locator('.tab-pane:not([hidden]) .table-tab')
    // Runs fn, then waits until the visible table tab has completed one more row load.
    const afterReload = async (fn) => {
      const before = Number(await tableTab.getAttribute('data-loads'))
      await fn()
      await page.waitForFunction(
        (b) => Number(document.querySelector('.tab-pane:not([hidden]) .table-tab')?.getAttribute('data-loads')) > b,
        before,
        { timeout: 20000 }
      )
    }
    const rowCount = await grid.locator('tbody tr').count()
    assert(rowCount === 60, `users grid shows 60 rows (got ${rowCount})`)
    assert((await page.getByTestId('pager-label').textContent()).includes('1–60 of 60'), 'pager label')
    await grid.locator('td[data-r="0"][data-c="1"]').click()
    await page.locator('.toolbar button[title="Toggle cell inspector"]').click()
    await page.getByTestId('inspector').waitFor()
    await shot('03-table-users')
    await page.locator('.toolbar button[title="Toggle cell inspector"]').click()

    // Sort by clicking the header
    await afterReload(() => grid.locator('thead th', { hasText: 'age' }).click())
    assert((await grid.locator('thead th.sorted').count()) === 1, 'sorted column is marked')

    // Filter
    const where = page.getByTestId('where-input')
    await afterReload(async () => {
      await where.fill('is_admin = 1')
      await where.press('Enter')
    })
    const filteredLabel = (await page.getByTestId('pager-label').textContent()).trim()
    assert(filteredLabel === '1–6 of 6', `pager shows the filtered count (got "${filteredLabel}")`)
    const filtered = await grid.locator('tbody tr').count()
    assert(filtered === 6, `filter narrows to 6 admins (got ${filtered})`)
    await afterReload(async () => {
      await where.fill('')
      await where.press('Enter')
    })
    assert((await page.getByTestId('pager-label').textContent()).includes('of 60'), 'filter cleared')

    // Bad filter shows an error banner
    await afterReload(async () => {
      await where.fill('nonsense === 1')
      await where.press('Enter')
    })
    await page.locator('.banner.error').waitFor()
    await afterReload(async () => {
      await where.fill('')
      await where.press('Enter')
    })
    assert((await page.locator('.banner.error').count()) === 0, 'error banner cleared')

    // ------------------------------------------------------------ editing
    await afterReload(() => grid.locator('thead th', { hasText: 'age' }).click()) // desc
    await afterReload(() => grid.locator('thead th', { hasText: 'age' }).click()) // off -> default order
    assert((await grid.locator('thead th.sorted').count()) === 0, 'sort cleared')
    await grid.locator('td[data-r="0"][data-c="1"]').waitFor()
    const originalName = await grid.locator('td[data-r="0"][data-c="1"]').textContent()
    await grid.locator('td[data-r="0"][data-c="1"]').dblclick()
    const editor = grid.locator('textarea.cell-editor')
    await editor.waitFor()
    await editor.fill('Edited via GUI')
    await editor.press('Enter')
    await grid.locator('td[data-r="0"][data-c="1"].cell-dirty').waitFor()
    // Stage a NULL via keyboard on the email column of row 2
    await grid.locator('td[data-r="1"][data-c="2"]').click()
    await page.keyboard.press(`${mod}+Backspace`)
    await grid.locator('td[data-r="1"][data-c="2"].cell-dirty.cell-null').waitFor()
    // Add a row and fill its name
    await page.getByTestId('add-row').click()
    await grid.locator('tr.row-new').waitFor()
    await grid.locator('tr.row-new td[data-c="1"]').dblclick()
    await grid.locator('textarea.cell-editor').fill('Brand New Person')
    await grid.locator('textarea.cell-editor').press('Enter')
    // Mark row 3 for deletion
    await grid.locator('td[data-r="2"][data-c="0"]').click()
    await page.getByTestId('delete-row').click()
    await grid.locator('tr.row-deleted').waitFor()
    await shot('04-table-pending-edits')
    const applyText = await page.getByTestId('apply-button').textContent()
    assert(applyText.includes('Apply 4'), `apply button counts 4 changes (got "${applyText}")`)
    await page.getByTestId('apply-button').click()
    await page.getByTestId('confirm-dialog').waitFor()
    await afterReload(() => page.getByTestId('confirm-ok').click())
    await page.locator('.toast.success', { hasText: 'Applied 4 changes' }).waitFor({ timeout: 20000 })
    assert((await grid.locator('td[data-r="0"][data-c="1"]').textContent()) === 'Edited via GUI', 'grid shows the applied edit')
    assert(sqlite(db, 'SELECT name FROM users WHERE id = 1') === 'Edited via GUI', 'update reached the database file')
    assert(sqlite(db, 'SELECT email IS NULL FROM users WHERE id = 2') === '1', 'NULL reached the database file')
    assert(sqlite(db, "SELECT count(*) FROM users WHERE name = 'Brand New Person'") === '1', 'insert reached the database file')
    assert(sqlite(db, 'SELECT count(*) FROM users WHERE id = 3') === '0', 'delete reached the database file')
    console.log(`edits applied (renamed "${originalName}")`)

    // ------------------------------------------------------------ structure view
    await page.getByTestId('structure-toggle').click()
    await page.getByTestId('structure-view').waitFor()
    await page.locator('.struct-sql .cm-content').first().waitFor()
    await shot('05-structure')
    assert((await page.getByTestId('structure-view').textContent()).includes('PRIMARY KEY') || (await page.getByTestId('structure-view').textContent()).includes('PK'), 'structure shows the primary key')

    // ------------------------------------------------------------ query tab
    await page.getByTestId('new-query-tab').click()
    const cm = page.locator('.tab-pane:not([hidden]) .query-tab .cm-content')
    await cm.waitFor()
    // The chat beside the editor: without a configured provider it offers Settings, and it collapses out of the way.
    await page.getByTestId('ask-panel').waitFor()
    assert((await page.getByTestId('ask-needs-key').count()) === 1, 'chat offers to set up a provider')
    await page.getByTestId('ask-input').fill('how many users are admins')
    await page.getByTestId('ask-button').click()
    await page.getByTestId('settings-dialog').waitFor()
    assert((await page.getByTestId('ai-provider').inputValue()) === 'openai', 'settings default to OpenAI')
    await page.getByTestId('ai-provider').selectOption('ollama')
    assert((await page.getByTestId('ai-base-url').inputValue()) === 'http://localhost:11434/v1', 'switching provider applies its preset')
    await shot('06a-ask-needs-key')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-testid=settings-dialog]'))
    await page.getByTestId('ask-collapse').click()
    await page.waitForFunction(() => !document.querySelector('[data-testid=ask-panel]'))
    await page.getByTestId('ask-strip').waitFor()
    await shot('06b-ask-collapsed')
    await page.getByTestId('ask-strip').click()
    await page.getByTestId('ask-panel').waitFor()
    await page.getByTestId('ask-toggle').click()
    await page.waitForFunction(() => !document.querySelector('[data-testid=ask-panel]'))
    await page.getByTestId('ask-toggle').click()
    await page.getByTestId('ask-input').waitFor()
    // Panes rearrange by dragging their headers: drop the chat on the left edge of the editor.
    const boxOf = async (id) => await page.getByTestId(id).boundingBox()
    let [askBox, editorBox] = [await boxOf('ask-panel'), await boxOf('pane-editor')]
    assert(askBox.x > editorBox.x, 'chat starts to the right of the editor')
    await page.getByTestId('ask-header').dragTo(page.getByTestId('pane-editor'), { targetPosition: { x: 12, y: 80 } })
    await page.waitForFunction(() => {
      const a = document.querySelector('[data-testid=ask-panel]').getBoundingClientRect()
      const e = document.querySelector('[data-testid=pane-editor]').getBoundingClientRect()
      return a.x < e.x
    })
    await shot('06c-ask-moved')
    // Drop the results on the top edge of the editor, then reset.
    await page.getByTestId('results-header').dragTo(page.getByTestId('pane-editor'), { targetPosition: { x: 200, y: 8 } })
    await page.waitForFunction(() => {
      const r = document.querySelector('[data-testid=pane-results]').getBoundingClientRect()
      const e = document.querySelector('[data-testid=pane-editor]').getBoundingClientRect()
      return r.y < e.y
    })
    await page.getByTestId('layout-reset').click()
    await page.waitForFunction(() => {
      const a = document.querySelector('[data-testid=ask-panel]').getBoundingClientRect()
      const e = document.querySelector('[data-testid=pane-editor]').getBoundingClientRect()
      const r = document.querySelector('[data-testid=pane-results]').getBoundingClientRect()
      return a.x > e.x && r.y > e.y
    })
    ;[askBox, editorBox] = [await boxOf('ask-panel'), await boxOf('pane-editor')]
    assert(askBox.x > editorBox.x, 'reset puts the chat back to the right')
    // Model picker under the chat input: unconfigured models explain what to set up.
    await page.getByTestId('model-button').click()
    await page.getByTestId('model-menu').waitFor()
    await page.waitForTimeout(200)
    assert((await page.getByTestId('model-button').textContent()).includes('GPT-5.4 mini'), 'the picker shows the model title, not its id')
    {
      const [vw, vh] = await page.evaluate(() => [window.innerWidth, window.innerHeight])
      const mb = await page.getByTestId('model-menu').boundingBox()
      assert(mb.x >= 0 && mb.y >= 0 && mb.x + mb.width <= vw && mb.y + mb.height <= vh, 'the model menu stays inside the window')
    }
    await shot('06e-model-menu')
    await page.getByTestId('model-claude-sonnet-5').click()
    await page.getByTestId('model-notice').waitFor()
    await shot('06f-model-notice')
    assert((await page.getByTestId('model-notice').textContent()).includes('Anthropic'), 'the notice names the provider to set up')
    await page.getByTestId('model-notice-settings').click()
    await page.getByTestId('settings-dialog').waitFor()
    assert((await page.getByTestId('ai-provider').inputValue()) === 'anthropic', 'settings open on the picked provider')
    assert((await page.getByTestId('ai-model').inputValue()) === 'claude-sonnet-5', 'settings open with the picked model')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-testid=settings-dialog]'))

    // Autocomplete: table names while typing, and a table's columns after its name (fetched on demand).
    await cm.click()
    await page.keyboard.type('SELECT * FROM us')
    await page.locator('.cm-tooltip-autocomplete li', { hasText: 'users' }).first().waitFor({ timeout: 5000 })
    await page.keyboard.press('Escape')
    await page.keyboard.press(`${mod}+A`)
    await page.keyboard.press('Backspace')
    await page.keyboard.type('SELECT * FROM orders WHERE orders.')
    await page.locator('.cm-tooltip-autocomplete li', { hasText: 'status' }).first().waitFor({ timeout: 10000 })
    await shot('06d-autocomplete')
    await page.keyboard.press('Escape')
    await page.keyboard.press(`${mod}+A`)
    await page.keyboard.press('Backspace')
    await page.keyboard.type('SELECT id, name, email, balance FROM users ORDER BY id LIMIT 5;\nSELECT count(*) AS orders FROM orders;')
    await page.keyboard.press(`${mod}+Enter`)
    await page.getByTestId('results').waitFor({ timeout: 20000 })
    await page.locator('.result-chips .chip').nth(1).waitFor()
    // The last SELECT is shown by default; switch to the first one.
    await page.locator('.result-chips .chip').first().click()
    const resultGrid = page.getByTestId('result-grid')
    await resultGrid.locator('tbody tr').first().waitFor()
    const resultRows = await resultGrid.locator('tbody tr').count()
    assert(resultRows === 5, `query result has 5 rows (got ${resultRows})`)
    assert((await resultGrid.locator('td[data-r="0"][data-c="1"]').textContent()) === 'Edited via GUI', 'query sees the applied edit')
    // Query results show a type glyph per column, inferred from the values for SQLite.
    await resultGrid.locator('thead .th-type').first().waitFor()
    assert((await resultGrid.locator('thead .th-type').first().getAttribute('title')).includes('from the values'), 'result glyphs say the type was inferred')
    await shot('06-query')

    // Error handling
    await cm.click()
    await page.keyboard.press(`${mod}+A`)
    await page.keyboard.type('SELECT * FROM does_not_exist;')
    await page.keyboard.press(`${mod}+Enter`)
    await page.getByTestId('error-message').waitFor({ timeout: 20000 })
    assert((await page.getByTestId('error-message').textContent()).includes('no such table'), 'SQL error is shown')

    // DDL refreshes the schema tree
    await page.keyboard.press(`${mod}+A`)
    await page.keyboard.type('CREATE TABLE e2e_created (id INTEGER PRIMARY KEY, note TEXT);')
    await page.keyboard.press(`${mod}+Enter`)
    await page.getByTestId('exec-message').waitFor({ timeout: 20000 })
    await page.getByTestId('tree-table-e2e_created').waitFor({ timeout: 20000 })

    // Cancel a long query
    await page.keyboard.press(`${mod}+A`)
    await page.keyboard.type('WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c) SELECT count(*) FROM c;')
    await page.keyboard.press(`${mod}+Enter`)
    await page.getByTestId('stop-button').waitFor()
    await page.waitForTimeout(300)
    await page.getByTestId('stop-button').click()
    await page.getByTestId('error-message').waitFor({ timeout: 20000 })
    assert((await page.getByTestId('error-message').textContent()).includes('interrupted'), 'cancelled query reports interruption')

    // ------------------------------------------------------------ disconnect
    await page.getByTestId('disconnect-button').click()
    await page.getByTestId('connect-button').waitFor()
    assert((await page.locator('.conn-item').count()) === 2, 'both connections were saved')
    await shot('07-back-to-connections')

    // ------------------------------------------------------------ a new connection reuses the saved SSH profile
    await page.getByTestId('new-connection').click()
    await page.getByTestId('choose-sqlite').click()
    await page.getByPlaceholder('Production analytics').fill('E2E via profile')
    // Groups are made from the form: pick "New group" and type a name.
    await page.getByTestId('conn-group').selectOption('__new__')
    await page.getByTestId('conn-group-name').fill('Acme')
    await page.getByTestId('sqlite-remote').check()
    await page.getByTestId('ssh-profile-select').selectOption({ label: 'E2E SSH' })
    await page.getByTestId('ssh-profile-summary').waitFor()
    assert((await page.getByPlaceholder('db.example.com').count()) === 0, 'a chosen profile hides the SSH fields')
    await page.getByTestId('sqlite-path').fill(db)
    await shot('07a-connect-via-profile')
    await page.getByTestId('connect-button').click()
    await page.getByTestId('tree-table-users').waitFor({ timeout: 30000 })
    console.log('connected through the saved SSH profile')
    await page.getByTestId('disconnect-button').click()
    await page.getByTestId('new-connection').waitFor()

    // ------------------------------------------------------------ grouped connections sit under a collapsible header
    const acme = page.locator('[data-testid=conn-group-header]', { hasText: 'Acme' })
    await acme.waitFor()
    assert((await acme.locator('.count').textContent()) === '1', 'the group counts its connections')
    assert((await page.getByTestId('conn-group').locator('option:checked').textContent()) === 'Acme', 'the form shows which group the connection is in')
    await acme.click()
    await page.waitForFunction(() => document.querySelectorAll('[data-group="Acme"] .conn-item').length === 0)
    await acme.click()
    await page.locator('[data-group="Acme"] .conn-item').first().waitFor()
    await shot('07c-connection-groups')
    // Renaming from the header's menu moves every member.
    await acme.click({ button: 'right' })
    await page.getByText('Rename group…').click()
    await page.getByTestId('conn-group-rename').fill('Acme Corp')
    await page.keyboard.press('Enter')
    await page.locator('[data-group="Acme Corp"] .conn-item').first().waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid=conn-group]')?.value === 'Acme Corp')
    console.log('connection groups work')

    // ------------------------------------------------------------ duplicating a connection copies everything but the name
    const viaProfile = page.locator('.conn-item', { hasText: 'E2E via profile' }).first()
    await viaProfile.hover()
    await viaProfile.getByTestId('conn-duplicate').click()
    await page.locator('.conn-item', { hasText: 'E2E via profile copy' }).waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid=conn-name]')?.value === 'E2E via profile copy')
    assert((await page.getByTestId('conn-group').locator('option:checked').textContent()) === 'Acme Corp', 'the copy keeps the group')
    await page.getByTestId('ssh-profile-summary').waitFor()
    assert((await page.locator('[data-group="Acme Corp"] .conn-item').count()) === 2, 'the copy sits in the same group')
    console.log('duplicated a connection')

    // ------------------------------------------------------------ a restart still shows which profile the connection uses
    await app.close()
    app = await electron.launch(launchOptions)
    page = await app.firstWindow()
    watchConsole()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('ssh-profile-summary').waitFor({ timeout: 15000 })
    assert((await page.getByTestId('conn-name').inputValue()) === 'E2E via profile', 'the most recent connection opens after a restart')
    assert((await page.getByTestId('ssh-profile-select').locator('option:checked').textContent()) === 'E2E SSH', 'the connection still points at its SSH profile after a restart')
    assert((await page.getByTestId('conn-group').locator('option:checked').textContent()) === 'Acme Corp', 'the connection keeps its group after a restart')
    await shot('07b-profile-after-restart')
    console.log('profile remembered across a restart')

    // ------------------------------------------------------------ PostgreSQL (when a server is available)
    if (process.env.PG_URL) {
      const pgUrl = process.env.PG_URL
      await loadFixture(pgUrl)
      const u = new URL(pgUrl)
      await page.getByTestId('new-connection').click()
      await page.getByTestId('choose-postgres').click()
      await page.getByTestId('conn-name').fill('E2E Postgres')
      await page.getByTestId('pg-host').fill(u.hostname)
      await page.getByTestId('pg-port').fill(u.port || '5432')
      await page.getByTestId('pg-database').fill(u.pathname.replace(/^\//, ''))
      await page.getByTestId('pg-user').fill(decodeURIComponent(u.username))
      await page.getByTestId('pg-password').fill(decodeURIComponent(u.password))
      await page.getByTestId('pg-ssl').selectOption('disable')
      await shot('08-postgres-connect')
      await page.getByTestId('connect-button').click()
      await page.getByTestId('tree-table-users').waitFor({ timeout: 30000 })
      assert((await page.getByTestId('tree-table-analytics.daily_totals').count()) === 1, 'second schema is listed')
      console.log('postgres connected; schema loaded')
      // Functions are listed per schema and open their definition in a query tab.
      await page.getByTestId('tree-group-public-function').click()
      await page.getByTestId('tree-function-order_total').waitFor()
      await page.getByTestId('tree-function-archive_orders').waitFor()
      await page.getByTestId('tree-function-order_total').click()
      await page.locator('.tab-pane:not([hidden]) .query-tab .cm-content').waitFor()
      assert((await page.locator('.tab-pane:not([hidden]) .query-tab .cm-content').textContent()).includes('CREATE OR REPLACE FUNCTION'), 'function definition opens in a query tab')
      await shot('08a-postgres-function')

      await page.getByTestId('tree-table-users').click()
      const pgGrid = page.getByTestId('table-grid')
      await pgGrid.locator('tbody tr').first().waitFor({ timeout: 20000 })
      assert((await pgGrid.locator('tbody tr').count()) === 60, 'postgres users grid shows 60 rows')
      assert((await page.getByTestId('pager-label').textContent()).includes('1–60 of 60'), 'postgres pager label')
      const pgTab = page.locator('.tab-pane:not([hidden]) .table-tab')
      const afterPgReload = async (fn) => {
        const before = Number(await pgTab.getAttribute('data-loads'))
        await fn()
        await page.waitForFunction(
          (b) => Number(document.querySelector('.tab-pane:not([hidden]) .table-tab')?.getAttribute('data-loads')) > b,
          before,
          { timeout: 20000 }
        )
      }
      await afterPgReload(() => pgGrid.locator('thead th', { hasText: 'id' }).first().click())
      // name is column index 1
      await pgGrid.locator('td[data-r="0"][data-c="1"]').dblclick()
      await pgGrid.locator('textarea.cell-editor').fill('Edited PG via GUI')
      await pgGrid.locator('textarea.cell-editor').press('Enter')
      await pgGrid.locator('td[data-r="0"][data-c="1"].cell-dirty').waitFor()
      await shot('09-postgres-table')
      await page.getByTestId('apply-button').click()
      await page.getByTestId('confirm-dialog').waitFor()
      await afterPgReload(() => page.getByTestId('confirm-ok').click())
      await page.locator('.toast.success', { hasText: 'Applied 1 change' }).waitFor({ timeout: 20000 })
      const check = new pg.Client({ connectionString: pgUrl })
      await check.connect()
      const r = await check.query('SELECT name FROM users WHERE id = 1')
      await check.end()
      assert(r.rows[0].name === 'Edited PG via GUI', 'postgres edit reached the server')

      await page.getByTestId('new-query-tab').click()
      const pgCm = page.locator('.tab-pane:not([hidden]) .query-tab .cm-content')
      await pgCm.waitFor()
      await pgCm.click()
      await page.keyboard.type('SELECT id, name, balance, is_admin, tags FROM users ORDER BY id LIMIT 3;')
      await page.keyboard.press(`${mod}+Enter`)
      const pgResult = page.getByTestId('result-grid')
      await pgResult.locator('tbody tr').first().waitFor({ timeout: 20000 })
      assert((await pgResult.locator('tbody tr').count()) === 3, 'postgres query result has 3 rows')
      assert((await pgResult.locator('td[data-r="0"][data-c="3"]').textContent()) === 'false', 'boolean renders as false')
      await shot('10-postgres-query')
      await page.getByTestId('disconnect-button').click()
      await page.getByTestId('connect-button').waitFor()
      assert((await page.locator('.conn-item').count()) === 5, 'postgres connection was saved')
      console.log('postgres flow passed')
    } else {
      console.log('PG_URL not set; skipping the PostgreSQL flow')
    }

    const realErrors = consoleErrors.filter((e) => !/Autofill|DevTools/.test(e))
    if (realErrors.length) {
      console.log('Renderer console errors:\n' + realErrors.join('\n'))
      throw new Error('renderer logged errors')
    }
    console.log('E2E passed. Screenshots in', artifacts)
  } catch (err) {
    await shot('99-failure').catch(() => {})
    throw err
  } finally {
    await app.close().catch(() => {})
    await server.close()
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
