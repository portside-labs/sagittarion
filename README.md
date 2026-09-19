# SQLite SSH

A desktop GUI for SQLite databases that live on other machines. It connects over
SSH and works on the database file **in place** on the remote host: nothing is
downloaded, nothing is installed on the server, and edits are applied inside
transactions right where the file lives.

Built with Electron, React and TypeScript. The SSH layer uses
[`ssh2`](https://github.com/mscdex/ssh2); the remote side is a small,
standard-library-only Python script that is shipped over the connection each
time you connect.

## Features

- **Connections**: password, private key (with passphrase) or SSH agent
  authentication. Saved connections with per-connection colour; passwords and
  passphrases are stored encrypted with the OS keychain (Electron
  `safeStorage`) only when you tick *Save*.
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
- **SQL editor**: CodeMirror with SQLite syntax highlighting and table/column
  autocomplete. Runs multiple statements, shows a result per statement, reports
  affected rows and errors, runs only the selection if there is one, and can
  cancel long-running queries.
- **Type fidelity**: 64-bit integers beyond JavaScript's safe range, `REAL`
  values such as `2.0`, `NaN`/`Infinity` and blobs all survive the round trip.
- **Export**: loaded rows as CSV, JSON or SQL `INSERT` statements.
- **Read-only mode** per connection; open transactions are shown in the status bar.

## Requirements

- Local: Node.js 20 or newer to build and run from source.
- Remote host: an SSH login and `python3` (3.5 or newer, standard library
  only). Debian/Ubuntu, Fedora/RHEL, Raspberry Pi OS and most NAS systems have
  it already; on Alpine run `apk add python3`. SFTP is optional and only needed
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
src/main/ssh/        Session (ssh2), PythonAgent protocol client, host key store
src/main/agent/      sqlite_agent.py – runs on the remote host
src/main/store/      saved connections (secrets encrypted with safeStorage)
src/preload/         contextBridge API exposed as window.api
src/shared/          types shared by main and renderer, export helpers
src/renderer/        React UI (connection screen, workspace, grid, editor)
test/mock-ssh/       an ssh2-based SSH server used by the tests and for dev
test/docker/         Dockerfiles for real-OpenSSH tests
test/e2e/            Playwright end-to-end test driving the built app
```

## Testing

```bash
npm test             # integration tests against the built-in mock SSH server
npm run test:e2e     # builds the app and drives it with Playwright (screenshots in test/e2e/artifacts)
npm run test:docker  # real OpenSSH servers in Docker: Alpine with ash, bash and fish login shells, plus one without Python
npm run typecheck
```

The Docker tests build two small images from `alpine:3.20`; if that image cannot be
pulled, point them at any Alpine-flavoured image you already have, e.g.
`DOCKER_BASE=node:24-alpine npm run test:docker`.

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
