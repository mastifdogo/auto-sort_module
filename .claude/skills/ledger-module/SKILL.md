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
- AI goes through `ctx.llm` and Gmail through `ctx.gmail` (Ledger ≥ 0.10.0):
  no API keys, OAuth, IMAP or Apps Script bridges of the module's own for
  those. The admin allows the module under Settings → AI / Gmail.
- Files another module produces come through `ctx.files` (Ledger ≥ 0.11.0),
  never by reading the other module's tables. This module declares
  `"files": {"accepts": [...]}` and marks each file `done` or `rejected`
  with a `result` (`lib/received-files.mjs`).
- Organizations (Ledger ≥ 0.11.0): each organization's books, and this
  module's schema, are a separate database; requests already run in the
  user's current one, so no organization columns. Background work (timers,
  startup, `onReceive` outside a request) runs in the main books unless it
  loops over `ctx.orgs.forEach`. Settings, `ctx.llm` and `ctx.gmail` are
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
- Versions: new features (a page, route, setting, data kept) raise the middle
  number (`0.2.6` → `0.3.0`); fixes only raise the last.

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

1. Bump `version` in `ledger-module.json` (and note the change in the README).
2. Commit, tag `v<version>`, push the tag, and create a GitHub Release from
   it (not a draft or pre-release). If tags or releases can't be created from
   this session, tell the user which commit to release in GitHub's web UI.
3. Ledger installs it on its update schedule or with "Update modules now"
   (Settings → Modules).

## This module: Auto sort (`id: categorizer`, schema `mod_categorizer`)

Statement upload (CSV, OFX, QFX) with Ledger's AI recommending an account per
transaction, transfers between your own accounts, and bills found in email
(Ledger's Gmail through `ctx.gmail`, or IMAP for other providers), tracked
until paid and matched to statement payments.

- The id is `categorizer` (permanent: it names the schema). The name shown
  is "Auto sort" (it was "LLM API"); messages use `ctx.name`, never a fixed
  name. Needs Ledger ≥ 0.10.0.
- Layout: `server.mjs` (statements, categorizing, `/status`, search, the
  one-time copy of pre-0.1.0 settings to `ctx.settings`),
  `lib/bill-routes.mjs` (bills and mail routes; mail from `ctx.gmail` or
  `lib/imap.mjs`), `lib/mime.mjs` (parses `ctx.gmail.raw()` and IMAP
  messages), `lib/parse.mjs` (statement formats), `lib/categorize.mjs` and
  `lib/bills.mjs` (prompts and schemas for `ctx.llm.json()`, matching),
  `lib/transfers.mjs` + `lib/transfer-sync.mjs`, `lib/dashboard.mjs`. Tests:
  `test/*.test.mjs` (`npm test`).
- AI: every call is `ctx.llm.json()`; a 403/409 from it ("not allowed" /
  "not set up") stops a batch run early, and its message (which says where
  to fix it) is shown on the rows.
- Statements in email (`email_statements` = `review`): `lib/email-statements.mjs`
  finds statement attachments and reads PDF statements; `stageStatement()` in
  `server.mjs` stages them (and uploads). A statement whose account isn't
  known is `needs_account` (account_code `''`) until
  `POST /statements/:id/account`, which also remembers the sender in
  `statement_sources`. Never post email statements automatically.
- Options are the manifest's `settings.fields`, read per request with
  `ctx.settings.get()`. `mod_categorizer.settings` only keeps `mail_state`
  (the last mail check).
- Tabs: **Import** (checks, uploads, `GET /mail/log` joined to what each
  email became) feeds **Statements**, **Bills** and **Receipts** (`/bills?kind=`).
  Mail you sent is skipped by `sentByMe()` in `lib/bills.mjs` (Gmail labels,
  or your address as sender of mail not addressed to you); keep self-forwards in.
- Organizations: startup resumes interrupted categorising in every
  organization (`ctx.orgs.forEach`); the mail scheduler visits each one, and
  each reads its own settings (per organization since Ledger 0.11.1; never
  cache them). `mail_source` "auto" (the default) means Gmail in the main
  books and off elsewhere, so new organizations don't import the same mail.
  The categorising queue is one promise chain; each step keeps the
  organization it was queued in (AsyncLocalStorage follows `.then`).
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
- Testing the real flows: Ledger reads its AI and Gmail settings from
  `INTEGRATIONS_DIR` (`llm.json`, `gmail.json`) and Gmail's endpoints from
  `GMAIL_API_BASE` / `GOOGLE_OAUTH_BASE`. Point them at local stubs (a fake
  Messages API and a fake Gmail API), allow `categorizer` in both files, and
  drive statements, bills, transfers and Gmail through the HTTP API.
