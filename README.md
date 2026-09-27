<p align="center"><a href="https://portsidelabs.io/sagittarion"><img src="build/icon.svg" width="128" alt="Sagittarion logo"></a></p>

<h1 align="center">Sagittarion</h1>

<p align="center">
<a href="https://github.com/portside-labs/sagittarion/releases/latest"><img src="https://img.shields.io/github/v/release/portside-labs/sagittarion" alt="Latest Release"></a>
<a href="https://github.com/portside-labs/sagittarion/releases/latest"><img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue" alt="Platforms"></a>
<a href="LICENSE"><img src="https://img.shields.io/github/license/portside-labs/sagittarion" alt="License"></a>
</p>

## About Sagittarion

Sagittarion is a free, open-source desktop client for SQLite and PostgreSQL.
Browse, edit and query your data, or ask for it in plain English.

- **SQLite, local or over SSH.** Remote files are opened in place, with
  nothing installed on the server.
- **PostgreSQL, direct or through an SSH tunnel.** The sidebar stays quick
  even with a hundred thousand tables.
- **Staged edits.** Review your changes, then apply them together in a single
  transaction.
- **A statement-aware SQL editor.** It runs the statement under the cursor and
  suggests what fits where you're typing.
- **Ask in plain English.** Bring your own OpenAI, Anthropic, Gemini,
  OpenRouter or Groq key, or run a model locally with Ollama or LM Studio.
  Generated SQL is read-only and checked with `EXPLAIN` before it runs.
- **[Local AI Privacy](docs/LOCAL_AI_PRIVACY.md).** Names, emails, card
  numbers and other sensitive values are swapped for placeholders before a
  request leaves your computer.
- **Several connections at once.** Group and colour-code them; every tab comes
  back as you left it.

No account, no telemetry.

## Download

Get the latest build for macOS, Windows or Linux from
[Releases](https://github.com/portside-labs/sagittarion/releases/latest).

SQLite needs `python3` 3.5 or newer wherever the database file lives. Most
servers already have it; on a Mac, the Xcode Command Line Tools provide it.
PostgreSQL needs version 12 or newer.

## Development

Sagittarion is built with Electron, React and TypeScript, and needs Node.js
22.12 or newer to run from source.

```bash
npm install
npm run dev     # start with hot reload
npm test        # unit and integration tests
npm run dist    # package for this platform into release/
```

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) covers how it works, the project
layout and the full test setup.

## Security Vulnerabilities

If you discover a security vulnerability in Sagittarion, please email
[hello@portsidelabs.io](mailto:hello@portsidelabs.io) instead of opening a
public issue.

## License

Sagittarion is open-source software licensed under the
[MIT license](LICENSE).
