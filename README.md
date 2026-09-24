# Sagittarion

A desktop GUI for SQLite and PostgreSQL. It opens **SQLite files** on this
computer or, over SSH, in place on another machine (nothing is downloaded,
nothing is installed on the server), and connects to **PostgreSQL** servers
directly or through an SSH tunnel. Edits are staged in the grid and applied
inside a single transaction.

Built with Electron, React and TypeScript. The SSH layer uses
[`ssh2`](https://github.com/mscdex/ssh2); the remote side is a small,
standard-library-only Python script that is shipped over the connection each
time you connect.

## Features

- **Connections**: SQLite files on this computer by default, or on another
  machine with *connect over SSH* ticked; PostgreSQL directly or through an
  SSH tunnel. Password, private key (with passphrase) or SSH agent
  authentication. Saved connections with per-connection colour; passwords and
  passphrases are stored encrypted with the OS keychain (Electron
  `safeStorage`) only when you tick *Save*.
- **SSH profiles**: tick *Save as an SSH profile* once and any later
  connection, SQLite or a Postgres tunnel, picks the host from a dropdown
  instead of retyping it. Profiles are edited in place and can be forgotten.
- **Picks up where you left off**: the connection tabs, their table and
  query tabs, each query's text, last results and chat come back on the
  next launch. The connection that was in front reconnects at once; the
  others connect when you open them.
- **Several connections at once**: every open connection is a tab, across
  the top of the window or down its left edge (Settings → Appearance).
  Switching is instant and keeps each connection's tabs, results and chat;
  closing one leaves the others alone.
- **Groups and copies**: put connections into groups from the *Group* field,
  one per app, one per environment, whatever fits; groups fold up in the
  list and are renamed or dissolved from their header. Any connection can be
  duplicated from the list, settings and saved secrets included, to make a
  variant.
- **Host key verification**: trust-on-first-use with a fingerprint prompt, plus
  your existing `~/.ssh/known_hosts` (plain, port-qualified and hashed entries)
  as a second source. Changed keys produce a loud warning.
- **Remote file browser**: pick the database file over SFTP instead of typing
  the path. `~` is expanded on the remote side.
- **Schema sidebar**: tables, views, indexes and triggers with column details,
  filterable.
- **Table browsing**: paging, sorting by column, raw `WHERE` filters, row
  counts, column resizing, keyboard navigation, cell inspector with hex dumps
  for blobs.
- **Editing**: inline cell edits, `NULL`s, new rows and deletions are *staged*
  and highlighted, then applied together in a single transaction. Rows are
  addressed by `rowid` (or the primary key for `WITHOUT ROWID` tables) and each
  statement must affect exactly one row or everything rolls back.
- **Run what you mean**: ⌘↩ runs the statement block under the cursor,
  blank lines separate blocks, a selection runs on its own, and ⌘⇧↩ runs
  the whole editor; a trailing semicolon is optional.
- **Editable results**: rows of a plain single-table `SELECT` can be edited
  in place with a double-click, staged, and applied through the same
  transaction path as the Data tab.
- **Editor settings**: keyword casing (upper, lower or as typed) applied as
  you finish each keyword, suggestions on or off, which keys accept a
  suggestion (Tab and Enter by default), and automatic table aliases
  (`FROM phone_numbers` becomes `FROM phone_numbers pn`). Suggestions follow
  the statement: tables after FROM and JOIN, columns after SELECT, WHERE, ON,
  SET and ORDER BY, keywords only where one can follow.
- **SQL editor**: CodeMirror with SQLite syntax highlighting and table/column
  autocomplete. Runs multiple statements, shows a result per statement, reports
  affected rows and errors, runs only the selection if there is one, and can
  cancel long-running queries.
- **Type fidelity**: 64-bit integers beyond JavaScript's safe range, `REAL`
  values such as `2.0`, `NaN`/`Infinity` and blobs all survive the round trip.
- **Export**: loaded rows as CSV, JSON or SQL `INSERT` statements.
- **Read-only mode** per connection; open transactions are shown in the status bar.

## PostgreSQL

Pick *PostgreSQL* when creating a connection. The form takes host, port,
database, user, password and an SSL mode (`prefer` tries TLS and falls back to
plain, `require`, `verify-full`, `disable`), or you can paste a
`postgres://user:password@host/db` URL. Tick *Connect through an SSH tunnel*
for servers that only listen on localhost: the app opens the SSH connection
with the usual key, agent or password options and forwards a local port through
it. Host key checks and saved-credential encryption work the same way as for
SQLite.

What the Postgres backend does differently:

- Tables are grouped by schema in the sidebar when the database has more than
  one; bare names refer to the current schema (normally `public`).
- Rows are addressed by primary key, so tables without one are read-only in
  the grid. Identity (`GENERATED ALWAYS`) and generated columns are shown but
  not editable.
- Values keep their server text form where JavaScript would lose information:
  `bigint` and `numeric` never round, `bytea` is shown as a blob, and
  timestamps, arrays, JSON and UUIDs appear exactly as the server prints them.
- Result sets from the query tab are read through a cursor, so a `SELECT`
  without a `LIMIT` only fetches as many rows as the limit dropdown allows.
- *Open read-only* sets `default_transaction_read_only` for the session.
- Requires PostgreSQL 12 or newer.

## Browsing large databases

The sidebar never loads a whole schema. Connecting fetches only schema names
and object counts, then streams table and view names in the background; with
23 schemas and a hundred thousand tables that is a few megabytes of names
rather than the columns and definitions of everything. Each schema is a node
with Tables, Views, Functions, Indexes and Triggers underneath. Columns load
when a table is expanded, index, trigger and function lists when their group is
opened (in pages of a thousand, with a *Load more* row), and definitions when
an object is clicked. The tree is virtualized, so a schema with five thousand
tables costs a few dozen DOM nodes however far it is expanded.

The filter box matches names locally and instantly; after a short pause the
server is asked as well, which adds indexes, triggers, functions and columns
that match, with column hits shown under their table. Small databases behave as
before: every schema and view group opens up front.

Functions and procedures (Postgres) show their signature on hover, a badge for
procedures, aggregates and trigger functions, and open `pg_get_functiondef`
output in a query tab.

## Ask in plain English

Every query tab has an *Ask* chat beside the editor and results. Type
a question such as "top 10 customers by revenue last quarter", "orders that
have no invoice" or "average time from signup to first purchase per plan", and
the app asks a language model of your choice to write the SQL. The query lands
in the editor and the chat explains it. When the model needs more detail it
asks in the chat and you reply there. The editor, chat and results are panes
you can resize by dragging the bars between them and rearrange by dragging a
pane's header onto an edge of another pane (or onto its middle to swap); a
label on the highlight says what the drop will do. The chat also collapses to a
thin strip on the right when you want the whole width for SQL; the layout
button in the toolbar restores the default, editor above results with the chat
down the right side. The generated query is checked before it runs:
A picker under the chat input switches models; choosing one whose provider
is not set up yet opens Settings on that provider with the model filled in.

1. **Read-only by construction.** Only a single `SELECT` (or `WITH ... SELECT`)
   is accepted, and the statement is executed under SQLite's `query_only`
   pragma or a PostgreSQL `READ ONLY` transaction, so even a query that slipped
   past the text check cannot change anything.
2. **Validated by the database.** The query is run through `EXPLAIN` first.
   If the database rejects it (unknown column, bad join, syntax), the error is
   sent back to the model, which gets up to two attempts to fix it.
3. **Explained.** The result panel shows what the query does, which tables it
   used, any assumptions the model made ("treated `total` as revenue"), how much
   of the schema it saw and how many tokens the request cost. Turn off *Run
   generated queries automatically* in Settings to review the SQL before it runs.

Follow-up questions work: the last few exchanges in the same chat, including
any clarification the model asked for, are sent along, so "now only for 2025"
refines the previous query. The refresh button in the chat header starts over.

While a question is being answered the chat shows each step as it happens:
which tables were chosen and why, each request to the model with its token
counts, every tool the model called and what it got back, the `EXPLAIN` check
and any repair round. A *Cancel* button stops the run. When it finishes, the
steps collapse into a one-line summary under the answer that expands on click.

### Providers

Settings → AI starts with the kind of connection: *Bring your own key*
(OpenAI, Anthropic, Google Gemini, OpenRouter, Groq; requests go straight
from the app to the provider with your key), *Local or custom* (Ollama,
LM Studio, vLLM, LiteLLM or any OpenAI-compatible server; nothing leaves your
machine or network), or *Managed AI*, which is on its way and will be the only
part of the app that needs an account. Keys are stored encrypted with the OS
keychain and referenced from the settings, never written in plain text. The
database agent's own options, the schema context budget and query safety, are
the same whichever model answers.

Settings lets you pick any standard provider and bring your own key: OpenAI,
Anthropic, Google Gemini, Groq, OpenRouter, a local Ollama server, or any
OpenAI-compatible endpoint (vLLM, LM Studio, a company gateway). *Test* checks
the connection and *Fetch models* lists what the account can use. Keys are
stored encrypted with the OS keychain via Electron's `safeStorage`, one per
provider. With Ollama nothing leaves your machine.

### Large schemas

Sending a whole schema with every question is expensive and, past a few
hundred tables, impossible. The app keeps a local index of the schema and
decides per question what the model needs to see:

- Each table is described in one compact line, e.g.
  `orders(id int pk, user_id int fk->users.id, status text {paid|pending|refunded}, total numeric, placed_at timestamp) ~12k rows`,
  roughly a tenth of the tokens of the `CREATE TABLE` text. Tables with more
  than 60 columns are shortened to keys, foreign keys and columns matching the
  question, with a note that `describe_table` has the rest.
- The index is built from object names, which are cheap even for a hundred
  thousand tables; columns and foreign keys are fetched only for the tables a
  question selects, and cached for the session. Schemas of up to a few hundred
  tables are loaded whole up front.
- If the whole compact schema fits the budget chosen in Settings (default about
  8k tokens), it is sent every time. A stable schema block is cache-friendly:
  with Anthropic it is marked for prompt caching, and OpenAI caches long
  repeated prefixes automatically, so repeat questions cost a fraction.
- Otherwise the question is matched against table and column names with a
  BM25 keyword search (identifiers are split on underscores and camelCase and
  singularised, so "customer" finds `customers` and `customer_addresses`), the
  best tables are expanded one hop along foreign keys so joins are possible,
  and lines are added in relevance order until the budget is full. Tables used
  by recent questions in the session get a boost. Optionally an embedding model
  (OpenAI-compatible providers only) is fused in for questions phrased unlike
  the schema; each table is embedded once and cached on disk.
- The model can look further itself with four tools: `search_schema`,
  `describe_table`, `sample_values` and `propose_query`. A question about a
  table that was not in the excerpt costs one extra round trip instead of a
  wrong answer. Models without tool support fall back to plain JSON answers.

Privacy: the question, the compact lines of the selected tables (names, types,
keys, comments, approximate row counts) and, for follow-ups, earlier questions
and SQL are sent to the provider. Turning on *Send sample column values* in
Settings also sends up to 20 distinct values of short text columns of the
tables in context so words like "paid" can be matched to a status; it is off by
default and skipped for tables estimated at over two million rows. Query
results are never sent.

## Requirements

- Local: Node.js 20 or newer to build and run from source.
- SQLite files on this computer: `python3` (3.5 or newer, standard library
  only). On macOS the Xcode Command Line Tools or Homebrew provide it.
- SQLite over SSH: an SSH login on the remote host and `python3` there.
  Debian/Ubuntu, Fedora/RHEL, Raspberry Pi OS and most NAS systems have it
  already; on Alpine run `apk add python3`. SFTP is optional and only needed
  for the file browser. The `sqlite3` command-line tool is *not* required.

## Getting started

```bash
npm install
npm run dev          # start with hot reload
npm run build        # production build into out/
npm start            # run the production build
npm run dist         # package for the current platform into release/
```

Then create a connection: host, port, username, how to authenticate, and the
path of the database file on the remote host. *Browse…* opens the remote file
browser; *Test* checks the whole chain (SSH, Python helper, opening the file)
without keeping the connection.

Keyboard shortcuts: `⌘T`/`Ctrl+T` new query tab, `⌘↩`/`Ctrl+Enter` run,
`⌘R`/`Ctrl+R` refresh the current tab, `⌘⇧R` refresh the schema, `⌘W` close
tab, `⌘⌫`/`Ctrl+Del` set the selected cell to `NULL`, `Enter`/`F2` or typing
starts editing a cell.

## How it works

```
┌──────────────────────────┐         SSH (ssh2)          ┌───────────────────────────────┐
│ Electron main process    │  exec: python3 -c <agent>   │ remote host                   │
│  Session ── PythonAgent ─┼────── JSON lines ──────────▶│  sqlite_agent.py ── sqlite3 ──┼─▶ file.db
│  SFTP (file browser)     │◀───── JSON lines ───────────│  (stdlib only, no install)    │
└──────────▲───────────────┘                             └───────────────────────────────┘
           │ IPC (contextBridge)
┌──────────┴───────────────┐
│ Renderer (React)         │
└──────────────────────────┘
```

1. `Session` (`src/main/ssh/session.ts`) opens the SSH connection and runs a
   short `sh -c` probe to find `python3` (or `python` if it is Python 3). The
   probe is written so it works under bash, dash, zsh, fish, csh and busybox ash.
2. It then starts `src/main/agent/sqlite_agent.py` with a single `exec`
   request. The script is passed base64-encoded on the command line, so no file
   is written on the server. The agent prints a ready line containing a random
   token; anything before it (MOTD-style `.bashrc` output, for example) is
   ignored.
3. Requests and responses are newline-delimited JSON over the channel's
   stdin/stdout (`PythonAgent`, `src/main/ssh/agent.ts`). A reader thread in the
   agent handles `cancel` out of band by calling `sqlite3.Connection.interrupt()`.
4. Values that JSON cannot represent are tagged: big integers as
   `{"$type":"int","value":"…"}`, blobs as base64 (with a size and truncation
   flag above 1 MiB), integral or special floats as `{"$type":"float",…}`.
5. Staged edits become one `apply` request; the agent runs them inside
   `BEGIN IMMEDIATE … COMMIT` and rolls back if any statement does not match
   exactly one row.

Nothing is cached locally; each page of rows is fetched with `LIMIT`/`OFFSET`
on the remote side.

## Project layout

```
src/main/            Electron main process: window, IPC, dialogs
src/main/ssh/        Session (ssh2): exec, SFTP, local port forwarding; host key store
src/main/db/         DatabaseDriver interface, SQLite-over-SSH adapter, PostgreSQL driver
src/main/connections/ ConnectionManager: opens either kind, tunnels, lifecycle
src/main/ai/         plain-English queries: provider adapters, schema index and retrieval, read-only guard, orchestrator
src/main/agent/      sqlite_agent.py – runs on the remote host
src/main/store/      saved connections (secrets encrypted with safeStorage)
src/preload/         contextBridge API exposed as window.api
src/shared/          types shared by main and renderer, export helpers
src/renderer/        React UI (connection screen, workspace, grid, editor); lib/tree.ts drives the virtualized sidebar
test/mock-ssh/       an ssh2-based SSH server used by the tests and for dev
test/docker/         Dockerfiles for real-OpenSSH tests
test/e2e/            Playwright end-to-end test driving the built app
```

## Testing

```bash
npm test             # integration tests: mock SSH server, plus PostgreSQL (uses PG_URL, or a throwaway Docker container)
npm run test:e2e     # builds the app and drives it with Playwright (screenshots in test/e2e/artifacts); covers Postgres when PG_URL is set
npm run test:docker  # real OpenSSH servers in Docker: Alpine with ash, bash and fish login shells, plus one without Python
npm run typecheck
```

The Docker tests build two small images from `alpine:3.20`; if that image cannot be
pulled, point them at any Alpine-flavoured image you already have, e.g.
`DOCKER_BASE=node:24-alpine npm run test:docker`.

The PostgreSQL tests start a `postgres:16-alpine` container unless `PG_URL`
points at a server you provide (set `PG_IMAGE` to use a different image). They
recreate their own tables in that database, so use a scratch database.

The query-builder tests script the model's answers, so they need no key. Set
`TYPESAFE_API_KEY` to also run one live interpretation against the real API.

`npm run dev:server` starts the mock SSH server on port 2222 (user `test`,
password `test`) serving `test/fixtures/sample.db`, which is handy for trying
the UI without a real host.

## Security notes

- Only `exec` and `sftp` channels are used; no shell or port forwarding.
- Host keys are verified before authentication. Accepted keys are stored in
  `known_hosts.json` in the app's user-data directory; the OpenSSH
  `known_hosts` file is read but never written.
- Saved secrets are encrypted with `safeStorage`; if the OS provides no
  encryption the *Save* checkbox is disabled and secrets stay in memory only.
- The `WHERE` filter box takes raw SQL by design, exactly like the query tab.
- The renderer runs with `contextIsolation`, `sandbox` and a strict CSP; it can
  only reach the main process through the small typed API in `src/shared/api.ts`.

## Limitations and ideas

- No jump hosts/ProxyJump and no `~/.ssh/config` parsing yet.
- Remote hosts without any Python 3 are not supported (a `sqlite3`-CLI
  fallback would be a natural addition; the driver interface is isolated in
  `Session`).
- Export covers the rows currently loaded, not whole tables.
- One connection per window.

## Releasing

Tagged commits are built and signed by the Release workflow; see
[docs/RELEASING.md](docs/RELEASING.md) for the macOS certificate and
notarization setup.

## License

MIT. See [LICENSE](LICENSE).
