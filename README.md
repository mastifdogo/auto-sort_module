# Auto sort: a Ledger module

A module for [Ledger (Bookeeping)](https://github.com/mastifdogo/Bookeeping). You upload a bank or
credit-card statement and an LLM suggests an account from your chart of accounts for each
transaction. You check the suggestions, then post them as journal entries. It uses Ledger's own
AI provider and Gmail account: there's no API key or mail login to set up in the module.

- **Formats:** CSV exports (columns are found from the header, or guessed from the data when there's
  no header; single amount or debit/credit columns) and **OFX / QFX / QBO**.
- **AI:** whatever the admin chose under **Settings → LLM API** in Ledger: Claude, or a local model
  through Ollama or an OpenAI-compatible server so statements stay on your network.
- **Uses your books:** the prompt includes your chart of accounts and how you booked similar
  transactions from the same bank account before. The model can only answer with one of your real
  account codes (the response is constrained to a JSON schema).
- **Learns:** each posted transaction teaches a payee rule (`SHELL #1234 TORONTO` → `SHELL TORONTO`
  → Fuel). Payees with a rule are categorised without calling the model.
- **Safe to re-upload:** transactions already uploaded for that account are skipped, so overlapping
  statements don't post anything twice. Nothing is posted until you press **Post**.
- Low-confidence suggestions are marked **Needs review**; **Select confident** + **Post selected**
  takes care of the rest.
- **Transfers** between your own accounts are linked and posted once. See [Transfers](#transfers-between-your-accounts).
- **Duplicates:** the same transaction uploaded twice (a CSV and an OFX export of one month, a
  pending and a posted copy), or already entered in the journal, is listed on the **Duplicates** tab
  to merge. See [Duplicates](#duplicates).
- **New accounts:** when none of your accounts fits, the AI suggests one (code, name, type) that you
  can edit before it's created. See [New accounts](#new-accounts).
- **From other modules:** other Ledger modules can hand Auto sort statements, transaction lists,
  bills and receipts (Ledger's file exchange). See [Files from other modules](#files-from-other-modules).
- **Organizations:** each organization's statements, bills and rules stay in its own books.
- **Bills from email:** checks Ledger's Gmail account (or an IMAP mailbox) on a schedule, reads bills and receipts
  out of the emails and their PDFs, keeps a list of bills to be paid, and matches each bill to the
  bank transaction that pays it. See [Bills](#bills).

## Install

Needs **Ledger 0.11.2 or newer** (shared LLM API and Gmail for modules, LLM connections for
images, journal entry links, file exchange between modules, organizations, settings forms, roles,
search, drawn icons).

1. In Ledger, open **Settings → Modules**, enter `mastifdogo/llm-api-module` and press **Add**.
   **Auto sort** appears in the sidebar with a robot icon. You can hide or reorder it under
   Settings → Sidebar. Updates install on Ledger's update schedule, or with **Update modules now**.
2. An admin allows the module to use the shared services:
   - **Settings → LLM API:** choose a provider (Claude needs an API key; Ollama a model you've pulled) and
     tick **Auto sort** under the modules allowed to use it. Claude also reads bill PDFs; local
     models only see the email text. Larger local models (14B and up) categorise noticeably
     better than small ones.
   - **Settings → Gmail** (for bills): connect the account and allow **Auto sort** to read mail. It
     never sends, changes or deletes mail.
3. Options are under **Settings → Auto sort**: review threshold, transactions per AI request, where
   bills come from (Gmail, IMAP or off), how often to check, the Gmail search, keywords, how far
   back the first check looks, IMAP details, and the accounts payable account.
4. The module's **Status** tab shows whether AI and email are ready, and what's missing if not.

The module was called "LLM API" before 0.1.2 (and this repository llm-api-module). Its id stays
`categorizer` (its page is `/apps/categorizer` and its data lives in the `mod_categorizer`
schema), so renaming it and updating keep all existing data.

**Updating from 0.0.x:** the module used to have its own AI key, model and mail settings. On the
first start of 0.1.0 it copies the options that still exist (review threshold, batch size, payables
account, mail interval, keywords, IMAP details) to Settings → Auto sort, and deletes its old settings,
including any stored AI key and Gmail bridge token. Then the admin allows the module under Settings
→ AI (and Settings → Gmail). The Apps Script you may have deployed for 0.0.2 is no longer used:
delete it at script.google.com.

### Accounts it expects

The module creates no accounts. It works with your chart of accounts:

- **Statement accounts:** the bank account (asset) or credit card (liability) each statement
  belongs to, e.g. `1000 Chequing` or `2100 Visa`.
- **Categories:** your expense, revenue and other accounts. The model only suggests active
  accounts in the statement account's currency (CAD or USD).
- **Accounts payable** (optional, liability, e.g. `2000 Accounts payable`): choose it under
  Settings → Auto sort to post approved bills there. It's in one currency: bills in the other
  currency are tracked but can't be approved into it.

### On Ledger's dashboard

- A **notification** per statement that has transactions waiting to be posted
  ("march.csv: 12 transactions to post"; a warning when some need review). It goes away once
  everything is posted, skipped or discarded.
- A **to-do** per unpaid bill, with its due date ("Review bill: Rogers 85.50 CAD", then "Pay
  Rogers 85.50 CAD" after approval). It's ticked when the payment is posted, and removed when the
  bill is ignored or deleted.
- A red **notification** when the scheduled email check fails, cleared by the next good check.

## Use

The page has these tabs:

- **Import:** where things come in. **Check email now** and **Sort now**, uploading a statement or
  a bill/receipt, and a log of every email the check looked at: what it became (bill, receipt,
  statement) with a link to it, or why it was skipped.
- **Statements**, **Bills** and **Receipts:** where you categorise and approve what Import sorted.
- **Learned rules** and **Status**.

Mail you sent is never imported. That covers replies and forwards in Gmail's Sent folder, drafts,
and IMAP mail from your own address that isn't addressed to you. A bill you forward to yourself is
still imported.

1. **Upload** (Import tab): choose the file and the bank or card account it belongs to. For credit-card
   exports that show purchases as positive numbers, tick *flip signs*.
2. Suggestions appear within a few seconds to a minute (40 transactions per request by default).
3. **Review:** change any account in the drop-down (your choice is kept, even if you re-run the
   suggestions), skip rows you don't want to book, then **Post selected**.

Each posted transaction becomes a two-line entry: the statement account on one side, the chosen
account on the other, dated with the transaction date, with the bank's description and its OFX
transaction ID (or `categorizer <statement>/<row>`) as the reference.

Money in → debit the statement account. Money out → credit it. So a purchase on a card
(liability) account credits the card, and a deposit to chequing debits chequing.

## Transfers between your accounts

When money moves between two of your own accounts (chequing to savings, or a bank payment to a
credit card) and you upload both statements, the transfer shows up twice, once on each. The
module links the two rows so the transfer is posted **once**:

- **Both statements uploaded:** a payment out of one account and a deposit of the same amount into
  another account (same currency, at most 4 days apart) are linked as a **Transfer** when one side
  is booked to the other account, a description says transfer or payment (`TRANSFER`, `TFR`,
  `PAYMENT`, `VIREMENT`, ...), or a description names the other account ("VISA" for the Visa
  account). Posting either row creates one entry, and the other row is marked posted with that
  same entry.
- **One side already in the journal** (posted from the other statement earlier, or entered by
  hand): a row whose account has an unclaimed journal entry with the same amount within 4 days,
  against another bank or card account, shows **Already recorded**. Posting it creates nothing
  new.
- **Wrong match:** **Not a transfer** unlinks the rows, asks the model again, and never links that
  pair again. Booking one side to a different account also drops the link.

If you also get the credit card's statement email as a bill, ignore it rather than approving it
into payables. The card's own statement already records those charges.

## Photos of bills and receipts

Upload a photo or scan (JPEG, PNG, WebP, GIF) on the Import tab like a PDF; large phone photos are
shrunk in the browser first. Pictures go to Ledger's LLM connection for images (Settings → LLM API;
Claude, or a local vision model such as one served by Ollama), which can be a different model than
the one for text. Photos attached to bill emails (with no PDF) and pictures other modules send are
read the same way. The picture is kept with the bill or receipt. Without a connection for images,
enter the details by hand. The Status tab shows which connection reads PDFs and pictures.

## Links in the journal

Every entry Auto sort posts links back to where it came from, shown on the entry in Ledger: the
statement line (*march.csv · SHELL #12*, opening the statement), the bill or receipt for an approved
bill and its payment, both statement lines for a transfer, and the bank line merged into an entry you
entered by hand (removed again on unmerge).

## The AI only suggests

Following Ledger's rule for modules, nothing the AI decides takes effect until a person approves it:

- Account suggestions for transactions are posted only when you press **Post**.
- Bills and receipts read from email or files wait as **Needs review** until you **Approve** them.
- A new account the AI suggests is created only when you press **Create account**.
- The bank or card account the AI guesses for a PDF statement is only preselected; you choose it.
- A file another module sent that the AI read is marked done for its sender only when you approve
  it (Import tab), approve the bill it became, or post from the statement it became.

There's no auto-approve setting. Transfers, duplicates and learned rules don't use the AI.

## Duplicates

The **Duplicates** tab lists transactions waiting to be posted that look like one payment:

- **Uploaded twice:** two rows on the same account, from different statements, with exactly the
  same amount within 3 days. Same day and similar payee scores highest; a day apart with a similar
  payee (pending, then posted) next. Rows on one statement are never paired: banks list real repeats.
- **Already in the journal:** an entry on the same account with the same amount within 3 days that
  this module didn't post (e.g. entered by hand). Reversed entries don't count.

**Merge** keeps one and never posts the other (the posted copy, or the one you've worked on, or the
older one is kept; **Merge, keep the other copy** swaps them). The kept row takes the account you
chose for the merged one. **Not duplicates** is remembered. Merged rows show under *Show: Merged
duplicates* on their statement, with **Unmerge**. While there are any, Ledger's dashboard has a
to-do.

## New accounts

If none of your accounts fits a transaction, the AI can answer "new account" with a name and type
(e.g. *Pet care*, expense). The module picks a free code next to that type's accounts (5910 after
5900) and shows it under the row, editable: change the code, name or type, then **Create account**.
It's created in Ledger in the statement's currency and every row it was suggested for uses it. Any
row's account list also has **＋ New account…**.

A statement whose account isn't in your chart yet (from email or another module) offers the same:
a bank or card account named after the sender and the account number's last digits
(e.g. *RBC Visa ••4411*, a liability), to edit and **Create and use it**.

## Files from other modules

Auto sort accepts `statement`, `transaction`, `bill` and `receipt` files through Ledger's file
exchange (`ctx.files`, Ledger 0.11.0). A module offering "send to…" lists it among the targets.

- **Statements and transaction lists** (CSV, OFX, QFX, QBO, or a PDF read by Claude) are staged on
  the Statements tab. Put the account in `meta.account_code` (and optionally `meta.flip_signs`,
  `meta.date_order`); without it the statement waits for you to choose, and your choice is
  remembered for that module and account number.
- **Bills and receipts** (PDF or a saved `.eml`) go to the Bills or Receipts tab; the sender's label
  decides which.
- Each file is marked **done** with what it became (e.g. "12 transactions staged") or **rejected**
  with why, which the sender sees. A file the AI read (bills, receipts, PDF statements) stays
  *accepted* until you approve it: **Approve** on the Import tab, approving the bill, or posting from
  the statement; deleting the bill or discarding the statement rejects it. The Import tab lists them under *Sent by other modules*, with
  **Try again** for rejected ones. Nothing is posted until you approve it.

## Organizations

With several organizations on one Ledger server, each one's statements, bills, rules and imports
are kept in its own books; the module works in whichever organization you're in. Since Ledger
0.11.1 each organization also has its own Settings → Auto sort (its admins edit them there), so
each chooses where its bills come from. The default, **Gmail in the main books; nothing in other
organizations**, keeps a new organization from importing the same mail again: Ledger has one Gmail
account, so choose Gmail in only one organization unless you want its bills in several (IMAP can
be a different mailbox per organization). The AI and Gmail connection are shared by the server.
Files from other modules land in the organization they were sent in.

## Bills

**Set up:** under **Settings → Auto sort**, choose where bills come from:

- **Gmail** (the default): Ledger's connected account. An admin connects it under **Settings →
  Gmail** and allows Auto sort to read mail. Each check runs a Gmail search: by default
  `newer_than:30d -in:drafts -in:chats {invoice bill statement "amount due" ...}` built from the keywords. Set your own
  search (e.g. `label:bills`, with a Gmail filter that labels bills) to keep everything else out.
- **IMAP** for other providers (below).
- **Off.**

Set how often to check (0 turns scheduled checks off; **Check email now** on the Import tab always
works), and how far back the first check looks.

### IMAP (other providers)

| Provider | Server | Password |
|---|---|---|
| Outlook.com / Microsoft 365 | `outlook.office365.com` | your password, if IMAP and basic sign-in are allowed |
| iCloud | `imap.mail.me.com` | an app-specific password |
| Fastmail | `imap.fastmail.com` | an app password |
| Proton Mail | Proton Bridge, e.g. `127.0.0.1` port `1143` | the Bridge password |

For Gmail, use the Gmail option instead.

Implicit TLS on port 993 is used, except for a bridge running on the same machine. The mailbox
is opened read-only: nothing is marked as read, moved or deleted. The password is a secret field
in Settings → Auto sort. To keep it out of the database and its backups, set
`CATEGORIZER_IMAP_PASSWORD=...` in `/etc/ledger/ledger.env` and restart Ledger instead.

**What happens on each check:**
1. New messages are read (from the Gmail search, or the IMAP folder), oldest first. The first
   check goes back 30 days (configurable). Each message is looked at once, remembered by its
   Gmail id or IMAP UID; read/unread state is never used or changed.
2. Only messages containing one of the keywords (invoice, bill, statement, amount due, receipt,
   ...) go to the model. A mail filter that puts bills in their own folder or label keeps
   everything else out.
3. Ledger's AI reads the email and its PDF attachment (PDFs need Claude; local models only see the
   email text) and returns the vendor, invoice number, dates, amount and a suggested account.
4. Reminders for a bill that's already listed (same vendor and invoice number, or same amount and
   due date) are skipped.

### Statements in email

With **Statements in email: Stage transactions for review** (Settings → Auto sort; off by
default), bank and card statements that arrive by email are staged on the Statements tab like an
upload. Nothing is posted until you approve it:

1. **Reading:** a CSV, OFX, QFX or QBO attachment is read directly. A PDF statement is read by
   Ledger's AI (only when that's Claude, which reads PDFs). Its transactions come back signed from
   the account's side: purchases and withdrawals negative, deposits and card payments positive.
2. **Account:** the account the statement is for comes from your earlier choice for that sender
   and account number (the last 4 digits from the OFX or the email). Otherwise it's the AI's guess
   for a PDF. Otherwise the statement shows **Choose account**, and the dashboard asks you to pick
   one. Your choice (and whether to flip signs, for card CSVs that show purchases as positive) is
   remembered, so next month's statement from that sender goes there by itself.
3. **Review and post:** suggestions are made for each transaction as usual, including bill and
   transfer matching. Post rows individually or a selection with **Post selected**. While nothing
   is posted you can still change the statement's account.

A statement email is handled as a statement, not also as a bill, so a card statement's amount due
isn't counted twice. If a statement can't be read (a PDF without Claude, or no attachment), the
dashboard says so and you can upload it from your bank instead.

**Sort now** (Import tab) does immediately what otherwise happens on the schedule: it reads new
bills from email (when email is set up), then matches bills and receipts, and transfers between
your accounts, to the statement transactions waiting to be posted, and says what it found.

**Review on the Bills and Receipts tabs:** fix anything that's wrong, then **Approve**. You can
also upload a bill or receipt (PDF or saved `.eml`) on the Import tab, or add one by hand.

**Accounting:**
- *With an accounts payable account* (Settings → Auto sort; an active liability account): approving a bill posts
  Dr *bill's account* / Cr *payables* on the bill date. The bank payment later books
  Dr *payables* / Cr *bank*.
- *Without one:* bills are only tracked, and the payment books straight to the bill's account.
- *Receipts* (already paid, e.g. an online order) are never posted on their own. They tell the
  matching bank transaction which account to use.

**Matching:** when a statement is categorised (or a new bill arrives), each unposted outgoing
transaction with **exactly** a bill's amount, dated from a week before the bill date to 45 days
after the due date (receipts: a few days around the purchase), is linked to it. A matching vendor
name raises the confidence. Matched rows show **Bill nn%**, use the payables (or bill) account,
and aren't sent to the model. Posting a matched row marks the bill **paid**. On a bill, **Not this
one** unlinks a wrong match, and **This is the payment** links one by hand.

## API

All routes are under `/api/v1/m/categorizer` and use your Ledger login.

| Method | Path | |
|---|---|---|
| `POST` | `/statements` | `{filename, content, account_code, flip_signs?, date_order?: "auto"\|"mdy"\|"dmy"}` stages a statement and starts categorising it |
| `GET` | `/statements`, `/statements/:id` | list; one statement with its transactions |
| `POST` | `/statements/:id/categorize` | `{all?: true}` asks the model again (only unposted rows) |
| `POST` | `/statements/:id/post` | `{ids?: [...]}` posts rows that have an account |
| `POST` | `/statements/:id/account` | `{account_code, flip_signs?}`: choose or change the statement's account while nothing is posted (remembered for email senders) |
| `DELETE` | `/statements/:id` | discards unposted rows |
| `PATCH` | `/transactions/:id` | `{account_code?, status?: "new"\|"skipped"}` |
| `POST` | `/transactions/bulk` | the same for `{ids: [...]}` |
| `POST` | `/transactions/:id/not-transfer` | unlink a transfer match (both sides get a fresh suggestion) |
| `GET` | `/duplicates` | likely duplicates: `{pairs: [{keep, merge, score}], entries: [{merge, entry, score}], count}` |
| `POST` | `/duplicates/merge` | `{merge_id, keep_id}` or `{merge_id, entry_id}`: the merged row is never posted |
| `POST` | `/duplicates/dismiss` | `{tx_id, other_id}` or `{tx_id, entry_id}`: not duplicates |
| `POST` | `/transactions/:id/unmerge` | a merged row back to review |
| `POST` | `/accounts` | `{code, name, type, currency?, description?, transaction_ids?, proposal?}`: create an account in Ledger and book those rows (or every row the AI proposed it for) to it |
| `GET` | `/files?limit=` | files other modules sent, with what each became; `POST /files/:id/retry`, `DELETE /files/:id` |
| `POST` | `/suggest` | `{account_code, transactions: [{date, description, amount, memo?}]}` returns suggestions without storing anything (for scripts or other modules) |
| `GET`/`DELETE` | `/rules`, `/rules/:key` | learned payee rules |
| `GET` | `/status` | Ledger's AI and Gmail status for this module, the options in effect, the user's role |
| `POST` | `/sort-now` | read new bills from email (if set up), match bills and transfers; returns `{mail, bill_matches, transfer_links}` |
| `GET` | `/mail/status`; `POST /mail/test`, `POST /mail/check`, `GET /mail/log` | where mail comes from and whether it's ready; a connection test; a check now; the messages looked at (`?limit=`), each with the bill or statement it became |
| `GET`/`POST` | `/bills?status=unpaid\|new\|open\|paid\|ignored&kind=bill\|receipt`, `/bills` | list; add by hand `{vendor, amount, due_date, ...}` |
| `POST` | `/bills/upload` | `{filename, content_base64}`: a PDF or `.eml` |
| `GET`/`PATCH`/`DELETE` | `/bills/:id` | one bill with its payment; edit fields or `status`; delete |
| `GET` | `/bills/:id/document` | the stored PDF, base64 |
| `POST` | `/bills/:id/approve`, `/unapprove` | approve (posts to payables if configured); undo (reverses that entry) |
| `GET`/`POST` | `/bills/:id/candidates`, `/match {transaction_id}`, `/unmatch` | manual matching |

Options are Ledger's module settings (`GET`/`PUT /api/v1/modules/categorizer/settings`, admins
only). Viewers can look but not change anything; Ledger enforces that. Ledger's search bar finds
bills, statements and transactions; the links open them on the module's page.

## Privacy

With Claude as Ledger's AI, each transaction's date, description, memo and amount, your account
codes, names and descriptions, and descriptions of recent entries on the statement account are
sent to the Anthropic API. With email checks on, emails that pass the keyword filter (sender,
subject, text and PDF attachments) are sent too. With Ollama or another server on your network,
nothing leaves it. Emails that don't pass the filter are never sent anywhere. Bill PDFs and email
text are stored in the Ledger database. Ledger logs each AI call (tokens, not content) under
Settings → LLM API.

## Notes on Ledger's module guidelines

- **No dependencies:** only Node built-ins. `server.mjs` imports its own files from `lib/`, which
  install with the release archive.
- **AI and Gmail** go through `ctx.llm` and `ctx.gmail`; the module has no key, OAuth or Apps
  Script of its own. IMAP is kept for other providers. Its timeout is 60 s, longer than the usual
  10 s for outbound calls, because fetching a large message with a PDF takes longer.
- **Secrets:** the only one is the IMAP password, a `secret` settings field (or the environment
  variable). It is never returned by the module's API or logged.
- **Layout:** the page works from about 260 px wide (Ledger's side-by-side panes) up to full
  width, in light and dark mode.

## Layout

```
ledger-module.json     manifest
server.mjs             routes, background categorisation, posting
lib/parse.mjs          CSV / OFX parsing, amounts, dates, payee keys
lib/categorize.mjs     prompt, schema, rules, batching
lib/bill-routes.mjs    mailbox checks and schedule, bill routes, matching bills to transactions
lib/bills.mjs          bill extraction prompt, duplicates, match scoring, the Gmail search
lib/email-statements.mjs  statements in email: attachments, account hints, PDF statements, card signs
lib/imap.mjs           minimal read-only IMAP client (other providers; Gmail goes through ctx.gmail)
lib/mime.mjs           email (MIME) parser
lib/dashboard.mjs      notifications and to-dos on Ledger's dashboard
lib/transfers.mjs      transfer scoring and pairing
lib/transfer-sync.mjs  linking transfer rows (and existing journal entries), the unlink route
lib/duplicates.mjs     duplicate scoring and pairing
lib/duplicate-routes.mjs  the Duplicates tab's routes and dashboard to-do
lib/received-files.mjs files from other modules (ctx.files)
ui/index.html          the page shown in Ledger
migrations/            the module's tables (schema mod_categorizer)
test/                  unit tests: npm test (Node 22+)
```

Ledger installs modules without a build step or `npm install`, so the module has no dependencies.


## Development

Use the `ledger-module` skill in `.claude/skills/`: it checks the module against a real Ledger
(`sh .claude/skills/ledger-module/scripts/check.sh` with `TEST_DATABASE_URL` set) and links to
Ledger's module docs. `npm test` runs the unit tests (Node 22+). To try it without spending API
credit, point Ledger's AI (Settings → LLM API, Server URL) at a local stub that answers like the
Messages API.

## Changes

- **0.5.0:** Needs Ledger 0.11.2. Photos and scans of bills and receipts are read through Ledger's
  LLM connection for images (uploads, email attachments, files from other modules). Journal entries
  link back to their statement line, bill or receipt. Ledger's Settings → AI is now Settings → LLM
  API; messages and the Status tab follow.

- **0.4.0:** Follows Ledger's new rule that AI output needs a person's approval: a file another
  module sent that the AI read is marked done only after you approve it (new **Approve** /
  **Reject** on the Import tab, or approving the bill / posting the statement it became), and the
  account the AI guesses for a PDF statement is only preselected. Migration 009.

- **0.3.0:** For Ledger 0.11.1, where module settings are per organization: each organization
  chooses its own email source under Settings → Auto sort, and the new default reads Gmail in the
  main books only. Replaces 0.2.6's "Organization for email" setting (on Ledger 0.11.0, settings
  are still shared, so email goes into the main books).

- **0.2.6:** Needs Ledger 0.11.0. **Duplicates** tab: merge transactions uploaded twice or already in
  the journal. When no account fits, the AI **suggests a new account** you can edit and create (also
  for a statement whose bank or card account isn't in the chart). Accepts statements, transaction
  lists, bills and receipts from **other modules** (`ctx.files`). Works with **organizations**:
  background work runs in every organization's books, and email goes into the one chosen under
  "Organization for email". Migrations 007 and 008.

- **0.2.5:** Email checks no longer import mail you sent (Gmail's Sent folder, drafts, IMAP mail from
  your own address); bills you forward to yourself still come in. New **Import** tab with Check
  email now, Sort now, uploads and a log of what each email became. Bills and Receipts are now
  separate tabs. Migration 006.

- **0.2.0:** **Statements in email** option: bank and card statements found by the email check (CSV, OFX,
  QFX, QBO attachments, or PDFs read by Claude) are staged for review and posted only with your
  approval; their account is remembered per sender and account number. Migration 005.

- **0.1.3:** **Sort now** button on the Bills tab; the page no longer repeats the module's name as a
  heading (Ledger shows it); messages name the module's Settings tab by its current name.
- **0.1.2:** renamed to "Auto sort".

- **0.1.0:** uses Ledger 0.10.0's shared AI (`ctx.llm`) and Gmail (`ctx.gmail`) instead of the
  module's own provider settings and Apps Script bridge. Options moved to Settings → Auto sort, and
  old settings are copied over once. Adds a Status tab, Ledger search results, and a drawn robot
  icon.
- **0.0.2:** Gmail through an Apps Script bridge.
- **0.0.1:** statement categorisation, bills from email, transfer matching, Ledger dashboard items.
