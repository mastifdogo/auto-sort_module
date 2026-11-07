# LLM API: a Ledger module

A module for [Ledger (Bookeeping)](https://github.com/mastifdogo/Bookeeping). You upload a bank or
credit-card statement and an LLM suggests an account from your chart of accounts for each
transaction. You check the suggestions, then post them as journal entries. It uses Ledger's own
AI provider and Gmail account: there's no API key or mail login to set up in the module.

- **Formats:** CSV exports (columns are found from the header, or guessed from the data when there's
  no header; single amount or debit/credit columns) and **OFX / QFX / QBO**.
- **AI:** whatever the admin chose under **Settings → AI** in Ledger: Claude, or a local model
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
- **Bills from email:** checks Ledger's Gmail account (or an IMAP mailbox) on a schedule, reads bills and receipts
  out of the emails and their PDFs, keeps a list of bills to be paid, and matches each bill to the
  bank transaction that pays it. See [Bills](#bills).

## Install

Needs **Ledger 0.10.0 or newer** (shared AI and Gmail for modules, settings forms, roles, search,
drawn icons).

1. In Ledger, open **Settings → Modules**, enter `mastifdogo/llm-api-module` and press **Add**.
   **LLM API** appears in the sidebar with a robot icon. You can hide or reorder it under
   Settings → Sidebar. Updates install on Ledger's update schedule, or with **Update modules now**.
2. An admin allows the module to use the shared services:
   - **Settings → AI:** choose a provider (Claude needs an API key; Ollama a model you've pulled) and
     tick **LLM API** under the modules allowed to use it. Claude also reads bill PDFs; local
     models only see the email text. Larger local models (14B and up) categorise noticeably
     better than small ones.
   - **Settings → Gmail** (for bills): connect the account and allow **LLM API** to read mail. It
     never sends, changes or deletes mail.
3. Options are under **Settings → LLM API**: review threshold, transactions per AI request, where
   bills come from (Gmail, IMAP or off), how often to check, the Gmail search, keywords, how far
   back the first check looks, IMAP details, and the accounts payable account.
4. The module's **Status** tab shows whether AI and email are ready, and what's missing if not.

The module's id stays `categorizer` (its page is `/apps/categorizer` and its data lives in the
`mod_categorizer` schema), so renaming it and updating keep all existing data.

**Updating from 0.0.x:** the module used to have its own AI key, model and mail settings. On the
first start of 0.1.0 it copies the options that still exist (review threshold, batch size, payables
account, mail interval, keywords, IMAP details) to Settings → LLM API, and deletes its old settings,
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
  Settings → LLM API to post approved bills there. It's in one currency: bills in the other
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

1. **Upload:** choose the file and the bank or card account it belongs to. For credit-card
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

## Bills

**Set up:** under **Settings → LLM API**, choose where bills come from:

- **Gmail** (the default): Ledger's connected account. An admin connects it under **Settings →
  Gmail** and allows LLM API to read mail. Each check runs a Gmail search: by default
  `newer_than:30d {invoice bill statement "amount due" ...}` built from the keywords. Set your own
  search (e.g. `label:bills`, with a Gmail filter that labels bills) to keep everything else out.
- **IMAP** for other providers (below).
- **Off.**

Set how often to check (0 turns scheduled checks off; **Check email now** on the Bills tab always
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
in Settings → LLM API. To keep it out of the database and its backups, set
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

**Review on the Bills tab:** fix anything that's wrong, then **Approve**. You can also upload a
bill (PDF or saved `.eml`) or add one by hand.

**Accounting:**
- *With an accounts payable account* (Settings → LLM API; an active liability account): approving a bill posts
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
| `DELETE` | `/statements/:id` | discards unposted rows |
| `PATCH` | `/transactions/:id` | `{account_code?, status?: "new"\|"skipped"}` |
| `POST` | `/transactions/bulk` | the same for `{ids: [...]}` |
| `POST` | `/transactions/:id/not-transfer` | unlink a transfer match (both sides get a fresh suggestion) |
| `POST` | `/suggest` | `{account_code, transactions: [{date, description, amount, memo?}]}` returns suggestions without storing anything (for scripts or other modules) |
| `GET`/`DELETE` | `/rules`, `/rules/:key` | learned payee rules |
| `GET` | `/status` | Ledger's AI and Gmail status for this module, the options in effect, the user's role |
| `GET` | `/mail/status`; `POST /mail/test`, `POST /mail/check`, `GET /mail/log` | where mail comes from and whether it's ready; a connection test; a check now; the messages looked at |
| `GET`/`POST` | `/bills?status=unpaid\|new\|open\|paid\|ignored`, `/bills` | list; add by hand `{vendor, amount, due_date, ...}` |
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
Settings → AI.

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
lib/imap.mjs           minimal read-only IMAP client (other providers; Gmail goes through ctx.gmail)
lib/mime.mjs           email (MIME) parser
lib/dashboard.mjs      notifications and to-dos on Ledger's dashboard
lib/transfers.mjs      transfer scoring and pairing
lib/transfer-sync.mjs  linking transfer rows (and existing journal entries), the unlink route
ui/index.html          the page shown in Ledger
migrations/            the module's tables (schema mod_categorizer)
test/                  unit tests: npm test (Node 22+)
```

Ledger installs modules without a build step or `npm install`, so the module has no dependencies.


## Development

Use the `ledger-module` skill in `.claude/skills/`: it checks the module against a real Ledger
(`sh .claude/skills/ledger-module/scripts/check.sh` with `TEST_DATABASE_URL` set) and links to
Ledger's module docs. `npm test` runs the unit tests (Node 22+). To try it without spending API
credit, point Ledger's AI (Settings → AI, Server URL) at a local stub that answers like the
Messages API.

## Changes

- **0.1.0:** uses Ledger 0.10.0's shared AI (`ctx.llm`) and Gmail (`ctx.gmail`) instead of the
  module's own provider settings and Apps Script bridge. Options moved to Settings → LLM API, and
  old settings are copied over once. Adds a Status tab, Ledger search results, and a drawn robot
  icon.
- **0.0.2:** Gmail through an Apps Script bridge.
- **0.0.1:** statement categorisation, bills from email, transfer matching, Ledger dashboard items.
