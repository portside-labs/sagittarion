# Local AI Privacy: design, integration points and plan

Local AI Privacy keeps sensitive database values on this computer when a
question is answered by a model somewhere else. Values are found locally,
handled by a versioned, deterministic policy (most become opaque placeholders),
checked once more, and only then sent. The model's answer comes back with the
placeholders, which are turned back into the real values here, so the chat and
the generated SQL look normal.

It is a technical enforcement layer. It does not make the app, or anyone using
it, "HIPAA compliant", "PCI compliant" or "GDPR compliant", and nothing in the
app or its documentation should say so. Policy profiles named after those
standards (Phase 4) are sets of transformation rules that still have to be
checked against the standard by whoever relies on them.

The invariant:

> When Local AI Privacy applies to a connection, no content crosses to the
> model provider until it has been detected, transformed under a versioned
> policy and verified locally. The mapping from placeholders to values never
> leaves the main process.

## 1. What leaves the device today

Everything the AI sees is assembled in the main process by
`askDatabase` (`src/main/ai/nl2sql.ts`) and sent through one interface,
`LlmProvider` (`src/main/ai/providers/types.ts`). The renderer only sends the
question and the chat history over IPC and gets an `AiResult` back.

| Content | Where it is built | Carries database data? |
| --- | --- | --- |
| Rules block: dialect, server version, today's date, default schema; in a chat across databases, each database's connection name, dialect and key | `systemRules` / `acrossRules` in `ai/prompt.ts` | no (connection names are protected like any text) |
| Schema block: table and column names, types, keys, row estimates, **table comments**, **sample values** (when *Send sample column values* is on) | `SchemaIndex.render` in `ai/schema-index.ts` | yes: samples, comments |
| The user's instructions (Settings → Instructions): the global ones and the connection's own | `instructionsPrompt` in `ai/prompt.ts` | typed by the user; may name people or values |
| The question, and earlier questions of the chat | renderer → `ai:ask` | typed by the user; often names, emails, ids |
| Earlier SQL and clarifications of the chat | renderer → `ai:ask` (`AiTurn`) | literals in `WHERE` clauses |
| `search_schema` / `describe_table` results | `SchemaIndex.search` / `describe` | yes: samples, comments |
| `sample_values` results | `distinctValuesFor` in `main/index.ts` | yes: up to 20 distinct values |
| Repair feedback: EXPLAIN errors | `runQuery` in `nl2sql.ts` | yes: errors echo literals, e.g. `invalid input syntax for type integer: "Jack"` |
| Connector tool results (MCP servers the user connected) | `connectorsForAsk` in `connectors/ask.ts` | yes: whatever the connector returns |
| `run_query` results, only in a chat with more than one database in context and *Let the model read query results* on | `readQuery` in `nl2sql.ts` | yes: up to 50 rows, about 12,000 characters, each value protected with its column as context |
| Embedding requests: table descriptions and the question | `queryVector` in `nl2sql.ts` | comments, the question |
| A name for a new conversation's tab: its first question, sent once more | `conversationTitle` in `ai/title.ts` | typed by the user; protected like the question |
| Connection test ping | `settings:testProvider` in `main/index.ts` | no (fixed text) |

Query results are never sent from a chat on one database. What comes back is
SQL (`propose_query`), an explanation, assumptions, a clarification question
or prose, and tool arguments. The SQL is executed, first under EXPLAIN and
then (with *Run generated queries automatically*) for real, so restoring
values into it is security-sensitive (section 7).

Answers from hosted providers stream as they are written. What is sent does
not change; what comes back is restored for display as it arrives, from the
same vault, holding back any placeholder until all of it has come, so a
half-written one is never shown or restored wrongly. The finished answer is
restored once more and counted, as before. Each streamed response is recorded
whole in "What was sent".

Conversations live on this computer: open ones in the workspace file, and
closed ones in `chat-history.json` (the latest 30, none older than 30 days),
both with the real values the chat shows. Neither is ever sent; a conversation
opened again continues from its sealed turns, as one does after a relaunch.

A chat can have other databases in context, to trace something across them.
Then, and only while *Let the model read query results* is on (Settings →
Models), the model may call `run_query`: one read-only SELECT on one database,
checked like `propose_query` (in its own terms, restored, checked again) and
run under that database's read-only guard. Up to 50 rows come back. Every
value goes through `protectValues` with its column as context, as sample
values do, before the result is added to the conversation; the tool message is
then protected and verified again with the rest of the request. Because the
vault is the conversation's, one value has one placeholder in every database
of the chat, which is what lets the model match a customer in one database to
the same customer in another without seeing who it is.

There is no logging, telemetry, crash reporting or worker-thread code in the
app today; section 11 sets the rules for when there is.

## 2. The trust boundary

```text
 renderer ──ai:ask(question, history, conversationId)──▶ main process
                                                           │
   SchemaIndex ── sample values, comments ──▶ PrivacySession.schemaView()   (column-aware, per request)
   question, history, tool results, errors ──▶ nl2sql builds a ChatRequest
                                                           │
                                                   ModelGateway.complete()
                                                           │
                                   PrivacySession.protectRequest()  ── PiiVault (conversation-scoped, memory only)
                                     detect → resolve → policy → transform → VERIFY
                                                           │
                                                  ProtectedRequest (branded type)
                                                           │
                              LlmProvider.complete(OutboundRequest) ── adapters ── HTTPS ──▶ provider
                                                           │
                                  ChatResponse (still in placeholders; kept verbatim in the transcript)
                                                           │
                              restoreSql() / restoreText() ── only for local use and display
                                                           │
 renderer ◀── AiResult: restored SQL and explanation, a count-only privacy report, sealed turn ──┘
```

Structural guarantees:

- `LlmProvider.complete` and `embed` accept only `OutboundRequest` /
  `OutboundTexts`, branded types minted in one module
  (`src/main/privacy/boundary.ts`). A request is either `ProtectedRequest`,
  produced by `PrivacySession.protectRequest` after verification, or
  `UnprotectedRequest`, produced by `sendUnprotected(req, reason)` with an
  explicit reason (`privacy-off`, `this-device`, `fixed-text`). Handing a
  hand-built request to an adapter is a type error.
- `askDatabase` never holds an `LlmProvider`. It gets a `ModelGateway`, built
  in `main/index.ts` per ask, which either protects everything or carries its
  explicit exemption.
- The vault lives in the main process and is never serialized: `toJSON` and
  `util.inspect` print its id and size only, and its maps are `#private`, so
  `structuredClone`, spreading or `Object.keys` cannot copy them out either. It
  is not part of any type that crosses IPC or reaches an adapter.

### Connectors

Connectors (MCP servers, `src/main/connectors/`) sit on the device side of the
boundary, like the database. When the model calls a connector's tool, the
placeholders in its arguments are restored first, so the connector gets the
real email or name it needs; a tool that is not read-only shows those
arguments in the chat and waits for approval. What the connector returns goes
back to the model as an ordinary tool result: `protectRequest` scans it as
prose with every other field, so personal data in a reply is replaced and
counted before the next request leaves, and verification fails closed on it as
on anything else. A connector is a system of its own: a remote one receives
real values over its own connection, outside this boundary, which is why the
approval card shows exactly what it would get.

## 3. Integration points

| File | Change |
| --- | --- |
| `src/main/ai/providers/types.ts` | `LlmProvider.complete/embed` take `OutboundRequest`/`OutboundTexts`. `SystemBlock` and tool messages gain `structured?: boolean` so schema text is scanned with identifier-safe detectors. Adapters ignore the flag; it never reaches the wire. |
| `src/main/ai/providers/openai.ts`, `anthropic.ts` | Signatures only. |
| `src/main/ai/nl2sql.ts` | Uses `ModelGateway`; renders schema through the session's view; protects `sample_values` results with their column as context; restores SQL with `restoreSql` and prose with `restoreText`; keeps the model's own words (placeholders) in the transcript; turns damaged or unknown placeholders in SQL into a repair round; reports a `privacy` progress stage; returns a count-only report and the sealed turn. |
| `src/main/ai/schema-index.ts` | `RenderView` hook for sample values and comments in `render`, `describe`, `search` and `embeddingText`. The shared index keeps raw samples; each conversation sees its own placeholders. |
| `src/main/index.ts` | Builds the gateway per ask from settings and the endpoint's trust class; owns the conversation vault registry (dropped on `ai:forget`, session close, idle timeout); the connection test uses `sendUnprotected(..., 'fixed-text')`. |
| `src/main/store/settings.ts`, `src/shared/ai.ts` | `AiSettings.privacy` (enabled, policy, schema detection, semantic detection, protect models on this device), persisted beside the agent settings. `AiTurn.sealed`, `AiQueryResult.privacy`, `AiClarification.privacy`, stage `privacy`. |
| `src/shared/api.ts`, `src/preload/index.ts` | `ai.ask(..., conversationId)`, `ai.forget(conversationId)`. |
| `src/renderer/src/components/AskPanel.tsx`, `QueryTab.tsx` | A conversation id per chat (new on reset and after a relaunch); sealed turns replayed as history; a "protected" chip on answers. |
| `src/renderer/src/components/SettingsDialog.tsx` | *Privacy & data protection* section in the AI tab. |
| `src/main/privacy/*` | The subsystem (section 4). |

## 4. Components

`src/main/privacy/`, each piece testable on its own:

```text
PrivacyEngine (engine.ts)             detect → resolve → decide → transform; verify; restore
├── SchemaDetector (detectors/schema.ts)       column classification by table/column name and type;
│                                              key/value pairs in JSON, logs and SQL comparisons
├── Deterministic recognizers (detectors/patterns.ts, validators.ts)
│                                              emails, phones, IPs, MACs, URLs, cards (Luhn), SSNs,
│                                              IBANs (mod 97), routing numbers (ABA), UUIDs, VINs,
│                                              JWTs, bearer tokens, API keys, private keys, and
│                                              context rules for passwords, CVVs, MRNs, DOBs, ids…
├── Name heuristics (detectors/names.ts)       titles, relations ("my son Jonathan"), "named X",
│                                              a given-name gazetteer without ambiguous words
├── Known values (detectors/known-values.ts)   every value already protected in this conversation
├── Semantic model (semantic/)                 GLiNER PII base on this computer, in its own process
│   ├── manifest.ts                            the pinned model: files, sizes, SHA-256s, labels
│   ├── store.ts                               download, per-file hashing, atomic install, re-check before load
│   ├── tokenizer.ts, gliner.ts                DeBERTa-v3 tokenizer and GLiNER processing, in TypeScript
│   ├── runtime.ts, host.ts                    onnxruntime-node (CPU) in an Electron utility process
│   ├── client.ts                              starts it on first use, fails waiting checks if it dies,
│   │                                          ends it after ten quiet minutes
│   ├── detector.ts                            labels to entity types, filters, a cache per text
│   └── manager.ts, platform.ts                status for Settings; where it can run
├── SpanResolver (resolver.ts)                 merges equal spans, unions overlaps, precedence
├── PolicyEngine (policy.ts)                   versioned policies, validation, action combination
├── Transformer (transformer.ts)               placeholders, masks, generalizations, redactions
├── PiiVault (vault.ts)                        token ↔ value, conversation-scoped, memory only
├── Restorer (restore.ts, sql-regions.ts)      exact-match restoration; SQL-literal-aware escaping
└── VerificationEngine (verify.ts)             re-detects on the outgoing text, fails closed
PrivacySession (session.ts)                    one ask: a policy, the conversation's vault, the audit
ModelGateway (gateway.ts)                      the only way nl2sql reaches a provider
boundary.ts                                    ProtectedRequest / UnprotectedRequest / OutboundRequest
conversations.ts                               conversation-scoped vaults: idle timeout, LRU cap
markers.ts                                     placeholder syntax, damaged-placeholder detection
errors.ts                                      PrivacyBlockedError, with findings that hold no values
```

Interfaces follow the spec's shapes with two adaptations to this codebase:

- A request here is a `ChatRequest` (system blocks, messages, tool calls), not
  one string, so the boundary types are `ProtectedRequest`/`OutboundRequest`
  rather than `ProtectedPrompt { sanitizedText }`. The vault id stays in the
  session; the adapter receives only the sanitized request.
- `protect` and `restore` take the vault object rather than a vault id; the
  registry in `main/index.ts` maps conversation ids to vaults.

### Detection context

Every text is scanned with a role:

- `prose`: questions, chat, errors, comments, free-text column values. All
  detectors run.
- `structured`: schema lines and the rules block. Identifier-safe detectors
  only (validated patterns, secrets, known values). Name heuristics and the
  on-device model do not run here, so a table called `Jordan` is not turned into a
  placeholder that the SQL can no longer use. The data inside structured text
  (samples, comments) is protected beforehand with its column as context.
- `value`: one database value with its column. A column classified as, say,
  `EMAIL_ADDRESS` protects the whole value; a free-text column is scanned as
  prose; any other column still gets the identifier-safe detectors.

### Detections and resolution

`SensitiveDetection { start, end, value, type, confidence, source, detector,
metadata }` with offsets into the original text. Resolution is deterministic:

1. Drop detections below the policy's threshold for their type.
2. Overlapping detections form one span covering all of them (conservative
   union semantics), so no detector can leave part of another's match exposed.
3. The span's type comes from its best member: validated deterministic (a
   checksum, a parser, or an exact match of a value already protected) >
   schema > other deterministic > custom > semantic > unknown semantic, then
   the longest, then the most confident. A policy may reorder the sources as an
   explicit exception.
4. The action is that type's, combined with every member of the same rank and
   with any lower-ranked member whose action withholds (redact, mask,
   generalize). A lower-ranked detector can add protection but never remove
   it, so a model cannot "vote away" a deterministic match, while a column that
   says "this is a city" does outrank a name list that thought "Jackson" was a
   person. Combining: `redact` wins; `pseudonymize` wins over
   `mask`/`generalize` but is then never restored; two different partial
   reveals become a redaction. There is no majority voting.

## 5. Placeholders

```text
<|PII:PERSON:A81F32|>          pseudonym, restorable when the policy allows
<|REDACTED:PASSWORD|>          removed; never restored
<|MASKED:CARD:1111|>           partly shown (last four digits); never restored
<|GENERALIZED:DOB:1984|>       coarsened; never restored
```

Pseudonym ids are six hex digits from `crypto.randomBytes`, unique within the
vault and never derived from the value, so there is nothing to brute-force.
The same value in the same conversation always gets the same placeholder;
`PERSON_NAME` and `RELATIVE_NAME` share an identity so "wife Susan" and
"Susan called" stay one person. A different conversation gets different ids.
Two people who only share a first name are not merged: "Jack Smith" and
"Jack Brown" are different values.

Every protected request carries a fixed system block telling the model that
placeholders stand for values it cannot see and must be copied exactly,
including inside SQL string literals, and never expanded or guessed. The
mapping itself is never sent.

## 6. Default policy: `general-pii` v2

| Entity types | Action |
| --- | --- |
| Names, relatives, emails, phones, street addresses, postal codes, locations, dates of birth, government ids (SSN, national id, passport, driver licence, tax id), medical record, insurance and licence numbers, bank accounts, routing numbers, IBANs, IP/MAC addresses, device ids, plates, VINs, usernames, employee/customer/account ids, URLs, employers, organizations, other unique ids, unknown sensitive | pseudonymize, restore locally |
| Card numbers | mask (last four), never restored |
| CVV, card expiry, passwords, API keys, access tokens, private keys, biometric identifiers | redact, never restored |
| City, state, country, age, occupation | preserve |

These are starting defaults, not compliance rules. HIPAA-, PCI- and
GDPR-oriented profiles are Phase 4 and will each be a separate, versioned
policy with its own tests.

v2 added organizations (`<|PII:ORG:…|>`), which only the on-device model
labels; the rules call an organization an employer when the text says so ("I
work at Acme"). Nothing else changed from v1.

## 7. Restoration

Exact matching only. A placeholder is restored when it is well formed, exists
in this conversation's vault and its policy allows restoration. Anything else
is left as it is and counted: unknown placeholders, damaged ones such as
`<|PII:PERSON:A81F32>` or `PII:PERSON:A81F32`, and withheld ones. No fuzzy
matching; a constrained recovery for damaged placeholders can come later.

Prose (explanations, assumptions, clarifications, the progress feed) is
restored by plain replacement. Withheld values are shown as
`[redacted password]`, `[card ending 1111]` and similar.

SQL is restored with a small lexer (`sql-regions.ts`) so a value can never
change the statement's structure:

| Placeholder position | Restored as |
| --- | --- |
| inside `'…'` | value with `'` doubled; inside Postgres `E'…'`/`U&'…'` backslashes doubled too |
| inside `"…"` or SQLite `` `…` `` | value with the closing quote doubled |
| inside SQLite `[…]` | value, unless it contains `]`, which cannot be escaped there (then withheld) |
| inside `$tag$…$tag$` | value, unless it contains the closing tag (then withheld) |
| bare | the number itself when the value is a plain non-negative number, otherwise a quoted string literal; withheld when glued to other tokens (`E<\|…\|>`, `1<\|…\|>`) |
| inside a comment | value, unless it contains a newline or comment delimiter (then withheld) |

The read-only check and EXPLAIN then run on the restored SQL, as before. If the
SQL contains unknown or damaged placeholders, the model gets one of its repair
rounds with a message naming them. If it contains withheld values (a masked
card, a value the policy does not restore), the query is returned with a
warning and is not run automatically.

Errors are never restored: error messages can end up in Electron's console,
so they keep placeholders.

## 8. Conversations and history

A chat has a conversation id, created by the renderer, new when the chat is
reset and after a relaunch. Its vault is kept in memory in the main process,
dropped on reset (`ai:forget`), when the session closes, after 15 idle
minutes, and past 64 live conversations (least recently used first).

Chats are saved in `workspace.json` and reopen after a relaunch, but the vault
must not be persisted. So each answer returns a sealed turn: the question and
the SQL or clarification exactly as the model saw them, plus the offsets of
each placeholder in the restored text. The renderer keeps it with the message
and sends it back as history. The main process then:

1. checks that the sealed text and the restored text line up exactly, and
   re-adopts the placeholders into the conversation's vault (so a follow-up
   after a relaunch can still use them);
2. replays the sealed text, which is what the model saw before;
3. falls back to protecting the restored text when there is no valid sealed
   form (turns from before privacy was on, or tampered data).

Nothing in a sealed turn is sensitive: placeholders and offsets only.

## 9. Verification and failing closed

Protection runs in passes over all the texts of a request together: each pass
detects (including every value already protected in the conversation) and
replaces what it finds, and the next pass sees the new values as known. So a
value found in one field is protected in every field, whatever their order. It
stops when a pass finds nothing new, after at most four.

Then every outgoing field (system blocks, messages, tool call arguments, tool
definitions, embedding inputs) is scanned again, independently, with
placeholders masked out:

- any detection the policy would transform is a leak;
- any value already in the vault, appearing raw, is a leak;
- a damaged placeholder in text the app wrote is an integrity failure.

Any of these throws `PrivacyBlockedError` and nothing is sent. So does an
invalid policy, a detector that throws, or a transformation with invalid
offsets. The chat shows what happened in counts and places, never values:
"Local AI Privacy stopped this request before anything was sent: 1 phone
number in a database error could not be protected." There is no fallback to
sending raw data; lower protection is only ever an explicit setting.

## 10. Which connections are protected

Protection follows the endpoint, not the preset. `classifyEndpoint` parses the
connection's base URL: loopback (`localhost`, `*.localhost`, `127.0.0.0/8`,
`::1`) is *this device*; everything else, including LAN addresses and company
gateways, is *external*.

- External: protected whenever Local AI Privacy is on.
- This device: protected only with *Also protect models on this computer*.

So an "OpenAI-compatible server" at `https://llm.example.com` is protected and
Ollama at `http://localhost:11434` is not, by default.

## 11. Logging, audit and telemetry

The privacy code never logs. Error messages name types, counts and places.
The audit record of an ask holds only non-sensitive metadata: engine version,
policy id and version, detectors with versions, semantic model id/version/hash
(none yet), counts by type and action, verification result, restoration
counts, timestamp. It is returned with the answer and shown as counts in the
chat.

If crash reporting, telemetry or logging is added later: never include
`PiiVault`, `SensitiveDetection` objects, request bodies of protected
requests before protection, or restored model output.

## 11a. Transparency: what was sent

The user can check any answer. *What was sent* (and the "protected" chip) opens
the exchange inspector, which shows the ask's traffic with the provider as it
went over the network:

- **Recorded at the fetch layer.** A `WireRecorder` (`src/main/ai/wire.ts`)
  wraps the `fetch` the adapters use for that ask and keeps each request body
  and response body byte for byte, with method, address, status and timing.
  Headers are never recorded (they carry the API key); query-string values and
  credentials in the address are blanked. Bodies over 8 MB (requests) or 2 MB
  (responses) keep their beginning and record their full size.
- **A legend that proves absence.** Every value protected during the ask is
  listed with its placeholder, its kind and where it was found (the question,
  sample values, a table comment, database feedback…), and the number of times
  the value itself occurs in everything that was sent, counted on the exact
  bytes in plain and JSON-escaped form. The count should be 0; if it is not, it
  says so. A search box runs the same check for any text.
- **Values only on request.** The transcript holds placeholders and counts, no
  values. *Show values on this computer* asks the main process for them, which
  answers only for placeholders the policy restores anyway, only while the
  chat's vault is still in memory; secrets, masks and generalizations are
  never shown. Turning it off fetches the transcript without them again.
- **Memory only.** Transcripts live in the main process (`TranscriptStore`),
  at most 40 asks or 32 MB, dropped when the chat is reset or its connection
  closes. They are not written to disk, so an answer restored after a relaunch
  has no *What was sent*.
- **Readable and raw.** The readable view parses the exact bodies of the
  OpenAI, Anthropic and embeddings protocols into labelled sections (long
  system prompts and tool definitions start folded); the raw view shows the
  bytes. *Copy* copies the exact body. Blocked asks show that nothing was sent,
  and why.

## 12. Settings

Settings → AI → *Privacy & data protection*:

- Protect sensitive data before it leaves this device (on by default)
- Detection: pattern recognizers (always on while protection is on),
  database schema detection (on), and the on-device model (off). The model's
  switch is offered once it is installed; its row names the model, publisher,
  licence and size, with Download (with progress and Cancel) or Remove. Remove
  deletes the files and switches semantic detection off. On a computer that
  cannot run it, the row says why.
- Privacy policy: General PII (v2)
- Also protect models on this computer (off)
- A line saying whether the current connection is external and protected

The model is a detector, never presented as a provider. Settings shows its
download size; its speed and memory are measured in section 13.

## 13. Phases

| Phase | Scope | Status |
| --- | --- | --- |
| 1. Core | taxonomy, detector interface, deterministic recognizers with validators, resolver, versioned policy engine, transformer, vault, text and SQL restoration, verification, branded provider boundary, gateway, conversation scope and sealed history, settings, audit report, tests | done |
| 2. Database awareness | column classification by table and column name, declared type and comment; labelled values in JSON, logs, SQL comparisons and CSV; columns the schema cannot place classified from their sampled values, per request (a view's `name` column full of people becomes a names column), with the on-device model voting too when it is on. Left: constraints as evidence | done |
| 3. On-device model | GLiNER PII base as quantized ONNX, run by `onnxruntime-node` (CPU) in an Electron utility process; the tokenizer and GLiNER's processing ported to TypeScript and pinned to the reference by golden tests; a manifest with per-file SHA-256, downloaded on demand into `userData/models/<id>/<version>` and checked again before every load; loaded on first use, unloaded when idle; the evaluation corpus run through rules and model | done |
| 4. Policy profiles | HIPAA-, PCI-, GDPR-oriented and custom policies, each versioned and tested | later |
| 5. Hardening | larger adversarial corpus, benchmarks per platform, audit review of any future telemetry or crash reporting, model lifecycle | later |

### Phase 3: the on-device model

**Nothing Python at run time.** Python, PyTorch and the `gliner` package are
used on a developer's machine only: to compare candidate models on the corpus
and to generate the golden fixtures (`scripts/gliner-golden.py`). The shipped
app runs the published ONNX graph with `onnxruntime-node`: tokenization,
inputs, inference and decoding are all TypeScript. Nothing Python ships in the
app or is downloaded for the model. (Separately from the model, local SQLite
connections still use a small `python3` helper, as before.)

**Process.** The model runs in an Electron utility process
(`utilityProcess.fork`, "Sagittarion privacy model"): plain Node, no window, no
access to the vault. The main process sends it texts and gets spans back. If it
cannot load, crashes, or stops answering, every check waiting on it fails and
the ask stops with the reason; it never goes out with less protection than the
user chose. It starts on the first question that needs it and ends after ten
quiet minutes, giving its memory back.

**Choosing the model.** Three Apache-2.0 GLiNER PII models were run through
the reference implementation on the corpus, model alone, and a fourth was ruled
out on size:

| Model (quantized ONNX) | Download | Semantic tier found | Ordinary questions flagged |
| --- | --- | --- | --- |
| knowledgator/gliner-pii-edge-v1.0 | 46 MB | 5 of 10 | 0 |
| knowledgator/gliner-pii-small-v1.0 | 83 MB | 3 of 10 | 2 |
| **knowledgator/gliner-pii-base-v1.0** | **197 MB** | **7–8 of 10** | **1–3** |
| urchade/gliner_multi_pii-v1 (onnx-community) | 349 MB | not run: larger, and no better on the publisher's benchmark | |

The base model (DeBERTa-v3-small, span mode) is pinned at commit
`61726e0a`. Asked for twenty-odd PII labels at once its scores fall below any
useful threshold, so it is asked for ten, at 0.5:

| Label | Becomes |
| --- | --- |
| name | person name |
| location address | street address |
| location city, location state, location country | city, state, country (kept by the policy; asking keeps "Charlotte" and "Paris" from being read as people) |
| organization, organization medical facility | organization |
| password | password (redacted) |
| phone number | phone number |
| date | nothing: asked for so a month or a date is not read as a name |

A password that is a word for passwords ("the password field", "password is
null") and a name that is a word for a person's field (a CSV header `name`,
"customer") are dropped.

**What the model reads.** Prose and free-text values written on this side:
questions, database errors, comments, samples. Not structured text, not codes,
not values their column already identifies, and not the provider's own replies
and tool calls: those were written from what was already sent, so they hold
nothing new, and they are mostly SQL and table names. It reads each text as it
is, placeholders included, and whatever it marks in or against a placeholder is
dropped. Blanking the placeholders out was tried first: with a value's slot
empty, the model took the field name beside it for the value (`card_number`,
`IBAN`, a CSV header).

**Names in the database are never values.** A detection that is exactly a
table or column name is dropped, whichever detector made it, and so is a match
of such a name already in the chat's vault. On its own the model reads
`inspection_inspector` as an organization; made into a placeholder, the name
vanished from the schema the provider saw (a protected value is protected
everywhere), came back in its SQL as a quoted string, and the ask could not
produce a query. The model's password label is ignored on a lone database
value too: out of context it only means the value looks random, as codes and
ids do; columns of secrets are recognised by name.

**One text at a time.** The graph quantizes activations dynamically (31
`DynamicQuantizeLinear` nodes), with one scale per batch, so the same text
scores differently depending on what else is in its batch. Each text runs on
its own: results match the reference and never depend on other texts. Results
are cached per text, so the history and schema that every request of an ask
repeats are read once.

**Tokenizer.** The port implements `tokenizer.json` as the Rust `tokenizers`
library runs it: Strip, SentencePiece's precompiled character map, Replace,
Metaspace, Unigram. transformers 5 replaces this normalizer for DeBERTa-v2
tokenizers with its own (no compatibility folding); the model was trained with
transformers 4.55 and the file's normalization, so the golden fixtures pin
that. Two deliberate differences from the reference: special tokens typed in
the user's text are ordinary characters, not prompt structure, and a word
that makes no tokens (a lone control character) is left out rather than
shifting every later word's offsets.

**Download and integrity.** The manifest ships inside the app and is the
trust anchor: no remote manifest, so no separate signature. Each file comes
from the pinned commit, streams into a fresh staging folder while being hashed,
and must match its size and SHA-256; only then are the files moved into place
together. A failed, cancelled or tampered download leaves nothing. Before every
load the installed files are hashed again (71 ms); an altered file stops the
model, Settings says so, and asks fail closed until it is downloaded again.

**Where it runs.** The platforms `onnxruntime-node` 1.30 ships binaries for:
macOS 14 or later on Apple silicon, 64-bit Windows (x64 and arm64), 64-bit
Linux with glibc 2.28 or later. Elsewhere, including Intel Macs, Settings says
it cannot run there. The Windows binaries link the Microsoft Visual C++
2015–2022 runtime; before a Windows release, confirm on a clean machine and
ship those DLLs or the redistributable with the installer. Packaged builds keep
only the target platform's binaries, unpacked from the app archive (44 MB on
macOS arm64).

**Cost**, Apple M5, four threads, the model loaded in its own process:

| | |
| --- | --- |
| Check the files before loading (205 MB, SHA-256) | 71 ms |
| Load | 0.3 s |
| A question (14 words) | 8 ms |
| A paragraph (228 words) | 66 ms |
| 21 KB of prose (3,600 words, 256-word windows) | 1.8 s |
| Sample values | 6 ms each |
| Memory while loaded | about 425 MB |

## 14. Testing

- Unit tests per component (`test/privacy/*.test.ts`).
- The built app, driven with Playwright against a mock OpenAI-compatible server
  that records what it receives. This found two leaks the unit tests had not:
  "Grace Hopper" (a first name that is also a word, and a surname not on the
  list) and first names left beside a detected surname in a view's `name`
  column. Both are fixed and in the corpus.
- The first milestone, verbatim: "Jack has a phone number that is 867-5309."
  becomes two placeholders, a mock provider receives only those, its reply is
  restored to "Yes, Jack's phone number is 867-5309.", and the test proves
  neither value crossed the boundary.
- Trust-boundary regression tests for every remote preset (OpenAI, Gemini,
  OpenRouter, Groq through the OpenAI adapter; Anthropic), asserting on the
  exact HTTP bodies, for chat and embedding requests, and that nothing is
  fetched when protection fails.
- The orchestrator end to end with privacy on: questions with emails and ids,
  sample values from a names column, EXPLAIN errors that echo restored values,
  follow-ups after a relaunch, damaged placeholders in SQL, withheld values.
- An evaluation corpus (`test/privacy/corpus.ts`) with normal and adversarial
  cases (punctuation, Unicode, multilingual names, odd phone formats, typos,
  JSON, SQL, CSV, logs, Markdown, nested objects, long text). It reports
  precision, recall, F1, false-negative and false-positive rates, and asserts
  recall on the cases deterministic detection is expected to handle. Cases
  that need the semantic model are measured but not asserted, so the gap is
  visible.
- A holdout set is never tuned against. It must not live in this public
  repository: point `PRIVACY_HOLDOUT` at a JSONL file elsewhere and the same
  harness reports on it (aggregates only; `PRIVACY_HOLDOUT_MIN_RECALL` makes
  its recall an assertion).
- Performance and hostile input: a 120k-character schema block and inputs built
  to make regexes backtrack must protect and verify within generous bounds.
- The model's port against the reference (`test/privacy/semantic/golden.test.ts`,
  fixtures from `scripts/gliner-golden.py`): for 92 texts (the corpus and Unicode
  edge cases) the same words at the same offsets, the same token ids and word
  masks, and the same entities with scores within 0.002. Word splitting and the
  character map (with its fixture) are checked on every run; tokens and
  entities when `SAGITTARION_GLINER_DIR` points at the model's files.
- The model's plumbing without the model: labels and filters, what the engine
  shows it, that it adds protection and never removes any, the download (bad
  digests, wrong sizes, missing files, cancellation, tampering after install),
  and its process (lazy start, crashes, hangs, idle unload, cancellation).
  With the model, the real process is started under Node.
- The built app with the model: `SAGITTARION_GLINER_DIR=… npm run
  test:e2e:model` asks about a name only the model finds, checks the mock
  provider saw a placeholder, the SQL came back restored, and the model ran in
  its utility process.

### Results at the end of Phase 1

Evaluation corpus (`test/privacy/corpus.ts`, entity level; a value counts as
found only when every character of it is covered):

| Tier | Cases | Values | Recall | Precision | False-positive rate (words) |
| --- | --- | --- | --- | --- | --- |
| deterministic | 43 | 91 | 1.00 | 0.99 | 0.029 |
| negative (ordinary questions, SQL, logs) | 19 | 0 | n/a | n/a | 0.00 |
| semantic (needs the model) | 8 | 10 | 0.20 | 1.00 | 0.00 |

The deterministic numbers are on the development set the rules were tuned
against, so they are an upper bound; the holdout is the honest number. The
semantic tier is the Phase 3 target: rare names, names in scripts without
capitals, places and employers without a telling phrase, misspelled labels,
spelled-out numbers.

Measured cost of protect + verify on an Apple M5, median of five runs: a
194 KB schema block 14 ms, 32 KB of prose with 1,200 entities 29 ms, a typical
question 0.1 ms. Deterministic protection is cheap enough for the main process;
the model has a process of its own.

### Results with the on-device model

The same corpus through rules and model:

| Tier | Recall | Precision | False-positive rate (words) |
| --- | --- | --- | --- |
| deterministic | 1.00 | 0.96 | 0.063 |
| negative | n/a | n/a | 0.012 |
| semantic | 0.80 | 1.00 | 0.00 |

Still missed: a phone number spelled out in words, and "Bill" alone ("Bill
from accounting approved it"). Protected though not expected: "Chase Bank" in a
sales question (an organization, which policy v2 protects), and a verb beside
a name taken into it ("Llamé a", "Звонил"). Extra placeholders cost the model
some context but not correctness: they are restored here.

## 15. Known limitations

- Without the on-device model (off, not installed, or a computer it cannot run
  on), names are found by titles, relations, "named X" and a gazetteer of
  common given names; unusual names without such context, and non-Latin
  scripts, are missed.
- The model was trained on English. It found names in Spanish, German, Russian,
  Arabic and Chinese in the tests, but other languages are not measured, and a
  script written without spaces is one word to it: a Chinese clause becomes one
  placeholder.
- Spelled-out numbers and a lone ambiguous first name are missed even with the
  model.
- With the model on, organizations are placeholders even when they are not
  personal (a bank in a sales question). They are restored here, so the SQL is
  unaffected.
- A value that is exactly a table or column name is never protected, so a
  person whose name is spelled exactly like one (a column called `grant`, a
  table called `Jordan`) is not either.
- The model holds about 425 MB while loaded and takes about 2 s for 3,600
  words; sample values from many free-text columns add up the first time an
  ask shows them.
- Ambiguous words that are also names (May, Jordan, Grant) are only treated as
  names with context, to keep month names and places usable in questions.
- Pseudonymizing a value hides what kind of value it is beyond its type, which
  can occasionally make the model pick a different column. The restored SQL is
  still exact.
- A placeholder in a table comment or sample value changes the schema block
  between conversations, which costs a prompt-cache miss on the first request
  of each chat.
- A connection URL with a password in it is withheld as a whole (the password
  forces redaction of the span that contains it), so the model loses the host
  and database name too.
- Values discovered as sensitive only later in an ask (say, by a tool result)
  are protected from then on; if no detector recognised them earlier in the
  same ask, an earlier request may already have carried them. Sample values
  and comments are protected before the question for this reason.
- One policy exists so far. The selector is there for the Phase 4 profiles.
