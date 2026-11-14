---
name: ledger-module
description: Work on this Ledger module (a plugin for the Ledger bookkeeping app, installed from this GitHub repository): add features, fix bugs, update it for new Ledger versions, check it, and release it. Use for any change to this repository's module code, manifest, migrations, UI or releases.
---

# Working on this Ledger module

This repository is a **Ledger module**: `ledger-module.json` (manifest),
`server.mjs` (runs inside the Ledger server), `ui/` (its page in Ledger) and
`migrations/` (SQL in its own schema). Ledger installs the latest GitHub
Release of this repository. Ledger itself is
[mastifdogo/Bookeeping](https://github.com/mastifdogo/Bookeeping).

## 1. Get a Ledger checkout and read the module API

The API reference and the full workflow live in the Ledger repository.

- Use `$LEDGER_DIR`, a sibling checkout (`../Accounting`, `../Bookeeping`),
  or clone one: `git clone --depth 1 https://github.com/mastifdogo/Bookeeping /tmp/ledger-for-modules`
  (`scripts/check.sh` does this for you).
- Read **`<ledger>/docs/MODULE_LLM_CONTEXT.md`** in full before changing
  anything: manifest, `ctx` API and return shapes, `ctx.settings`,
  `ctx.dashboard`, `ctx.llm`, `ctx.gmail`, `ctx.search`, `ctx.files`,
  `ctx.orgs`, roles, migrations, UI and security rules.
- Then follow **`<ledger>/.claude/skills/ledger-module/SKILL.md`** (design
  rules, implementation rules, checks, publishing). Treat this repository as
  the module directory it talks about. Where the docs and Ledger's code
  disagree, the code wins (`backend/src/module-host.ts`, `modules.ts`,
  `module-settings.ts`).

Set `"ledger": ">=x.y.z"` in the manifest to the oldest Ledger with every
feature the module uses (the context file says which version added what;
`git -C <ledger> describe --tags --abbrev=0` is the latest release).

## 2. Rules that bite

- No npm packages at runtime: Ledger installs the release as-is. Only
  `node:*` built-ins, global `fetch`, and this repo's own files. (A
  `package.json` here is only for running tests.)
- Never edit a released migration; add the next `NNN_name.sql`.
- Money is integer cents per currency; post to the books only with
  `ctx.ledger.createJournalEntry(entry, req.user)`.
- AI goes through `ctx.llm` (Ledger ≥ 0.10.0): no API keys of the module's
  own. The admin allows the module under Settings → LLM API.
- Files another module produces come through `ctx.files` (Ledger ≥ 0.11.0),
  never by reading the other module's tables. This module declares
  `"files": {"accepts": [...]}` and marks each file `done` or `rejected`
  with a `result` (`lib/received-files.mjs`).
- Organizations (Ledger ≥ 0.11.0): each organization's books, and this
  module's schema, are a separate database; requests already run in the
  user's current one, so no organization columns. Background work (timers,
  startup, `onReceive` outside a request) runs in the main books unless it
  loops over `ctx.orgs.forEach`. Settings are per organization; `ctx.llm` is
  server-wide.
- Configuration goes in the manifest's `settings.fields`; data shown in the
  UI goes in with `textContent`, never `innerHTML`; support dark mode and
  narrow panes (~260 px).
- AI only proposes; a person approves. Anything `ctx.llm` decides is stored
  as pending and acted on only after a user approves it in the UI (POST with
  `req.user`): posting, changing or deleting records, marking files done.
  Here: suggestions need Post, bills need Approve, files the AI read stay
  `accepted` until `settle()` (lib/received-files.mjs), AI account guesses
  are `statements.account_guess` (preselected only). No auto-approve setting.
- Bad input answers 4xx (`throw new ctx.HttpError(422, "…")`), never 500.
- LLM connections (Ledger 0.11.2): requests with `documents` or `images` go
  to the connection for images. `ai()` in server.mjs gives `readsPdf`
  (images connection is Claude) and `readsImages`; photos go to
  `extractBill({ images })`, sniffed by `imageType()` in lib/bills.mjs.
- Journal entry links (Ledger 0.11.2): every entry the module posts carries
  `links` (`tx:<id>` → `?statement=`, `bill:<id>` → `?bill=`); entries
  linked later use `linkEntry()` (transfers, duplicates).
- Backups (Ledger 0.13.0) save every table of the schema as a CSV for people:
  keep table and column names plain, no secrets in tables, and keep big
  files out of record tables (`bill_documents`, `statement_files` hold the
  bytes; `bills`/`statements` stay readable). From Ledger 0.13.1 a `bytea`
  column shows only its size in the CSV, so file tables keep `file_name`,
  `content_type`, `size_bytes` and `created_at` beside `content`.
- Files (Ledger 0.13.2): bill documents and statement files live in
  `ctx.storage` (`bills/<id>/<name>`, `statements/<id>/<name>`) through
  `lib/files.mjs` (`storageName()` makes names Ledger accepts);
  `bill_documents` / `statement_files` keep name, type, size, date and
  `storage_path`. Their `content` column only holds pre-0.8.0 files until
  `moveOldFiles()` (startup, every organization) moves them; never write it.
- Import from CSV (`ctx.imports.provide`, one per module, in
  bill-routes.mjs): bills and receipts. The dry run lists bad rows; repeats
  (exact row, or `findDuplicate`) are skipped so re-imports add nothing;
  imported bills are `new` (Needs review), source `import`.
- Ledger runs in a Debian 13 container with PostgreSQL 18 and Node.js 24
  (Ledger 0.18.0; Debian 12 is deprecated): write for that only, and don't
  spawn outside programs.
- Versions: new features (a page, route, setting, data kept) raise the middle
  number (`0.2.6` → `0.3.0`); fixes only raise the last.

## When invoked with no instruction

Bring the module up to date with the current Ledger and push it: read
Ledger's module docs and skill, compare (new `ctx` features, things Ledger
now does differently, checker reports), make the changes, raise `"ledger"`
and bump `version`, run the checks, then commit and push to `main` (the
release workflow publishes it). If nothing needs changing, say so and push
nothing. Changes that move the user's data still need their approval in the
module.

## 3. Check before saying it works

```sh
npm test                      # this repo's own tests, if package.json has them
(pg_isready || service postgresql start) >/dev/null
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
  sh .claude/skills/ledger-module/scripts/check.sh
```

`check.sh` runs Ledger's checker on this repo: manifest, files, imports,
migrations, then the module loaded into a real Ledger on a scratch database
(every GET route, POST `{}` must give 4xx, UI, settings). Add `--serve 8098`
to keep it running and test the real flows with `curl` and Playwright (it
prints the session cookie). If PostgreSQL has no password yet:
`runuser -u postgres -- psql -qc "ALTER USER postgres PASSWORD 'postgres'"`.

## 4. Release (only when the user asks)

**Never push to the Ledger repository (`mastifdogo/Bookeeping`) while
working on this module.** Push only to this repository. If the module needs
a change in Ledger (a bug fix, a new `ctx` feature, a docs or checker fix),
make it in a local Ledger checkout, tell the user what it is and why, and
leave pushing it to them. The module must work without that change.

Releases are made by `.github/workflows/release.yml` (Ledger's template
workflow): on each push to `main` that changes `ledger-module.json`, it tags
`v<version>` and creates the GitHub Release if that version has none.

1. Bump `version` in `ledger-module.json` (features raise the middle number,
   fixes the last) and note the change in the README.
2. Commit and push `main` (merge the PR). **Don't create tags or Releases by
   hand**; check the Release run in the Actions tab. If it fails with
   "Resource not accessible by integration", the user allows it once under
   Settings → Actions → General → Workflow permissions → "Read and write
   permissions"; Actions → Release → Run workflow re-runs it.
3. Ledger installs it on its update schedule or with "Update modules now"
   (Settings → Modules).

## This module: Auto sort (`id: categorizer`, schema `mod_categorizer`)

Statement upload (CSV, OFX, QFX) with Ledger's LLM API recommending an account
per transaction, transfers between your own accounts, bills and receipts
(uploaded PDFs, photos and `.eml` files, or files from other modules) tracked
until paid and matched to statement payments, and matches with what's already
in the journal. There is no email checker any more (removed in 0.6.0; never
add Gmail or IMAP reading back without the user asking).

- The id is `categorizer` (permanent: it names the schema). The name shown
  is "Auto sort" (it was "LLM API"); messages use `ctx.name`, never a fixed
  name. Needs Ledger ≥ 0.16.0.
- Layout: `server.mjs` (statements, categorizing, `/status`, search, posting
  with entry links), `lib/bill-routes.mjs` (bill routes, reading uploads and
  module files, `matchBillTx`, `linkBillEntry`), `lib/mime.mjs` (uploaded
  `.eml`), `lib/parse.mjs` (statement formats), `lib/categorize.mjs` and
  `lib/bills.mjs` (prompts and schemas for `ctx.llm.json()`, matching),
  `lib/transfers.mjs` + `lib/transfer-sync.mjs`, `lib/duplicates.mjs` +
  `lib/duplicate-routes.mjs`, `lib/matching.mjs` + `lib/journal-matches.mjs`,
  `lib/received-files.mjs`, `lib/email-statements.mjs` (statements from
  modules: account hints, PDF statements), `lib/dashboard.mjs`. Tests:
  `test/*.test.mjs` (`npm test`).
- AI: every call is `ctx.llm.json()`; a 403/409 from it ("not allowed" /
  "not set up") stops a batch run early, and its message (which says where
  to fix it) is shown on the rows.
- Statements from other modules: `stageStatement()` stages them (and
  uploads). A statement whose account isn't known is `needs_account`
  (account_code `''`) until `POST /statements/:id/account`, which also
  remembers the sender in `statement_sources`.
- Options are the manifest's `settings.fields` (review threshold, batch
  size, payables account), per organization: read with `ctx.settings.get()`
  where used.
- Tabs (no Import tab since 0.7.0): **Statements** (upload, Sort now, Create
  bill), **Bills** and **Receipts** (`/bills?kind=`; upload, split, billable
  + customer), **Duplicates** (duplicates, journal matches, Recheck by
  period), **Status** (files from modules).
- Account dropdowns end with "+ New account…" through `withNewAccount()` in
  the UI, which opens Ledger's dialog (`ledger-new-account` message, Ledger ≥
  0.11.3); never build an account form of our own.
- Split bills: `bill_lines` (add up to the bill's amount). Posting a payment
  row matched to a split bill (not posted to payables) books its lines
  (`splitLinesFor()` in server.mjs); approval into payables books them too.
  LLM proposals (`/bills/:id/split-draft`, `/statements/:id/bill-draft`) are
  never saved by themselves: the user edits and saves.
- Customers and vendors (Ledger 0.16.0): `ctx.entities`, Ledger's one list.
  `linkEntities(billId, { create })` in bill-routes.mjs sets
  `bills.vendor_entity_id` / `customer_entity_id`: `create: true` only on a
  person's action (save, approve, import, add by hand); AI-read vendors only
  `find()` an existing one. Entries for a bill pass `entity_id` (vendor).
  `customer_ref` ("sales:<id>") is legacy; don't read other modules' APIs.
- Account pickers: `accountOptions()` shows the tree (`parent_code`,
  Ledger 0.15.0); `bankAccountOptions()` puts `kind`-tagged accounts
  (chequing, savings, credit_card; Ledger 0.16.0) first.
- Restores (Ledger 0.14.0) can leave rows whose stored file is gone: check
  `ctx.storage.stat()` before linking to a file; reads return null.
- Overdue: `syncBillTodos()` titles overdue to-dos "Overdue: …" with level
  `danger`, refreshed hourly in every organization.
- Journal matches (no AI): staged rows in the journal come from
  `duplicate-routes.mjs` (`scan()`, `merge()`); bills in the journal from
  `findBillEntryMatches()` (`GET /journal-matches`). Linking is a person's
  click, never automatic.
- Auto sort (LLM): `matching.mjs` narrows candidates (same amount, close
  dates; entries, other rows, bills), `journal-matches.mjs` asks the LLM and
  stores picks in `match_suggestions` (pending). `POST
  /match-suggestions/:id/approve` carries one out (merge into an entry or a
  row, link a transfer, match a bill, link a bill to an entry); rejected
  picks are never suggested again.
- Organizations: startup resumes interrupted categorising in every
  organization (`ctx.orgs.forEach`). The categorising queue is one promise
  chain; each step keeps the organization it was queued in
  (AsyncLocalStorage follows `.then`).
- Files from other modules: `lib/received-files.mjs` (onReceive queue, a
  sweep of `new`/`accepted` inbox files at startup and every 5 minutes in
  every organization, `received_files` links each file to what it became).
  Statements reuse `stageEmailStatement` with `from: "module:<sender>"`, so
  a chosen account is remembered per sending module and account number.
- New accounts: the categorize schema allows `account_code: "NEW"` with
  `new_account {name, type}`; `proposeCode()` picks the code; rows keep the
  proposal in `transactions.new_account` until `POST /accounts` creates it.
- Duplicates: `lib/duplicates.mjs` (pure scoring and pairing, unit-tested)
  and `lib/duplicate-routes.mjs`. A merged row has status `merged` and is
  never posted; `not_duplicates` remembers dismissed pairs.
- The sidebar icon is drawn (`nav.icon.path`, a robot head).
- Testing the real flows: Ledger reads its AI settings from
  `INTEGRATIONS_DIR` (`llm.json`). Point it at a local stub that answers
  like the Messages API, allow `categorizer`, and drive statements, bills,
  transfers and Auto sort through the HTTP API.
