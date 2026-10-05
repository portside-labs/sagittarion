# Development

Sagittarion is an Electron app written in TypeScript with a React renderer.
Building it needs Node.js 22.12 or newer; opening SQLite files needs `python3`.

```bash
npm install
npm run dev          # start with hot reload
npm run build        # production build into out/
npm start            # run the production build
npm run dist         # package for the current platform into release/
npm run typecheck    # main and renderer projects
npm run dev:server   # mock SSH server for trying the UI without a real host
```

The mock SSH server listens on port 2222 (user `test`, password `test`) and
serves `test/fixtures/sample.db`.

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

**SQLite** goes through a small helper, `src/main/agent/sqlite_agent.py`, that
uses only Python's standard library.

1. Over SSH, `Session` (`src/main/ssh/session.ts`) runs a short `sh -c` probe
   to find `python3` (or `python` if it is Python 3). The probe works under
   bash, dash, zsh, fish, csh and busybox ash. For a file on this computer,
   `LocalSession` starts the same helper as a child process instead.
2. The helper is started with a single `exec` request, passed base64-encoded
   on the command line, so no file is written on the server. It prints a ready
   line containing a random token; anything before it (MOTD-style `.bashrc`
   output, for example) is ignored.
3. Requests and responses are newline-delimited JSON over stdin/stdout
   (`PythonAgent`, `src/main/ssh/agent.ts`). A reader thread in the helper
   handles `cancel` out of band by calling `sqlite3.Connection.interrupt()`.
4. Values that JSON cannot represent are tagged: big integers as
   `{"$type":"int","value":"…"}`, blobs as base64 (with a size and truncation
   flag above 1 MiB), integral or special floats as `{"$type":"float",…}`.
5. Staged edits become one `apply` request, run inside
   `BEGIN IMMEDIATE … COMMIT` and rolled back if any statement does not match
   exactly one row. Rows are addressed by `rowid`, or by primary key for
   `WITHOUT ROWID` tables.

Nothing is cached locally; each page of rows is fetched with `LIMIT`/`OFFSET`.

**PostgreSQL** uses `pg`, directly or through a local port forwarded over SSH.
SSL follows libpq's `sslmode`: the CA certificate, client certificate and key
a connection names are read from this computer on every connect, PEM or DER,
with an encrypted key decrypted in memory (`src/main/db/pg-tls.ts`). As in
libpq, a CA certificate is checked in every mode but `disable`, and only
`verify-full` checks the host name. Rows are addressed by primary key, so tables without one are read-only in the
grid. `bigint`, `numeric`, timestamps, arrays, JSON and UUIDs keep the
server's text form, so nothing rounds. Query results are read through a
cursor, so a `SELECT` without a `LIMIT` fetches only what the limit dropdown
allows.

**The schema sidebar** never loads a whole schema. Connecting fetches schema
names and object counts, then streams table and view names; columns, indexes,
triggers and functions load when their node is opened. The tree is
virtualized (`src/renderer/src/lib/tree.ts`).

**Ask** (`src/main/ai/`) keeps a local index of the schema and gives the model
only what a question needs:

- Each table is one compact line, e.g.
  `orders(id int pk, user_id int fk->users.id, status text {paid|pending|refunded}, total numeric, placed_at timestamp) ~12k rows`.
- If the whole schema fits the context budget (about 8k tokens by default), it
  is sent every time and prompt caching keeps repeat questions cheap.
  Otherwise tables are ranked with BM25 over table and column names,
  optionally fused with embeddings, expanded one hop along foreign keys and
  added until the budget is full.
- The model can look further with `search_schema`, `describe_table`,
  `sample_values` and `propose_query`.
- Instructions from Settings → Instructions, global or for chosen connections,
  go into the system prompt after the fixed rules, which win where they
  disagree. They are protected as prose, and the steps name the ones followed.
- The answer must be a single `SELECT` (or `WITH … SELECT`). It is run through
  `EXPLAIN` first, with errors sent back for up to two repairs, and executes
  under SQLite's `query_only` pragma or a PostgreSQL `READ ONLY` transaction.

Where the user lets Ask read results (`AgentSettings.readResults`: every
connection, or chosen ones; none by default), the model works questions out
instead of writing one query: it has `run_query` (up to 50 rows, protected),
rules that tell it to look things up before asking and to say what it
assumed, and sees what earlier answers' queries returned in the editor.

Every request is billed, so an ask makes at most `AgentSettings.maxRequests`
of them (6 unless the user picks otherwise), the last forced to answer: in
words where the model reads results or uses connectors, with `propose_query`
otherwise. The rules tell the model its budget and to call independent tools
together. Anthropic requests cache the conversation as well as the prompt, so
the steps of one question read it back instead of paying for it again;
embeddings are cached by each table's own text; long earlier answers are
replayed shortened; and a new conversation's name comes with its first answer
rather than in a request of its own.

**Business knowledge** (`src/main/knowledge/`) is what Ask learns about the
business behind each saved connection, so questions can be asked in its own
words. It is kept per connection in `knowledge/<id>.json` (`KnowledgeStore`),
and turned off with `AgentSettings.learn`.

- What it holds: terms (a word the business uses, what it means, the SQL
  condition or expression for it and its tables) and rules; domains and
  subdomains, with their tables (`Marketing › Programs`); the runbook, queries
  that answered business questions, with `:parameters`; the statements run on
  the connection, by shape; joins seen in them and what triggers, functions
  and views read and write (`DataLink`); and the text values queries compared
  columns with.
- How it learns without the model: every read statement run in the editor or
  by the model is read by `analyzeSql` (`sql-facts.ts`) for its tables, joins
  and values; tables are outlined into domains by schema, name and foreign
  keys (`domains.ts`); after an ask, the triggers and definitions of the
  tables it used are read for how data moves (`flow.ts`), a few at a time.
- How the model adds to it: `learn` (a term, rule or domain) and `save_query`
  (a runbook entry, checked with `EXPLAIN` first), kept at once without asking
  the user. They need no reply, so they ride along with the answer or other
  tool calls rather than costing a request. Each item says where it came from
  (`user`, `data`, `inferred`, `structure`), which sets how far it is trusted:
  a correction keeps what it replaced, and what the user said gives way only
  to the user. Answers built on a term make it surer, more so when the user
  runs the query; forgetting an item under an answer undoes it.
- How it is used: `recall` (`recall.ts`) matches the question, with no model
  call, against terms, values, the runbook and domains. The tables they point
  at go into the schema excerpt even when the question names none, and a
  "What this team means" section follows the schema. `run_saved_query` runs a
  runbook entry with its values bound in, and `describe_table` adds a table's
  domain, terms, runbook entries and data flow.

The chat is one pane beside every connection (`ChatPane`), its conversations
in tabs (`chats` in the app store, saved with the workspace). Each has its own
placeholder scope, forgotten when its tab closes, and asks in several tabs can
run at once. A closed conversation goes to `chat-history.json`
(`ChatHistoryStore`: the latest 30, none older than 30 days), and opens again
from the clock in the chat's header. Answers from hosted providers stream
(`readEventStream` in `providers/types.ts`; local servers answer whole, as
their streamed tool calls vary); the renderer reveals any answer at an easing
pace (`lib/reveal.ts`), so a stream that comes in bursts, or an answer that
arrives at once, unfolds evenly. The first question of a conversation also
asks the model for a short name for its tab, which comes with the answer. A conversation follows the connection in front until its first
question, then keeps the databases it has in context; more can be added from
the bar above the input, and are connected in the background.
With more than one, an ask gets them all (`AskOptions.databases`): each is
known to the model by a key (`db1`, `db2`, …), every tool takes the key, the
schema budget is shared between them, and on those whose results it may read
the model follows a record from one database to the next with `run_query`. A proposed query names its
database, and the chat opens it in that connection's editor
(`openSql` in `store.ts`).

**Connectors** (`src/main/connectors/`) are MCP servers whose tools Ask can
use, like connectors in Claude Desktop. `ConnectorManager` runs each one with
the official MCP SDK, bundled into the main process: a local command over
stdio, started with the login shell's `PATH` so `npx` and `uvx` resolve, or a
remote server over Streamable HTTP with an SSE fallback. Clients start when
first needed and stop after ten idle minutes. An ask offers the tools of the
connectors on for its chat as `mcp__<connector>__<tool>`; read-only tools run
freely, and the rest wait for approval in the chat unless Settings says
otherwise.

A remote server that answers 401 gets OAuth as MCP specifies it
(`connectors/oauth.ts`, on the SDK's `auth`): discovery of its authorization
server, dynamic client registration (or a client ID and secret the user
registered), and the authorization code flow with PKCE and a resource
indicator. Signing in is only ever started from Settings or the chat's
connectors menu: the sign-in page opens in the default browser, which comes
back to a page served on `127.0.0.1` for the few minutes it may take.
Otherwise the provider only presents and refreshes saved tokens, and stops with
"Sign in to …" rather than open a browser in the middle of an ask. Tokens and
the registration are kept encrypted with the connector.

**Local AI Privacy** (`src/main/privacy/`) sits between Ask and every remote
provider. [LOCAL_AI_PRIVACY.md](LOCAL_AI_PRIVACY.md) has the design, the
evaluation and the roadmap.

## Project layout

```
src/main/                   Electron main process: window, IPC, dialogs
src/main/ssh/               SSH sessions (exec, SFTP, port forwarding), local sessions, host key store
src/main/db/                DatabaseDriver interface, SQLite and PostgreSQL drivers
src/main/connections/       ConnectionManager: opens either kind, tunnels, lifecycle
src/main/agent/             sqlite_agent.py, the helper that opens SQLite files
src/main/ai/                Ask: provider adapters, schema index and retrieval, read-only guard, orchestrator
src/main/knowledge/         business knowledge: SQL reading, store, domains, recall, data flow
src/main/privacy/           Local AI Privacy: detectors, policies, placeholder vault, restoration, verification
src/main/privacy/semantic/  the optional on-device model: manifest, download, tokenizer, ONNX Runtime process
src/main/connectors/        MCP connectors: settings store, clients, tools for an ask, approvals
src/main/store/             saved connections, SSH profiles, settings, workspace (secrets encrypted with safeStorage)
src/preload/                contextBridge API exposed as window.api
src/shared/                 types shared by main and renderer, export helpers
src/renderer/               React UI: connection screen, workspace, grid, editor, Ask panel
scripts/                    developer tools, e.g. golden fixtures for the on-device model (never shipped)
test/mock-ssh/              an ssh2-based SSH server used by the tests and dev:server
test/docker/                Dockerfiles for real-OpenSSH tests
test/privacy/               Local AI Privacy tests and evaluation corpus
test/e2e/                   Playwright end-to-end tests driving the built app
```

## Testing

```bash
npm test                 # unit and integration tests, PostgreSQL included when available
npm run test:e2e         # builds the app and drives it with Playwright (screenshots in test/e2e/artifacts)
npm run test:e2e:model   # the same, with the on-device privacy model
npm run test:docker      # real OpenSSH servers in Docker
```

- **PostgreSQL** tests use `PG_URL` if it is set, otherwise a throwaway
  `postgres:16-alpine` container (`PG_IMAGE` picks another image), and skip
  when neither is available. They recreate their own tables, so point `PG_URL`
  at a scratch database. `npm run test:e2e` covers Postgres too when `PG_URL`
  is set.
- **SSL certificate** tests make a CA, server and client certificates with
  the `openssl` command line, and check the handshakes against a stand-in
  server that answers PostgreSQL's SSL request (`test/pg-tls-server.mjs`).
  `npm run test:e2e` goes through the same from the connection form, with
  Electron's own TLS. With `DOCKER_TESTS=1` they also run a
  `postgres:16-alpine` with SSL on and a user that signs in with a client
  certificate.
- **Docker** tests run Alpine with ash, bash and fish login shells, plus one
  host without Python. They build from `alpine:3.20`; if that cannot be
  pulled, use an Alpine-flavoured image you already have, e.g.
  `DOCKER_BASE=node:24-alpine npm run test:docker`.
- **Ask** tests script the model's answers, so they need no API key.
- **Local AI Privacy** tests (`test/privacy/`) inspect the exact HTTP bodies
  sent to every remote provider and report precision, recall and
  false-positive rates on an evaluation corpus. Set `PRIVACY_HOLDOUT` to a
  JSONL file of held-out cases kept outside this repository to measure against
  data never used for tuning (`PRIVACY_HOLDOUT_MIN_RECALL` turns its recall
  into an assertion).
- **The on-device model**'s TypeScript port is checked against the reference
  GLiNER implementation with golden fixtures (`scripts/gliner-golden.py`
  regenerates them). Tests that need the model's files, and
  `npm run test:e2e:model`, run when `SAGITTARION_GLINER_DIR` points at a
  directory holding `gliner_config.json`, `tokenizer.json` and
  `onnx/model_quint8.onnx`.

## Security notes

- SSH sessions open only `exec` and `sftp` channels, plus a forwarded port for
  PostgreSQL tunnels; never a shell.
- Host keys are verified before authentication: trust on first use with a
  fingerprint prompt, with `~/.ssh/known_hosts` (plain, port-qualified and
  hashed entries) as a second source. Accepted keys are stored in
  `known_hosts.json` in the app's user-data directory; the OpenSSH file is read
  but never written. A changed key produces a loud warning.
- Saved passwords, passphrases and API keys are encrypted with the OS keychain
  through Electron's `safeStorage`. If the OS provides no encryption, *Save* is
  disabled and secrets stay in memory only.
- The renderer runs with `contextIsolation`, `sandbox` and a strict CSP, and
  reaches the main process only through the typed API in `src/shared/api.ts`.
- The `WHERE` filter box takes raw SQL by design, exactly like the query tab.
- Connectors run the commands and reach the servers the user configured, as in
  Claude Desktop. Their environment variables and headers are encrypted like
  other secrets and never sent to the renderer. A tool that is not read-only
  asks in the chat first, showing the arguments it would get.
- Provider adapters accept only requests that passed Local AI Privacy or carry
  an explicit exemption (privacy off, a model on this computer, fixed text such
  as the connection test); the types in `src/main/privacy/boundary.ts` enforce
  it. Privacy errors name kinds of values and places, never values, because
  Electron prints IPC errors to the console.

## Known gaps

- No jump hosts (`ProxyJump`) and no `~/.ssh/config` parsing yet.
- Hosts without Python 3 are not supported; a `sqlite3`-CLI fallback would fit
  behind the driver interface.
- Export covers the rows currently loaded, not whole tables.
- Remote connectors that need OAuth sign-in are not supported yet; they need an
  API key in a header instead.

## Releasing

Tagged commits are built by the Release workflow; see
[RELEASING.md](RELEASING.md).
