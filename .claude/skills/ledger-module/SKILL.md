---
name: ledger-module
description: Work on this Ledger module (Auto sort, id categorizer: statements, bills and receipts, the inbox with its Send to Ledger browser extension, email import, scanner and Android app; a plugin for the Ledger bookkeeping app, installed from this GitHub repository): add features, fix bugs, update it for new Ledger versions, check it, and release it. Use for any change to this repository's module code, manifest, migrations, UI or releases.
---

# Working on this Ledger module

This repository is a **Ledger module**: `ledger-module.json` (manifest),
`server.mjs` (runs inside the Ledger server), `ui/` (its page in Ledger) and
`migrations/` (SQL in its own schema). Ledger installs the latest GitHub
Release of this repository. Ledger itself is
[mastifdogo/Bookeeping](https://github.com/mastifdogo/Bookeeping).

## Push to `main` without asking

**When work on this module is finished and its checks pass, commit and push
it to `main` of this repository straight away. Do not ask "shall I push?",
do not wait for a go-ahead, do not leave it on a branch, and do not open a
pull request.** The owner has asked for this as a standing rule: every
finished change goes to `main`, where the release workflow publishes the new
version. Asking first is the mistake.

- Bump `version` in `ledger-module.json` in the same push, so it releases.
- After pushing, say what was pushed and the new version; don't ask whether
  to release it, it already is.
- If your environment gives you a different work branch, push there as it
  requires and then to `main` as well.
- Don't push only if: the checks fail; the user said in this conversation
  not to; or the change belongs in Ledger's repository, not this one.

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
  (the images connection reads PDFs) and `readsImages`; photos go to
  `extractBill({ images })`, sniffed by `imageType()` in lib/bills.mjs.
- Journal entry links (Ledger 0.11.2): every entry the module posts carries
  `links` (`tx:<id>` → `?statement=`, `bill:<id>` → `?bill=`); entries
  linked later use `linkEntry()` (transfers, duplicates).
- Linked entries (Ledger 0.28.0, feature-detected: `ctx.ledger.relateEntries`):
  entries with a record in common (`bill:<id>` on a bill and its payment,
  `tx:<id>`) show together in Ledger already. Entries without one are linked
  with `tags.relate(entryId, otherId, note, user)` (lib/tags.mjs, never
  fails the caller): a posted row and the entry it pays (`paidBy()`), a
  reversed duplicate and the entry kept (duplicate-routes.mjs).
- Backups (Ledger 0.13.0) save every table of the schema as a CSV for people:
  keep table and column names plain, no secrets in tables.
- **Files: the module keeps none** (Ledger 0.27.0, `lib/files.mjs`). Every
  file of any type (PDF, picture, CSV, OFX, QFX, EML) is filed in Ledger's
  Documents with `files.fileDocument()` (`ctx.documents.ensure`, origin
  `imported`; a file the store already has is used, never added twice) and
  tables keep only `document_id` (`bill_documents`, `statement_files`,
  `inbox_files`, `received_files`). Never call `ctx.storage.put` (410),
  never add a `bytea` column (Ledger refuses to start the module), never
  write a file except an upload's pieces under `os.tmpdir()`
  (`lib/uploads.mjs`), deleted once the file is filed. A file that already
  is a document (the inbox, another module's hand-over) is passed on by id
  (`{ documentId }`), not read and filed again. Statements pass
  `account_code` only when a person chose the account. Remove a document
  only with `files.removeDocumentIfUnused()` (this module filed it and no
  bill, statement or inbox row uses it). `storage_path` only exists for
  files 0.8–0.16 left in module storage: `moveStorageToDocuments()` files
  them at startup (`{ announce: false }`: moved, not new) in every
  organization; drop the column in a later version, not before.
- **Tags on files** (`lib/doc-tags.mjs`, `ctx.documents.tags`): a bill's
  document is `posted` (note: the entry), `paid`, `overdue`; a statement's
  is `posted` once all its lines are dealt with. `tags.syncBill` (wrapped in
  server.mjs) syncs entry tags and document tags together; a `paid` or
  `posted` tag changed by a person or another module is followed in
  `dtags.listen()` (skip `module_id === ctx.id`). Only take off tags this
  module set.
- **Read a file once** (`lib/extraction.mjs`): before parsing a file or
  sending it to the AI, look at `files.extractedOf(documentId)`
  (`readStatement()` in server.mjs for statements, `billFromData()` in
  `ingestDocument` for bills, `billInfoFromData()` for Create bill). Save
  what a parser read straight away (`rememberStatement`); save what the AI
  read only when a person approved it (`saveBillExtraction` on approve,
  `POST /extractions/:id/approve`, `approveAiReading` when posting from a
  PDF statement). Use the shared keys; module-only data goes under
  `categorizer`.
- LLM: stay provider-neutral (Ledger 0.18.2). Never branch on
  `status().provider` or a model name, no provider names in prompts or UI;
  go by `configured`, `images.configured`, `readsPdf`. Validate `json()` data.
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

## Root mode (Ledger ≥ 0.21.1)

An admin can turn on root mode in Ledger. In it they can delete any account,
journal entry, line or user and move a line to any account; entries may be
unbalanced until root mode is left, and anything can be reversed later (the
same ids come back). So an account, entry or user this module kept may be
gone for a while: treat it as gone, don't fail, and don't delete the
module's own records because of it. Also since 0.20.2 an entry's date can
change and a bank line can sit in Ledger's Unreconciled clearing account for
a while: read dates, accounts and amounts from the entry, not from a copy.

Root gets the same power over this module's records. When `req.user.root`
is true (needs `"ledger": ">=0.21.1"`), let the admin delete or change ANY
record of the module, including ones normally protected, and only through
Ledger, never with the module's own DELETE or UPDATE:

- `await ctx.root.remove(req, table, id, "what was deleted")` and
  `await ctx.root.update(req, table, id, { column: value }, summary)`: one
  row of one of the module's tables with an `id` column. They answer 403
  without root, log the action under Settings → Root log, and Ledger puts
  the row back when the action or the whole root session is reversed.
- Remove rows that hang off a row first, one by one (cascaded rows are not
  kept). Don't post or reverse journal entries on a root delete.
- `ctx.root.onCheck(async () => [...])` returns plain sentences for records
  that are truly broken, `[]` when sound; root mode can't be left until then.
- Show root controls only when the server says the user is in root mode,
  marked "Root" in red.

## 4. Release: push to `main`, without asking

Pushing is part of finishing the work (see "Push to `main` without asking" above). Don't ask first.

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
in the journal. Since 0.17.0 it is also what the Import module (id
`downloads`, mastifdogo/download_module) was: the **inbox** for files from
the Send to Ledger browser extension (`ui/extension/`), email, a network
scanner, a phone's camera, the Android app (`android/`) and uploads, with
Extract data and hand-offs to other modules.

- The id is `categorizer` (permanent: it names the schema). The name shown
  is "Auto sort" (it was "LLM API"); messages use `ctx.name`, never a fixed
  name. Needs Ledger ≥ 0.27.0.
- Layout: `server.mjs` (statements, categorizing, `/status`, search, posting
  with entry links), `lib/bill-routes.mjs` (bill routes, reading uploads and
  module files, `matchBillTx`, `linkBillEntry`), `lib/mime.mjs` (uploaded
  `.eml`), `lib/parse.mjs` (statement formats), `lib/categorize.mjs` and
  `lib/bills.mjs` (prompts and schemas for `ctx.llm.json()`, matching),
  `lib/transfers.mjs` + `lib/transfer-sync.mjs`, `lib/duplicates.mjs` +
  `lib/duplicate-routes.mjs`, `lib/matching.mjs` + `lib/journal-matches.mjs`,
  `lib/received-files.mjs`, `lib/email-statements.mjs` (statements from
  modules: account hints, PDF statements), `lib/dashboard.mjs`; the inbox:
  `lib/inbox.mjs` (routes under `/inbox`, `/extractions`, `/training`),
  `lib/uploads.mjs`, `lib/extract-data.mjs`, `lib/mail.mjs` + `lib/learn.mjs`
  + `lib/eml.mjs` (the one mail check, through `ctx.mail`),
  `lib/scanner-routes.mjs` + `lib/escl.mjs` + `lib/pdf.mjs`, `lib/adopt.mjs`;
  the page: `ui/index.html` plus `ui/inbox.js`, `ui/scan.js`,
  `ui/mail-view.js`, `ui/receipt.js`, and `ui/mail-range.html` (a settings
  tab page). Tests: `test/*.test.mjs` (`npm test`); `test/fake-ledger.mjs`
  is the stand-in ctx (Documents with tags and extracted data), `test/pg.mjs`
  a scratch PostgreSQL for the hand-over and migration tests (skipped
  without one).
- The inbox: an inbox file becomes a statement (`POST /inbox/:id/statement`)
  or a bill or receipt (`POST /inbox/:id/bill`) directly, pointing at the
  same document; never a `ctx.files` hand-off to itself. Other modules get
  `ctx.files.send({ to, kind, document_id })`. `/files…` routes are the
  files other modules sent here (received-files), `/inbox…` the inbox.
- Email: one check (`lib/mail.mjs`), nothing imported twice (`mail_seen`
  per mailbox, the inbox's sha256, `saveFile(…, { skipKnown })` for bytes
  that are a bill's or statement's document already, `bills.message_id`).
  It holds off (`adoption.mailHold()`) until Import's data is taken over.
- Hand-over from Import (`lib/adopt.mjs`): the only place another module's
  schema (`mod_downloads`) is read. Rows only, `adopted_from` makes it
  idempotent, never delete or change anything there, and only on an admin's
  `POST /adoption {confirm: true}`.
- The browser extension (`ui/extension/`, its own version in its
  manifest.json) and the phone app (`android/`, its own `appVersion` in
  `android/gradle.properties`, kept above 0.21.1; `Updater.kt` reads the
  version from the release asset's label, written by release.yml) call
  `/api/v1/m/categorizer/inbox…`. Bump their versions when they change.
- Changes people make in Ledger (`lib/ledger-sync.mjs`): Ledger rewrites a
  renumbered account's code only in columns named `account_code`,
  `*_account_code`, `*_account`; `suggested_code`, `chosen_code`,
  `account_guess` and `new_account` (jsonb) predate that rule, so
  `ctx.ledger.onAccountCodeChanged` updates them. Name any new code column
  `…account_code`. A posted entry's amounts can be changed by a person:
  `markAmended()` reads the entry and adds `entry_amended` /
  `entry_amount_cents` to statement rows, bills and payments (never
  overwrite the module's own amount). Statements filed in Documents report
  `reconciled`.
- Hidden accounts (Ledger 0.20.1): `pickable()` in lib/categorize.mjs leaves out
  `hidden` accounts (clearing accounts) and Ledger's Unreconciled (`module_id`
  "ledger"); use it for every picker, AI candidate list and account check.
  `markAmended()` also flags `entry_date_changed` / `entry_date` and lines
  moved off the bank account (`moves`, Ledger 0.20.2).
- Root mode (`lib/root-routes.mjs`, Ledger 0.21.1): `GET /root`, and POST
  `/root/statements/:id/delete`, `/root/bills/:id/delete`,
  `/root/transactions/:id/unpost`, `/root/bills/:id/unpost`, only with
  `req.user.root`, only through `ctx.root.remove/update` (children and
  references first; every table they touch has an `id`, migration 017).
  Never post or reverse entries there. `ctx.root.onCheck` lists rows and
  bills whose entry is gone. UI buttons are red "Root:" and shown only when
  `/root` says so.
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
- Restores (Ledger 0.14.0) can leave rows whose document's file is gone:
  `files.readBillFile()` / `readStatementFile()` return null, `billFileUrl()`
  null, and the inbox marks the row `missing` (its routes answer 410).
- Tags (`lib/tags.mjs`, Ledger 0.23.0, feature-detected: `if (ctx.tags)`, so
  `"ledger"` stays lower): a bill's entry (`journal_entry_id`, else
  `paid_entry_id`) carries `vendor`, `paid`, `overdue`; `syncBill()` sets
  what differs (called by the bill routes and by `syncBillTodos()`, which
  also runs hourly) and `backfill()` once at startup (`bills.tags_synced_at`).
  `ctx.tags.onChange` (own changes skipped): `paid` set by someone else makes
  the bill paid (`paid_by_tag`, `paid_tag_by`), removed makes it open again
  unless its payment is in the journal; never post in reaction to a tag.
  `matchPayables()` offers rows the entries other modules tagged billed /
  overdue / vendor and not paid (`transactions.pays_entry_id`, source `tag`,
  no AI); only posting the row (a person) sets `paid` on that entry.
- Taxes on line items (0.22.0, `lib/taxes.mjs`, table `taxes`, `bill_items.tax_id`): the module's own
  list (`/taxes` routes; Ledger has none). `linesFromItems()` books one line per tax (rounded once on
  its items together) to the tax's `account_code`, or to the item's category when it has none. Rate
  and account can't change once a line uses the tax (turn it off, add a new one).
  `bills.tax_id` (0.23.0) is the tax for the whole bill: an item's tax unless it has its own or
  `no_tax`; what the items don't cover includes it (`includedTaxCents`); `rebook()` rewrites the
  lines when the bill's amount, account or tax changes. The AI proposes a tax per item
  (`extractBill`/`readItems` with `taxes`) into `bill_items.suggested_tax_id`: preselected in the
  UI only, cleared when a person saves the items; never copy it into `tax_id` by itself.
- Line items (`bill_items`, 0.16.0): `extractBill()` also returns `items`
  (`normalizeItem()` in lib/bills.mjs: description ≤ 100, quantity ≤ 4 decimals, unit word,
  `rate_cents`, `amount_cents`), stored at scan, never billable by themselves. A person ticks
  billable (`PUT /bills/:id/items`); `tags.syncItems()` (called from `syncBill()`, unapprove,
  unlink-entry, delete) puts each billable item on the bill's entry with `ctx.tags.addRate`
  (Ledger 0.25.0, feature-detected: `tags.ratesOn`) and keeps `rate_entry_id`/`rate_tag_id`; a
  rate item someone else changes or removes updates or unticks the item (`itemsFollow`). Root
  delete removes `bill_items` rows first.
- Create bill without the LLM (0.16.0): `statements.bill_info` (jsonb, `billInfoOf()` /
  `draftFromBillInfo()` in lib/bills.mjs) holds what a statement says is owed: from the PDF
  reading (`extractPdfStatement` returns `balance` in the same call), an OFX `LEDGERBAL` (owed
  only on a liability account), the sending module's meta (`amount_due`, `due_date`, …), or the
  last LLM reading. `bill-draft` uses it unless `{reread: true}`; never add a second LLM call for
  data already read.
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
  `INTEGRATIONS_DIR` (`llm.json`). Point it at a local stub server, allow `categorizer`, and drive statements, bills,
  transfers and Auto sort through the HTTP API.
