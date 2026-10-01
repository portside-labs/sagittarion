// End-to-end test: drives the built Electron app with Playwright against the
// mock SSH server. Run with `npm run test:e2e`. Screenshots land in
// test/e2e/artifacts/.
import { _electron as electron } from 'playwright'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
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
    // On Linux without a keyring (CI) saved passwords would otherwise be dropped, which a desktop keyring prevents.
    env: { ...process.env, SAGITTARION_USER_DATA: userData, NODE_ENV: 'production', SAGITTARION_TEST_PLAINTEXT_SECRETS: '1' }
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
    assert((await page.getByTestId('settings-appearance').count()) === 1, 'settings open on the Appearance tab')
    assert((await page.locator('.settings-nav-item').allTextContents()).map((s) => s.trim()).join(', ') === 'Appearance, Connectors, Editor, Instructions, Models', 'settings sections are listed alphabetically')
    await page.getByTestId('settings-tab-models').click()
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
    // A second connection opens from the "+" tab while the first stays connected.
    await page.getByTestId('conn-tab-add').click()
    await page.getByTestId('new-connection').waitFor()
    // Each saved connection is one line, logo and name; the one in use has its logo ringed.
    assert((await page.locator('.conn-item.link-up .conn-name').allTextContents()).join() === 'E2E local file', 'the list rings the connection in use')
    assert((await page.locator('.conn-item', { hasText: 'E2E local file' }).locator('.conn-kind img[alt=SQLite]').count()) === 1, 'the list shows the database logo')

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
    const front = (testId) => page.locator(`.session-slot:not([hidden]) [data-testid=${testId}]`)
    // The chat sits beside the connections, outside any one's view.
    const chatEl = (testId) => page.locator(`[data-testid=chat-pane] [data-testid=${testId}]`)
    /** Another answer has come, and finished unfolding. */
    const answered = async (before) => {
      await page.waitForFunction((n) => document.querySelectorAll('[data-testid=chat-pane] [data-testid=ask-result]').length > n, before, { timeout: 30000 })
      await page.waitForFunction(() => !document.querySelector('[data-testid=chat-pane] .chat-markdown.writing'), null, { timeout: 15000 })
    }
    const theme = () => page.evaluate(() => [document.documentElement.dataset.theme, getComputedStyle(document.body).backgroundColor].join(' '))
    const pickTheme = async (id) => {
      await front('open-settings').click()
      await page.getByTestId('settings-dialog').waitFor()
      await page.getByTestId('settings-tab-appearance').click()
      await page.getByTestId(`theme-${id}`).click()
      await page.waitForFunction((t) => document.documentElement.dataset.theme === t, id)
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.querySelector('[data-testid=settings-dialog]'))
    }
    await front('tree-table-users').waitFor({ timeout: 30000 })
    console.log('connected; schema loaded')

    // ------------------------------------------------------------ two connections open at once
    assert((await page.getByTestId('conn-tab').count()) === 2, 'both connections have a tab')
    await page.getByTestId('conn-tab').first().click()
    await page.waitForFunction(() => document.querySelector('.session-slot:not([hidden]) .statusbar')?.textContent.includes('This computer'))
    await shot('01c-two-connections')
    await page.getByTestId('conn-tab').nth(1).click()
    await page.waitForFunction(() => !document.querySelector('.session-slot:not([hidden]) .statusbar')?.textContent.includes('This computer'))
    // Appearance settings move the tabs to a rail down the left, and back.
    await front('open-settings').click()
    await page.getByTestId('settings-dialog').waitFor()
    await page.getByTestId('settings-tab-appearance').click()
    await page.getByTestId('connection-tabs-mode').getByRole('button', { name: 'Vertical' }).click()
    await page.locator('.app-shell.tabs-vertical .conn-rail').waitFor()
    assert((await page.locator('.conn-rail [data-testid=conn-tab]').count()) === 2, 'the rail lists both connections')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-testid=settings-dialog]'))
    await shot('01d-vertical-tabs')
    await front('open-settings').click()
    await page.getByTestId('settings-dialog').waitFor()
    await page.getByTestId('connection-tabs-mode').getByRole('button', { name: 'Horizontal' }).click()
    await page.locator('.app-shell.tabs-horizontal .conn-tabs').waitFor()
    // The theme recolours the window as soon as it is picked, and back.
    assert((await theme()) === 'charcoal rgb(15, 15, 15)', `the window starts in Charcoal, neutral black (${await theme()})`)
    await page.getByTestId('theme-cobalt').click()
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'cobalt')
    assert((await theme()) === 'cobalt rgb(24, 25, 28)', `Cobalt is a lighter, blue-cast grey (${await theme()})`)
    assert((await page.getByTestId('theme-cobalt').getAttribute('aria-pressed')) === 'true', 'the chosen theme is marked')
    await shot('01e-cobalt-settings')
    await page.getByTestId('theme-charcoal').click()
    assert((await theme()) === 'charcoal rgb(15, 15, 15)', 'back to Charcoal')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-testid=settings-dialog]'))
    // Closing the first connection's tab leaves the second one open and in front.
    await page.getByTestId('conn-tab').first().hover()
    await page.getByTestId('conn-tab').first().getByTestId('conn-tab-close').click()
    await page.waitForFunction(() => document.querySelectorAll('[data-testid=conn-tab]').length === 1)
    await front('tree-table-users').waitFor()
    console.log('two connections open at once; switched, restyled and closed one')
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
    // The filter applies on a deferred render, so wait for the non-match to go rather than count at once.
    await page.waitForFunction(() => !document.querySelector('[data-testid=tree-table-users]'))
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

    // ------------------------------------------------------------ selecting cells and copying them
    const cellAt = (r, c) => grid.locator(`td[data-r="${r}"][data-c="${c}"]`)
    const centre = async (loc) => {
      const b = await loc.boundingBox()
      return [b.x + b.width / 2, b.y + b.height / 2]
    }
    // What an action puts on the clipboard; the renderer writes it asynchronously, so wait for it to land.
    const copiedBy = async (action) => {
      await app.evaluate(({ clipboard }) => clipboard.writeText(''))
      await action()
      for (let i = 0; i < 100; i++) {
        const text = await app.evaluate(({ clipboard }) => clipboard.readText())
        if (text) return text
        await page.waitForTimeout(50)
      }
      return ''
    }
    const inRange = () => grid.locator('td.cell-in-range').count()
    // A drag from one cell to another selects the rectangle between them, and copies as tab-separated lines.
    await page.mouse.move(...(await centre(cellAt(0, 0))))
    await page.mouse.down()
    await page.mouse.move(...(await centre(cellAt(2, 1))), { steps: 6 })
    await page.mouse.up()
    assert((await inRange()) === 6, `a drag selects the 3 × 2 rectangle (got ${await inRange()})`)
    await grid.screenshot({ path: path.join(artifacts, '03c-range-selection.png') })
    let copied = await copiedBy(() => page.keyboard.press(`${mod}+c`))
    const rectangle = []
    for (const r of [0, 1, 2]) rectangle.push(`${await cellAt(r, 0).textContent()}\t${await cellAt(r, 1).textContent()}`)
    assert(copied === rectangle.join('\n'), `the selection is copied as tab-separated lines (got ${JSON.stringify(copied)})`)
    assert((await front('status-link').count()) === 0 && (await page.locator('.session-slot:not([hidden]) .statusbar').textContent()).includes('Copied 6 values'), 'the status bar says what was copied')
    // Shift+click stretches it; Shift+arrows move its far corner.
    await cellAt(3, 2).click({ modifiers: ['Shift'] })
    assert((await inRange()) === 12, 'Shift+click stretches it to 4 × 3')
    await page.keyboard.press('Shift+ArrowDown')
    await page.keyboard.press('Shift+ArrowRight')
    assert((await inRange()) === 20, 'Shift+arrows grow it to 5 × 4')
    // A row number selects its whole row, and the modifier adds another.
    const columnCount = (await grid.locator('thead th').count()) - 1
    await grid.locator('tbody tr').nth(4).locator('td.rownum').click()
    assert((await inRange()) === columnCount, 'a row number selects its whole row')
    await grid.locator('tbody tr').nth(6).locator('td.rownum').click({ modifiers: [mod] })
    assert((await inRange()) === columnCount * 2, 'the modifier adds a second row')
    // A right-click inside the selection keeps it; Copy with column names puts the header line first.
    await cellAt(6, 1).click({ button: 'right' })
    copied = await copiedBy(() => page.locator('.context-menu-item', { hasText: 'Copy with column names' }).click())
    const names = await grid.locator('thead th .th-name').allTextContents()
    assert(copied.startsWith(names.join('\t') + '\n'), `column names come first (got ${JSON.stringify(copied.slice(0, 80))})`)
    for (const r of [4, 6]) assert(copied.includes(`\t${await cellAt(r, 1).textContent()}\t`), `row ${r + 1} is in the copy`)
    assert(!copied.includes(`\t${await cellAt(5, 1).textContent()}\t`), 'the row between them is not')
    // Copy as SQL list: part of a column, one quoted value per line, ready for WHERE … IN ( … ).
    await cellAt(0, 1).click()
    await cellAt(2, 1).click({ modifiers: ['Shift'] })
    const listed = []
    for (const r of [0, 1, 2]) listed.push(`'${(await cellAt(r, 1).textContent()).replace(/'/g, "''")}'`)
    copied = await copiedBy(() => page.keyboard.press(`${mod}+Alt+c`))
    assert(copied === listed.join(',\n'), `the shortcut copies a SQL list (got ${JSON.stringify(copied)})`)
    assert((await page.locator('.session-slot:not([hidden]) .statusbar').textContent()).includes('Copied 3 values as a SQL list'), 'the status bar says how it was copied')
    await cellAt(1, 1).click({ button: 'right' })
    copied = await copiedBy(() => page.locator('.context-menu-item', { hasText: 'Copy as SQL list' }).click())
    assert(copied === listed.join(',\n'), 'so does the context menu')
    // The keyboard is back with the grid: select everything, then nothing.
    await page.keyboard.press(`${mod}+a`)
    assert((await inRange()) === 60 * columnCount, 'select all covers every loaded row')
    await page.keyboard.press('Escape')
    assert((await grid.locator('td.cell-in-range, td.cell-selected').count()) === 0, 'Escape clears the selection')
    console.log('grid cells select like a spreadsheet and copy as tab-separated text')

    // ------------------------------------------------------------ the link drops while idle
    // The SSH server ends the connection, as an idle one gets ended: the tab stays where it is, with a toast.
    server.dropClients()
    await page.locator('.toast.warn', { hasText: 'E2E mock host disconnected' }).waitFor({ timeout: 20000 })
    await page.waitForFunction(() => document.querySelector('[data-testid=conn-tab]')?.getAttribute('data-link') === 'down')
    assert((await page.locator('.connect-screen').count()) === 0, 'a dropped connection does not go back to the connection list')
    assert(await grid.locator('tbody tr').first().isVisible(), 'the table tab stays as it was')
    assert((await front('status-link').textContent()).includes('Disconnected'), 'the status bar says the connection is down')
    await page.waitForTimeout(300) // the toast's entrance
    await shot('03b-link-dropped')
    // The next thing that needs the database reconnects, on the same tab.
    await afterReload(() => grid.locator('thead th', { hasText: 'age' }).click())
    await page.waitForFunction(() => document.querySelector('[data-testid=conn-tab]')?.getAttribute('data-link') === 'up')
    assert((await grid.locator('tbody tr').count()) === 60, 'rows load again after reconnecting')
    assert((await page.locator('.banner.error').count()) === 0, 'the reload after the drop succeeds')
    assert((await front('status-link').count()) === 0, 'the status bar no longer says disconnected')
    await page.waitForFunction(() => !document.querySelector('.toast.warn'))
    // Sorted descending by the reconnecting click; two more bring back the ascending sort the next steps start from.
    await afterReload(() => grid.locator('thead th', { hasText: 'age' }).click())
    await afterReload(() => grid.locator('thead th', { hasText: 'age' }).click())
    console.log('dropped link: stayed on the tab, toasted, reconnected on the next action')

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
    // The chat sits beside the connection, outside its view: without a configured provider it offers Settings, and it
    // folds out of the way.
    await page.getByTestId('chat-pane').waitFor()
    assert((await page.locator('.session-slot [data-testid=ask-panel]').count()) === 0, 'the chat is not part of the connection view')
    assert((await page.getByTestId('ask-needs-key').count()) === 1, 'chat offers to set up a provider')
    await page.getByTestId('ask-input').fill('how many users are admins')
    await page.getByTestId('ask-button').click()
    await page.getByTestId('settings-dialog').waitFor()
    assert((await page.getByTestId('ai-provider').inputValue()) === 'openai', 'settings default to OpenAI with your own key')
    assert((await page.getByTestId('ai-type-managed').count()) === 0, 'Managed AI is hidden until it is available')
    assert((await page.getByTestId('ai-types').locator('.ai-type-account').count()) === 0, 'without Managed AI the tiles leave out whether an account is needed')
    const tiles = await page.getByTestId('ai-types').evaluate((row) => ({ row: row.clientWidth, widths: [...row.children].map((t) => t.getBoundingClientRect().width) }))
    assert(tiles.widths.length === 2 && Math.abs(tiles.widths[0] - tiles.widths[1]) < 1 && tiles.widths[0] > tiles.row / 2 - 8, 'the two kinds of connection share the row equally')
    await page.getByTestId('ai-type-local').click()
    assert((await page.getByTestId('ai-local-type').inputValue()) === 'ollama', 'local servers default to Ollama')
    assert((await page.getByTestId('ai-base-url').inputValue()) === 'http://localhost:11434/v1', 'switching to a local server applies its preset')
    await shot('06a-ask-needs-key')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-testid=settings-dialog]'))
    await page.getByTestId('ask-collapse').click()
    await page.waitForFunction(() => document.querySelector('[data-testid=chat-pane]')?.hidden === true)
    await page.getByTestId('ask-strip').waitFor()
    await shot('06b-ask-collapsed')
    await page.getByTestId('ask-strip').click()
    await page.getByTestId('ask-input').waitFor()
    // The query tab's panes rearrange by dragging their headers: drop the results on the right edge of the editor, then reset.
    const boxOf = async (id) => await page.getByTestId(id).boundingBox()
    let [askBox, editorBox] = [await boxOf('ask-panel'), await boxOf('pane-editor')]
    assert(askBox.x >= editorBox.x + editorBox.width, 'the chat is to the right of the editor')
    await page.getByTestId('results-header').dragTo(page.getByTestId('pane-editor'), { targetPosition: { x: editorBox.width - 12, y: 80 } })
    await page.waitForFunction(() => {
      const r = document.querySelector('[data-testid=pane-results]').getBoundingClientRect()
      const e = document.querySelector('[data-testid=pane-editor]').getBoundingClientRect()
      return r.x > e.x
    })
    await shot('06c-panes-moved')
    await page.getByTestId('layout-reset').click()
    await page.waitForFunction(() => {
      const e = document.querySelector('[data-testid=pane-editor]').getBoundingClientRect()
      const r = document.querySelector('[data-testid=pane-results]').getBoundingClientRect()
      return r.y > e.y
    })
    ;[askBox, editorBox] = [await boxOf('ask-panel'), await boxOf('pane-editor')]
    assert(askBox.x >= editorBox.x + editorBox.width, 'the chat stays to the right')
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
    // Query results select and copy the same way: all of it, with column names.
    await resultGrid.locator('td[data-r="0"][data-c="0"]').click()
    await page.keyboard.press(`${mod}+a`)
    assert((await resultGrid.locator('td.cell-in-range').count()) === 20, 'select all covers the 5 × 4 result')
    const resultCopy = (await copiedBy(() => page.keyboard.press(`${mod}+Shift+c`))).split('\n')
    assert(resultCopy[0] === 'id\tname\temail\tbalance', `column names head the copied result (got ${JSON.stringify(resultCopy[0])})`)
    assert(resultCopy.length === 6 && resultCopy[1].startsWith('1\tEdited via GUI\t'), `a line per row follows (got ${JSON.stringify(resultCopy)})`)
    // Results do not sort, so a click on a column header selects the column.
    await resultGrid.locator('thead th', { hasText: 'name' }).click()
    assert((await resultGrid.locator('td.cell-in-range').count()) === 5, 'a header click selects the column of a result')
    await page.keyboard.press('Escape')
    // Query results show a type glyph per column, inferred from the values for SQLite.
    await resultGrid.locator('thead .th-type').first().waitFor()
    assert((await resultGrid.locator('thead .th-type').first().getAttribute('title')).includes('from the values'), 'result glyphs say the type was inferred')
    await shot('06-query')
    // The link drops with a query tab open: the status dot turns red, and running the query again reconnects on its
    // own and shows the results.
    const statusDot = page.locator('.session-slot:not([hidden]) [data-testid=status-dot]')
    const queryRuns = () => page.locator('.tab-pane:not([hidden]) .query-tab').getAttribute('data-runs').then(Number)
    assert((await statusDot.getAttribute('data-state')) === 'connected' && (await statusDot.evaluate((el) => el.classList.contains('ok'))), 'the status dot is green while connected')
    const runsBefore = await queryRuns()
    server.dropClients()
    await page.locator('.toast.warn', { hasText: 'E2E mock host disconnected' }).waitFor({ timeout: 20000 })
    assert((await statusDot.getAttribute('data-state')) === 'disconnected' && (await statusDot.evaluate((el) => el.classList.contains('err'))), 'the status dot turns red once the connection drops')
    await cm.click()
    await page.keyboard.press(`${mod}+Enter`)
    await page.waitForFunction((n) => Number(document.querySelector('.tab-pane:not([hidden]) .query-tab')?.getAttribute('data-runs')) > n, runsBefore, { timeout: 30000 })
    const rerunError = page.locator('.session-slot:not([hidden]) .result-error')
    assert((await rerunError.count()) === 0, `the query runs after reconnecting (got ${await rerunError.first().textContent().catch(() => '')})`)
    assert((await statusDot.getAttribute('data-state')) === 'connected', 'the status dot is green again')
    await page.locator('.result-chips .chip').first().click()
    assert((await resultGrid.locator('td[data-r="0"][data-c="1"]').textContent()) === 'Edited via GUI', 'the rerun shows the rows')
    console.log('a query run after the connection dropped reconnects and runs')
    // A double-click edits a result cell of a single-table select; Apply writes it back through the same path as the Data tab.
    await resultGrid.locator('td[data-r="0"][data-c="1"]').dblclick()
    const cellEditor = resultGrid.locator('textarea')
    await cellEditor.waitFor()
    await cellEditor.fill('Edited in results')
    await page.keyboard.press('Enter')
    await page.getByTestId('results-apply').click()
    await page.getByTestId('confirm-dialog').waitFor()
    await page.getByTestId('confirm-ok').click()
    await page.locator('.toast.success', { hasText: 'Applied 1 change' }).waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid=result-grid] td[data-r="0"][data-c="1"]')?.textContent === 'Edited in results')
    // Only the block at the cursor runs; blank lines separate blocks and a semicolon is optional.
    await cm.click()
    await page.keyboard.press(`${mod}+a`)
    await page.keyboard.type('SELECT 1 AS first;\n\nSELECT 2 AS second')
    await page.keyboard.press(`${mod}+Enter`)
    await page.waitForFunction(() => document.querySelector('[data-testid=result-grid] td[data-r="0"][data-c="0"]')?.textContent === '2')
    // One statement needs no badge to pick its result; the summary says what it returned.
    assert((await front('results-summary').textContent()).startsWith('1 row ·'), 'a single statement shows its row count in the summary')
    assert((await page.locator('.session-slot:not([hidden]) .result-chips .chip').count()) === 0, 'and no badges')
    await page.keyboard.press(`${mod}+Shift+Enter`)
    await page.waitForFunction(() => document.querySelectorAll('.result-chips .chip').length === 2)
    console.log('result cells edit in place; the cursor block runs on its own')
    // Suggestions follow the statement: after FROM only tables, and finished keywords are upper-cased.
    await cm.click()
    await page.keyboard.press(`${mod}+a`)
    await page.keyboard.type('select * from us')
    const popup = page.locator('.cm-tooltip-autocomplete')
    await popup.waitFor({ timeout: 5000 })
    const suggested = await popup.locator('.cm-completionLabel').allTextContents()
    assert(suggested.includes('users') && !suggested.some((s) => /^[A-Z]{4,}$/.test(s)), `after FROM only tables are suggested (got ${suggested.join(', ')})`)
    await page.keyboard.press('Escape')
    assert((await cm.textContent()).startsWith('SELECT * FROM us'), 'finished keywords are upper-cased as you type')
    // Settings → Editor: suggestions can be turned off.
    await front('open-settings').click()
    await page.getByTestId('settings-dialog').waitFor()
    await page.getByTestId('settings-tab-editor').click()
    await page.getByTestId('settings-editor').waitFor()
    await page.getByTestId('editor-autocomplete').uncheck()
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-testid=settings-dialog]'))
    await cm.click()
    await page.keyboard.press('End')
    await page.keyboard.type('e')
    await page.waitForTimeout(500)
    assert((await popup.count()) === 0, 'no suggestions once turned off')
    await front('open-settings').click()
    await page.getByTestId('settings-dialog').waitFor()
    await page.getByTestId('editor-autocomplete').check()
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-testid=settings-dialog]'))
    // Tab takes the highlighted suggestion by default; once unticked in Settings it no longer does.
    await cm.click()
    await page.keyboard.press(`${mod}+a`)
    await page.keyboard.type('select * from us')
    await popup.waitFor({ timeout: 5000 })
    await page.keyboard.press('Tab')
    await page.waitForFunction(() => document.querySelector('.tab-pane:not([hidden]) .query-tab .cm-content')?.textContent.includes('FROM users'))
    await front('open-settings').click()
    await page.getByTestId('settings-dialog').waitFor()
    await page.getByTestId('editor-accept-tab').uncheck()
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-testid=settings-dialog]'))
    await cm.click()
    await page.keyboard.press(`${mod}+a`)
    await page.keyboard.type('select * from ord')
    await popup.waitFor({ timeout: 5000 })
    await page.keyboard.press('Tab')
    await page.waitForTimeout(200)
    assert(!(await cm.textContent()).includes('orders'), 'Tab no longer accepts once unticked')
    await page.keyboard.press('Escape')
    await front('open-settings').click()
    await page.getByTestId('settings-dialog').waitFor()
    await page.getByTestId('editor-accept-tab').check()
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-testid=settings-dialog]'))
    console.log('statement-aware suggestions and editor settings work')
    // Code colours and the SQL pane's font, chosen over the theme's, then the theme's again.
    const codeStyle = () =>
      page.evaluate(() =>
        [
          document.documentElement.dataset.syntax ?? 'theme',
          getComputedStyle(document.documentElement).getPropertyValue('--syntax-keyword').trim(),
          getComputedStyle(document.querySelector('.tab-pane:not([hidden]) .query-tab .cm-scroller')).fontFamily.split(',')[0]
        ].join(' ')
      )
    const themeCode = await codeStyle()
    assert(themeCode.startsWith('theme #') && !themeCode.includes('JetBrains'), `the theme's code colours and font to begin with (${themeCode})`)
    await front('open-settings').click()
    await page.getByTestId('settings-dialog').waitFor()
    await page.getByTestId('settings-tab-appearance').click()
    await page.getByTestId('syntax-ocean').click()
    await page.getByTestId('font-jetbrains-mono').click()
    assert((await page.getByTestId('syntax-ocean').getAttribute('aria-pressed')) === 'true', 'the chosen code colours are marked')
    await page.getByTestId('font-choices').scrollIntoViewIfNeeded()
    await shot('06g-code-settings')
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-testid=settings-dialog]'))
    const chosenCode = await codeStyle()
    assert(chosenCode.startsWith('ocean #') && chosenCode.endsWith(' "Bundled JetBrains Mono"') && chosenCode.split(' ')[1] !== themeCode.split(' ')[1], `chosen code colours and font win over the theme's (${chosenCode})`)
    await front('open-settings').click()
    await page.getByTestId('settings-dialog').waitFor()
    await page.getByTestId('settings-tab-appearance').click()
    await page.getByTestId('syntax-theme').click()
    await page.getByTestId('font-theme').click()
    await page.keyboard.press('Escape')
    await page.waitForFunction(() => !document.querySelector('[data-testid=settings-dialog]'))
    assert((await codeStyle()) === themeCode, `the theme's code colours and font again (${await codeStyle()})`)
    console.log("code colours and the SQL pane's font override the theme's, and go back to it")
    // An answer from the chat with a value protected on its way out: "N protected" under the SQL opens what was sent.
    const aiRequests = []
    const DOCS_ANSWER = [
      '## Using the client',
      '',
      'Install it with **npm**, then call `connect()` before anything else:',
      '',
      '1. Create a client',
      '2. Run a query',
      '',
      '```sql',
      'SELECT id, name FROM users LIMIT 5',
      '```',
      '',
      `${'Failed requests are retried with exponential backoff. '.repeat(30)}END-OF-ANSWER`
    ].join('\n')
    const ai = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'mock-sql' }] }))
        aiRequests.push(body)
        const r = JSON.parse(body)
        // Given the test connector's tools, the model first looks up and flags the email in the question, by its placeholder:
        // two calls in one turn, one read-only (runs freely, with a structured result to check) and one that asks first.
        const flag = (r.tools ?? []).some((t) => t.function?.name === 'mcp__crm__flag_account') && !r.messages.some((m) => m.role === 'tool')
        const question = [...r.messages].reverse().find((m) => m.role === 'user')?.content ?? ''
        const email = /<\|PII:EMAIL:[0-9A-F]{6}\|>/.exec(typeof question === 'string' ? question : JSON.stringify(question))?.[0]
        const toolCall = (name, args) =>
          res.end(JSON.stringify({ model: 'mock-sql', choices: [{ message: { content: null, tool_calls: [{ id: `t${r.messages.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { prompt_tokens: 900, completion_tokens: 40 } }))
        // Asked to name a new conversation for its tab.
        const system = r.messages.find((m) => m.role === 'system')?.content ?? ''
        if (/Name the conversation/.test(system)) {
          const name = /first user/i.test(String(question)) ? 'First User Lookup' : 'User Lookup'
          return res.end(JSON.stringify({ model: 'mock-sql', choices: [{ message: { content: `"${name}."` }, finish_reason: 'stop' }], usage: { prompt_tokens: 40, completion_tokens: 4 } }))
        }
        // A chat across two databases: find the user in the second, follow the email into the first by its placeholder, answer.
        if (/across both databases/i.test(String(question))) {
          const results = r.messages.filter((m) => m.role === 'tool')
          if (!results.length) return toolCall('run_query', { database: 'db2', sql: 'SELECT id, email FROM users WHERE id = 1', purpose: 'the user' })
          const found = /<\|PII:EMAIL:[0-9A-F]{6}\|>/.exec(results[0].content)?.[0] ?? 'missing'
          if (results.length === 1) return toolCall('run_query', { database: 'db1', sql: `SELECT id, name FROM users WHERE email = '${found}'`, purpose: 'the same user here' })
          return res.end(JSON.stringify({ model: 'mock-sql', choices: [{ message: { content: `**Timeline**\n\n1. User 1 is ${found} in both databases.` }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 60 } }))
        }
        if (/count the users in the other database/i.test(String(question))) {
          return toolCall('propose_query', { database: 'db2', sql: 'SELECT count(*) AS n FROM users', explanation: 'Counts the users.', tables_used: ['users'] })
        }
        // A question a connector's documentation would answer: a long reply in markdown, without a query.
        if (/how do i use the client library/i.test(String(question))) {
          return res.end(JSON.stringify({ model: 'mock-sql', choices: [{ message: { content: DOCS_ANSWER }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 700 } }))
        }
        const args = { sql: 'SELECT id, name FROM users ORDER BY id LIMIT 1', explanation: 'The first user.', tables_used: ['users'] }
        const calls =
          flag && email
            ? [
                { id: 'c0', type: 'function', function: { name: 'mcp__crm__lookup_customer', arguments: JSON.stringify({ email }) } },
                { id: 'c1', type: 'function', function: { name: 'mcp__crm__flag_account', arguments: JSON.stringify({ email, reason: 'Late payments' }) } }
              ]
            : [{ id: 'c2', type: 'function', function: { name: 'propose_query', arguments: JSON.stringify(args) } }]
        res.end(JSON.stringify({ model: 'mock-sql', choices: [{ message: { content: null, tool_calls: calls } }], usage: { prompt_tokens: 900, completion_tokens: 40 } }))
      })
    })
    await new Promise((resolve) => ai.listen(0, '127.0.0.1', resolve))
    try {
      await front('open-settings').click()
      await page.getByTestId('settings-dialog').waitFor()
      await page.getByTestId('settings-tab-models').click()
      await page.getByTestId('ai-type-local').click()
      await page.getByTestId('ai-local-type').selectOption('openai-compatible')
      await page.getByTestId('ai-base-url').fill(`http://127.0.0.1:${ai.address().port}/v1`)
      await page.getByTestId('ai-model').fill('mock-sql')
      // The mock runs on this computer, so protect local models too.
      await page.getByTestId('privacy-local').check()
      await page.getByTestId('settings-save').click()
      await page.locator('.toast.success', { hasText: 'Settings saved' }).waitFor()
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.querySelector('[data-testid=settings-dialog]'))
      await chatEl('ask-input').fill('Who is the user with the email radia.1@example.com?')
      await chatEl('ask-button').click()
      const protectedLink = chatEl('ask-privacy').last()
      await protectedLink.waitFor({ timeout: 30000 })
      const linkText = (await protectedLink.textContent()).trim()
      assert(/^\d+ protected$/.test(linkText), `the answer says how many values were protected (${linkText})`)
      assert(aiRequests.length > 0 && !aiRequests.join('\n').includes('radia.1@example.com'), 'the email never reached the model')
      await protectedLink.click()
      await page.getByTestId('exchange-summary').waitFor()
      await shot('06h-what-was-sent')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.querySelector('[data-testid=exchange-summary]'))
      console.log('"N protected" under an answer opens what was sent to the model')

      // ------------------------------------------------------------ connectors: an MCP server whose tools the chat can use
      const quote = (p) => `'${p.replace(/'/g, `'\\''`)}'`
      const frontName = (await page.locator('[data-testid=conn-tab][aria-selected=true] .conn-tab-name').textContent()).trim()
      await front('open-settings').click()
      await page.getByTestId('settings-dialog').waitFor()
      await page.getByTestId('settings-tab-connectors').click()
      await page.getByTestId('connector-add').click()
      await page.getByTestId('connector-name').fill('CRM')
      await page.getByTestId('connector-command').fill(`${quote(process.execPath)} ${quote(path.join(root, 'test', 'fixtures', 'mcp-server.mjs'))}`)
      await page.getByTestId('connector-env').fill('CRM_TOKEN=e2e-token-123')
      await page.getByTestId('connector-scope-selected').click()
      await page.getByTestId(`connector-connection-${frontName}`).check()
      await page.getByTestId('connector-save').click()
      await page.locator('[data-testid=connector-tool][data-tool=lookup_customer]').waitFor({ timeout: 30000 })
      assert((await page.getByTestId('connector-status').textContent()).includes('Running sagittarion-test-crm 1.2.0'), 'the connector started and listed its tools')
      const crmTool = (name) => page.locator(`[data-testid=connector-tool][data-tool=${name}] [data-testid=tool-permission]`)
      assert((await crmTool('lookup_customer').inputValue()) === 'allow' && (await crmTool('flag_account').inputValue()) === 'ask', 'read-only tools run freely and the rest ask first')
      assert(!fs.readFileSync(path.join(userData, 'connectors.json'), 'utf8').includes('e2e-token-123'), 'the connector\'s secret is not saved in plain text')
      await shot('06i-connectors')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.querySelector('[data-testid=settings-dialog]'))
      // The chat's menu has it on for this connection.
      await chatEl('connectors-button').click()
      const chatSwitch = page.locator('[data-testid=chat-connector][data-name=CRM] [data-testid=chat-connector-switch]')
      assert((await chatSwitch.getAttribute('aria-checked')) === 'true', 'the connector is on in a chat on its connection')
      await page.keyboard.press('Escape')
      // A tool that changes things asks first, with what it would be sent: the real email, on this computer only.
      const answers = await chatEl('ask-result').count()
      const before = aiRequests.length
      await chatEl('ask-input').fill('Flag zed@corp.io for review, then show the first user')
      await chatEl('ask-button').click()
      const approval = chatEl('tool-approval')
      await approval.waitFor({ timeout: 30000 })
      const asking = await approval.textContent()
      assert(asking.includes('Flag an account') && asking.includes('zed@corp.io'), `the approval names the tool and shows the real value it would get (${asking})`)
      await shot('06j-connector-approval')
      await approval.getByTestId('tool-allow-once').click()
      await answered(answers)
      const sent = aiRequests.slice(before)
      assert(sent.length === 2 && sent[1].includes('Flagged <|PII:EMAIL:'), 'the connector\'s reply reached the model with the email protected')
      assert(sent[1].includes('plan Pro'), 'the read-only lookup ran without asking')
      assert(!sent.join('\n').includes('zed@corp.io'), 'the email never reached the model')
      // Switched off for this chat, the model is not offered its tools.
      await chatEl('connectors-button').click()
      await chatSwitch.click()
      await page.keyboard.press('Escape')
      const beforeOff = aiRequests.length
      await chatEl('ask-input').fill('Show the first user')
      await chatEl('ask-button').click()
      await answered(answers + 1)
      assert(!aiRequests.slice(beforeOff).join('\n').includes('mcp__crm__'), 'a connector switched off in the chat offers no tools')
      console.log('connectors: added in Settings, scoped to a connection, asked first, protected, and switched off per chat')
      // An answer in words comes whole, as markdown.
      const shownAnswers = await chatEl('ask-result').count()
      await chatEl('ask-input').fill('How do I use the client library?')
      await chatEl('ask-button').click()
      await answered(shownAnswers)
      const docs = chatEl('ask-result').last()
      await docs.locator('.chat-markdown h2', { hasText: 'Using the client' }).waitFor()
      assert((await docs.locator('.chat-markdown ol li').count()) === 2, 'the answer\'s list is a list')
      assert((await docs.locator('.chat-markdown .md-code', { hasText: 'connect()' }).count()) === 1, 'inline code is code')
      assert((await docs.locator('.chat-markdown .chat-sql span').count()) > 0, 'SQL in the answer is highlighted like the editor')
      assert((await docs.locator('.chat-markdown').textContent()).trim().endsWith('END-OF-ANSWER'), 'the whole answer is shown, however long')
      assert((await docs.locator('.chat-hint').count()) === 0, 'an answer that asks nothing does not ask for a reply')
      await docs.screenshot({ path: path.join(artifacts, '06k-markdown-answer.png') })
      console.log('answers in words show whole, as markdown')

      // ------------------------------------------------------------ instructions: global, and for chosen connections
      const addInstruction = async (name, text, connection) => {
        await page.getByTestId('instruction-add').click()
        await page.getByTestId('instruction-name').fill(name)
        await page.getByTestId('instruction-text').fill(text)
        if (connection) {
          await page.getByTestId('instruction-scope-selected').click()
          const boxes = await page.locator('[data-testid^="instruction-connection-"]').evaluateAll((els) => els.map((e) => e.dataset.testid.slice('instruction-connection-'.length)))
          const target = connection === 'other' ? boxes.find((n) => n !== frontName) : connection
          await page.getByTestId(`instruction-connection-${target}`).check()
        }
        await page.getByTestId('instruction-save').click()
        await page.locator(`[data-testid=instruction][data-name="${name}"]`).waitFor()
      }
      await front('open-settings').click()
      await page.getByTestId('settings-dialog').waitFor()
      await page.getByTestId('settings-tab-instructions').click()
      await addInstruction('Revenue', 'Revenue means paid orders only. GLOBAL-RULE-7Q')
      await addInstruction('This database', 'Users here are customers. FRONT-RULE-3K', frontName)
      await addInstruction('Elsewhere', 'Never used here. OTHER-RULE-9Z', 'other')
      assert((await page.locator('[data-testid=instruction][data-name=Revenue] .setting-card-sub').textContent()).startsWith('Global'), 'an instruction for all connections is global')
      await shot('06l-instructions')
      await page.keyboard.press('Escape')
      await page.waitForFunction(() => !document.querySelector('[data-testid=settings-dialog]'))
      const beforeAsk = aiRequests.length
      const answersNow = await chatEl('ask-result').count()
      await chatEl('ask-input').fill('What was revenue last month?')
      await chatEl('ask-button').click()
      await answered(answersNow)
      const sentNow = aiRequests.slice(beforeAsk).join('\n')
      assert(sentNow.includes('GLOBAL-RULE-7Q') && sentNow.includes('FRONT-RULE-3K'), 'the global instruction and this connection\'s reach the model')
      assert(!sentNow.includes('OTHER-RULE-9Z'), 'another connection\'s instruction does not')
      const ruled = chatEl('ask-result').last()
      assert(!(await ruled.textContent()).includes('RULE-'), 'instructions are not shown in the chat')
      await ruled.locator('.ask-steps-toggle').click()
      assert((await ruled.locator('.ask-step', { hasText: 'Following 2 instructions' }).textContent()).includes('Revenue, This database'), 'the steps name the instructions followed')
      console.log('instructions: global and per connection reach the model, named in the steps, never shown in the chat')

      // ------------------------------------------------------------ a chat across databases
      const otherName = 'E2E local file'
      const userEmail = sqlite(db, 'SELECT email FROM users WHERE id = 1')
      await chatEl('chat-db-add').click()
      await page.locator(`[data-testid=chat-db-option][data-name="${otherName}"]`).click()
      // It connects in the background: its tab joins the strip, and the chat's stays in front.
      await chatEl('chat-db').and(page.locator(`[data-name="${otherName}"][data-state=connected]`)).waitFor({ timeout: 30000 })
      assert((await page.getByTestId('conn-tab').count()) === 2, 'the database added to the chat connected in a tab of its own')
      assert((await page.locator('[data-testid=conn-tab][aria-selected=true] .conn-tab-name').textContent()).trim() === frontName, 'the chat stays in front')
      const beforeAcross = aiRequests.length
      const answersAcross = await chatEl('ask-result').count()
      await chatEl('ask-input').fill('Trace user 1 across both databases')
      await chatEl('ask-button').click()
      await answered(answersAcross)
      const sentAcross = aiRequests.slice(beforeAcross)
      assert(sentAcross.length === 3, `two queries, then the answer (${sentAcross.length} requests)`)
      assert(sentAcross[0].includes(`\\"db1\\": ${frontName}`) && sentAcross[0].includes(`\\"db2\\": ${otherName}`), 'the model is told about both databases')
      assert(sentAcross[0].includes('Elsewhere (only for \\"db2\\")'), "the other database's instruction comes along, marked as its own")
      assert(sentAcross[2].includes('the same user here') || sentAcross[2].includes('run_query'), 'the second query went to the model as a tool call')
      assert(!sentAcross.join('\n').includes(userEmail), 'the email in the query results never reached the model')
      const traced = chatEl('ask-result').last()
      assert((await traced.locator('.chat-markdown').textContent()).includes(`${userEmail} in both databases`), 'the answer shows the real email')
      await traced.getByTestId('ask-queries-toggle').click()
      const ranOn = await traced.getByTestId('ask-query').evaluateAll((els) => els.map((e) => e.dataset.database))
      assert(ranOn.join() === `${otherName},${frontName}`, `the queries the model ran are listed with their databases (${ranOn.join()})`)
      assert((await traced.getByTestId('ask-query').last().textContent()).includes(userEmail), 'a query that ran shows the real value it used')
      assert((await traced.getByTestId('ask-privacy').count()) === 1, 'the answer says what was protected')
      await traced.screenshot({ path: path.join(artifacts, '06m-across-databases.png') })
      // A query for the other database waits there: "Run in" opens a tab on it and runs it.
      const answersPropose = await chatEl('ask-result').count()
      await chatEl('ask-input').fill('Count the users in the other database')
      await chatEl('ask-button').click()
      await answered(answersPropose)
      const proposed = chatEl('ask-result').last()
      assert((await proposed.getByTestId('ask-db-label').textContent()).includes(otherName), 'the answer names the database its query is for')
      assert((await proposed.getByTestId('ask-auto-ran').count()) === 0, 'a query for another database does not run in this one')
      await proposed.getByTestId('ask-run-in').click()
      await page.waitForFunction((n) => document.querySelector('[data-testid=conn-tab][aria-selected=true] .conn-tab-name')?.textContent.trim() === n, otherName)
      await front('result-grid').waitFor({ timeout: 20000 })
      // The chat stayed where it was as the connection in front changed.
      assert((await chatEl('ask-result').count()) === answersPropose + 1, 'the chat keeps its conversation across connections')
      await shot('06n-chat-beside-another-connection')
      console.log('across databases: added to the chat, traced by placeholder, listed, and run where they belong')
      // Back to the chat's connection, without the other database.
      await page.locator('[data-testid=conn-tab]', { hasText: otherName }).hover()
      await page.locator('[data-testid=conn-tab]', { hasText: otherName }).getByTestId('conn-tab-close').click()
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=conn-tab]').length === 1)
      await chatEl('chat-db').and(page.locator(`[data-name="${otherName}"]`)).getByTestId('chat-db-remove').click()
      assert((await chatEl('chat-db').count()) === 1, 'the chat is back to its own database')

      // ------------------------------------------------------------ conversations in tabs
      const chatTab = (n) => chatEl('chat-tab').nth(n)
      assert((await chatEl('chat-tab').count()) === 1, 'the chat starts with one conversation')
      const firstAnswers = await chatEl('ask-result').count()
      await chatEl('chat-tab-new').click()
      assert((await chatEl('chat-tab').count()) === 2, 'a new conversation opens in a tab of its own')
      assert((await chatTab(1).getAttribute('aria-selected')) === 'true', 'and comes to the front')
      assert((await chatEl('ask-result').count()) === 0, 'it starts empty')
      assert((await chatEl('chat-db').count()) === 1 && (await chatEl('chat-db').getAttribute('data-name')) === frontName, 'it follows the connection in front')
      await chatEl('ask-input').fill('Show the first user')
      await chatEl('ask-button').click()
      await answered(0)
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=chat-pane] [data-testid=chat-tab]')[1]?.dataset.title === 'First User Lookup')
      // Asked once, with its first question, protected like any request.
      const named = aiRequests.filter((b) => b.includes('Name the conversation'))
      assert(named.length === 2 && !named.join('\n').includes('radia.1@example.com'), 'each conversation is named once, from its first question')
      // A third, closed again: the one beside it comes to the front.
      await chatEl('chat-tab-new').click()
      assert((await chatEl('chat-tab').count()) === 3, 'another conversation opens')
      await chatTab(2).getByTestId('chat-tab-close').click()
      assert((await chatEl('chat-tab').count()) === 2, 'a closed conversation goes')
      assert((await chatTab(1).getAttribute('aria-selected')) === 'true', 'the one beside it comes to the front')
      // The first conversation is as it was.
      await chatTab(0).click()
      assert((await chatEl('ask-result').count()) === firstAnswers, 'the first conversation is as it was')
      // New chat stays at the right end of the header, and ⌘T in the chat opens one, not a query tab.
      const [plusBox, paneBox] = [await chatEl('chat-tab-new').boundingBox(), await page.getByTestId('chat-pane').boundingBox()]
      assert(Math.abs(plusBox.x + plusBox.width - (paneBox.x + paneBox.width)) <= 1, 'New chat sits at the right end of the header')
      assert((await chatEl('chat-tab-new').getAttribute('title')).startsWith('New chat'), 'and says what it does')
      const queryTabs = await page.locator('.session-slot:not([hidden]) .tabbar .tab').count()
      await chatEl('ask-input').click()
      await page.keyboard.press(`${mod}+t`)
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=chat-pane] [data-testid=chat-tab]').length === 3)
      assert((await page.locator('.session-slot:not([hidden]) .tabbar .tab').count()) === queryTabs, '⌘T in the chat opens no query tab')
      await page.waitForFunction(() => document.activeElement?.dataset.testid === 'ask-input')
      await chatTab(2).getByTestId('chat-tab-close').click()
      await chatTab(0).click()
      assert((await chatEl('ask-result').count()) === firstAnswers, 'the first conversation is in front again')
      await chatEl('ask-header').screenshot({ path: path.join(artifacts, '06o-chat-tabs.png') })
      console.log('conversations in tabs: opened, named, closed, switched, and opened with ⌘T')

      // ------------------------------------------------------------ past conversations
      await chatTab(1).getByTestId('chat-tab-close').click()
      assert((await chatEl('chat-tab').count()) === 1, 'the conversation closes')
      await chatEl('chat-history-button').click()
      const pastItem = page.locator('[data-testid=chat-history-item][data-title="First User Lookup"]')
      await pastItem.waitFor()
      await page.getByTestId('chat-history-search').fill('first user')
      assert((await page.getByTestId('chat-history-item').count()) === 1, 'the history finds it by its words')
      await page.getByTestId('chat-history-search').fill('no such thing')
      assert((await page.getByTestId('chat-history-item').count()) === 0, 'and leaves out what does not match')
      await page.getByTestId('chat-history-search').fill('')
      await page.getByTestId('chat-history').screenshot({ path: path.join(artifacts, '06p-chat-history.png') })
      await pastItem.click()
      await page.waitForFunction(() => document.querySelectorAll('[data-testid=chat-pane] [data-testid=chat-tab]').length === 2)
      assert((await chatTab(1).getAttribute('data-title')) === 'First User Lookup' && (await chatTab(1).getAttribute('aria-selected')) === 'true', 'it opens again in a tab')
      assert((await chatEl('ask-result').count()) === 1, 'with its conversation')
      await chatTab(0).click()
      console.log('past conversations: kept when closed, found, and continued')
    } finally {
      ai.close()
    }

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
    assert((await page.getByTestId('conn-group').locator('option:checked').textContent()) === 'Acme', 'the form shows which group the connection is in')
    await acme.click()
    await page.waitForFunction(() => document.querySelectorAll('[data-group="Acme"] .conn-item').length === 0)
    await acme.click()
    await page.locator('[data-group="Acme"] .conn-item').first().waitFor()
    await shot('07c-connection-groups')
    // A colour picked from the header's menu tints the group, and follows it through a rename.
    await acme.click({ button: 'right' })
    await page.locator('.context-menu .swatch:not(.none)').nth(1).click()
    await page.locator('.conn-group[data-group="Acme"].tinted').waitFor()
    await shot('07c2-coloured-group')
    // Renaming from the header's menu moves every member.
    await acme.click({ button: 'right' })
    await page.getByText('Rename group…').click()
    await page.getByTestId('conn-group-rename').fill('Acme Corp')
    await page.keyboard.press('Enter')
    await page.locator('[data-group="Acme Corp"] .conn-item').first().waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid=conn-group]')?.value === 'Acme Corp')
    await page.locator('.conn-group[data-group="Acme Corp"].tinted').waitFor()
    console.log('connection groups work')

    // ------------------------------------------------------------ duplicating a connection copies everything but the name
    const viaProfile = page.locator('.conn-item', { hasText: 'E2E via profile' }).first()
    await viaProfile.click({ button: 'right' })
    await page.getByText('Duplicate', { exact: true }).click()
    await page.locator('.conn-item', { hasText: 'E2E via profile copy' }).waitFor()
    await page.waitForFunction(() => document.querySelector('[data-testid=conn-name]')?.value === 'E2E via profile copy')
    assert((await page.getByTestId('conn-group').locator('option:checked').textContent()) === 'Acme Corp', 'the copy keeps the group')
    await page.getByTestId('ssh-profile-summary').waitFor()
    assert((await page.locator('[data-group="Acme Corp"] .conn-item').count()) === 2, 'the copy sits in the same group')
    console.log('duplicated a connection')

    // ------------------------------------------------------------ a restart brings back the tabs, the query and its results
    const connItem = (name) => page.locator('.conn-item').filter({ has: page.locator('.conn-name', { hasText: new RegExp(`^${name}$`) }) })
    await connItem('E2E via profile').click()
    await page.getByTestId('connect-button').click()
    await front('tree-table-users').waitFor({ timeout: 30000 })
    await front('new-query-tab').click()
    const restoreCm = page.locator('.session-slot:not([hidden]) .tab-pane:not([hidden]) .query-tab .cm-content')
    await restoreCm.waitFor()
    await restoreCm.click()
    await page.keyboard.type('SELECT id, name FROM users ORDER BY id LIMIT 3;')
    await page.keyboard.press(`${mod}+Enter`)
    await page.locator('.session-slot:not([hidden]) [data-testid=result-grid] tbody tr').first().waitFor({ timeout: 20000 })
    await page.getByTestId('conn-tab-add').click()
    await connItem('E2E local file').click()
    await page.getByTestId('connect-button').click()
    await front('tree-table-users').waitFor({ timeout: 30000 })
    // The grouped connection's tab sits behind its group's label, and the tabs drag into an order a restart keeps.
    const connTab = (name) => page.locator('[data-testid=conn-tab]').filter({ has: page.locator('.conn-tab-name', { hasText: new RegExp(`^${name}$`) }) })
    const acmeTabs = page.locator('[data-testid=conn-tab-group][data-group="Acme Corp"]')
    assert((await acmeTabs.getByTestId('conn-tab-group-label').textContent()) === 'Acme Corp', 'the tab strip labels the group')
    assert((await acmeTabs.locator('.conn-tab-name').allTextContents()).join() === 'E2E via profile', 'the grouped connection sits in its group')
    assert(await acmeTabs.evaluate((el) => el.classList.contains('tinted')), 'the group keeps its colour in the tab strip')
    // A click on the label collapses the group, as in a browser; the tab in front moves out of a group as it closes.
    const acmeLabel = acmeTabs.getByTestId('conn-tab-group-label')
    await acmeLabel.click()
    await connTab('E2E via profile').waitFor({ state: 'hidden' })
    assert((await acmeLabel.getAttribute('aria-expanded')) === 'false', 'the label says the group is collapsed')
    assert((await connTab('E2E local file').getAttribute('aria-selected')) === 'true', 'collapsing another group leaves the tab in front alone')
    await acmeLabel.click()
    await connTab('E2E via profile').click()
    // Colours come from groups: the tab takes the colour of its group, while the window's accent stays white.
    assert(((await connTab('E2E via profile').getAttribute('style')) ?? '').includes('#3ecf8e'), 'the tab takes its group colour')
    assert((await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent'))) === '#ffffff', "the window's accent stays white in a coloured group")
    await acmeLabel.click()
    await connTab('E2E via profile').waitFor({ state: 'hidden' })
    assert((await connTab('E2E local file').getAttribute('aria-selected')) === 'true', 'the tab in front leaves its group as the group collapses')
    await acmeLabel.click()
    await connTab('E2E via profile').waitFor()
    const dragFrom = await connTab('E2E local file').boundingBox()
    const dragTo = await acmeTabs.getByTestId('conn-tab-group-label').boundingBox()
    await page.mouse.move(dragFrom.x + dragFrom.width / 2, dragFrom.y + dragFrom.height / 2)
    await page.mouse.down()
    await page.mouse.move(dragTo.x + 4, dragFrom.y + dragFrom.height / 2, { steps: 12 })
    await page.mouse.up()
    await page.waitForFunction(() => document.querySelector('[data-testid=conn-tab] .conn-tab-name')?.textContent === 'E2E local file')
    await shot('07c3-grouped-tabs')
    await pickTheme('cobalt')
    await connTab('E2E via profile').click()
    await page.waitForTimeout(800)
    await app.close()
    app = await electron.launch(launchOptions)
    page = await app.firstWindow()
    watchConsole()
    await page.waitForLoadState('domcontentloaded')
    await page.getByTestId('conn-tab').nth(1).waitFor({ timeout: 15000 })
    assert((await theme()) === 'cobalt rgb(24, 25, 28)', 'the theme comes back after a restart')
    assert((await page.getByTestId('conn-tab').count()) === 2, 'both connection tabs come back')
    const chatTabs = page.locator('[data-testid=chat-pane] [data-testid=chat-tab]')
    assert((await chatTabs.count()) === 2 && (await chatTabs.nth(1).getAttribute('data-title')) === 'First User Lookup', 'the conversations come back in their tabs')
    assert((await chatTabs.nth(0).getAttribute('aria-selected')) === 'true', 'with the one that was in front')
    assert((await page.locator('[data-testid=conn-tab] .conn-tab-name').allTextContents()).join() === 'E2E local file,E2E via profile', 'the tabs come back in the order they were dragged into')
    assert((await connTab('E2E via profile').getAttribute('aria-selected')) === 'true', 'the connection that was in front is in front again')
    await front('tree-table-users').waitFor({ timeout: 30000 })
    assert((await page.locator('.session-slot:not([hidden]) .tabbar .tab').count()) === 1, 'its query tab is back')
    await page.locator('.session-slot:not([hidden]) .cm-content', { hasText: 'SELECT id, name FROM users' }).waitFor()
    assert((await page.locator('.session-slot:not([hidden]) [data-testid=result-grid] tbody tr').count()) === 3, 'the last results are back')
    await shot('07d-restored-workspace')
    assert((await connTab('E2E local file').getAttribute('data-status')) === 'pending', 'the other connection waits until it is opened')
    await connTab('E2E local file').click()
    await front('tree-table-users').waitFor({ timeout: 30000 })
    console.log('workspace restored after a restart')
    await pickTheme('charcoal')
    // A collapsed group stays collapsed through a restart.
    await page.locator('[data-testid=conn-tab-group][data-group="Acme Corp"]').getByTestId('conn-tab-group-label').click()
    await connTab('E2E via profile').waitFor({ state: 'hidden' })
    await page.waitForTimeout(800)
    await app.close()
    app = await electron.launch(launchOptions)
    page = await app.firstWindow()
    watchConsole()
    await page.waitForLoadState('domcontentloaded')
    const acmeAgain = page.locator('[data-testid=conn-tab-group][data-group="Acme Corp"]').getByTestId('conn-tab-group-label')
    await acmeAgain.waitFor({ timeout: 15000 })
    assert((await acmeAgain.getAttribute('aria-expanded')) === 'false', 'the group comes back collapsed')
    assert((await connTab('E2E local file').getAttribute('aria-selected')) === 'true', 'the tab that was in front is in front again')
    await acmeAgain.click()
    await connTab('E2E via profile').waitFor()
    console.log('tab groups collapse, and stay collapsed across a restart')
    for (const remaining of [1, 0]) {
      await page.getByTestId('conn-tab').first().hover()
      await page.getByTestId('conn-tab').first().getByTestId('conn-tab-close').click()
      await page.waitForFunction((n) => document.querySelectorAll('[data-testid=conn-tab]').length === n, remaining)
    }
    await page.getByTestId('new-connection').waitFor()

    // ------------------------------------------------------------ the profile connection still shows its profile and group
    await connItem('E2E via profile').click()
    await page.getByTestId('ssh-profile-summary').waitFor({ timeout: 15000 })
    assert((await page.getByTestId('conn-name').inputValue()) === 'E2E via profile', 'the most recent connection opens after a restart')
    assert((await page.getByTestId('ssh-profile-select').locator('option:checked').textContent()) === 'E2E SSH', 'the connection still points at its SSH profile after a restart')
    assert((await page.getByTestId('conn-group').locator('option:checked').textContent()) === 'Acme Corp', 'the connection keeps its group after a restart')
    assert((await page.locator('.conn-group[data-group="Acme Corp"].tinted').count()) === 1, 'the group keeps its colour after a restart')
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
      // The server ends the session, as an idle-session timeout or a restart does: the tab stays, the dot turns red, and
      // running the query again reconnects and shows its rows.
      const pgDot = page.locator('.session-slot:not([hidden]) [data-testid=status-dot]')
      const pgRunsBefore = Number(await page.locator('.tab-pane:not([hidden]) .query-tab').getAttribute('data-runs'))
      const killer = new pg.Client({ connectionString: pgUrl })
      await killer.connect()
      await killer.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'Sagittarion' AND pid <> pg_backend_pid()")
      await killer.end()
      await page.locator('.toast.warn', { hasText: 'E2E Postgres disconnected' }).waitFor({ timeout: 20000 })
      assert((await pgDot.getAttribute('data-state')) === 'disconnected', 'the status dot turns red when the server ends the session')
      await pgCm.click()
      await page.keyboard.press(`${mod}+Enter`)
      await page.waitForFunction((n) => Number(document.querySelector('.tab-pane:not([hidden]) .query-tab')?.getAttribute('data-runs')) > n, pgRunsBefore, { timeout: 30000 })
      const pgError = page.locator('.session-slot:not([hidden]) .result-error')
      assert((await pgError.count()) === 0, `the query runs after the server ended the session (got ${await pgError.first().textContent().catch(() => '')})`)
      assert((await pgResult.locator('tbody tr').count()) === 3, 'with its rows')
      assert((await pgDot.getAttribute('data-state')) === 'connected', 'and the dot is green again')
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
