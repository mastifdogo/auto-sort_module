# Auto sort: a Ledger module

A module for [Ledger (Bookeeping)](https://github.com/mastifdogo/Bookeeping). You upload a bank or
credit-card statement and an LLM suggests an account from your chart of accounts for each
transaction. You check the suggestions, then post them as journal entries. It uses Ledger's own
LLM API: there's no API key to set up in the module.

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
- **Already in the journal?** Staged lines, bills and receipts that are already recorded (entered by
  hand, or by another module) are found and linked instead of being posted twice. See
  [Journal matches and Auto sort](#journal-matches-and-auto-sort).
- **Auto sort button:** on an open statement, bill or receipt, the LLM looks for the same
  transaction among unposted lines and posted journal entries; you approve each match.
- **Bills and receipts:** upload a PDF, photo or saved email (or let another module send it); the
  LLM reads it, you approve it, and it's matched to the bank transaction that pays it. See [Bills](#bills).

## Install

Needs **Ledger 0.11.3 or newer** (shared LLM API for modules, LLM connections for
images, journal entry links, Ledger's New account dialog for modules, file exchange between modules, organizations, settings forms, roles,
search, drawn icons).

1. In Ledger, open **Settings → Modules**, enter `mastifdogo/llm-api-module` and press **Add**.
   **Auto sort** appears in the sidebar with a robot icon. You can hide or reorder it under
   Settings → Sidebar. Updates install on Ledger's update schedule, or with **Update modules now**.
2. An admin allows the module under **Settings → LLM API**: set up a connection (Claude needs an API
   key; Ollama a model you've pulled) and tick **Auto sort** under the modules allowed to use it. A
   connection for images reads bill PDFs (Claude) and photos (Claude or a local vision model).
   Larger local models (14B and up) categorise noticeably better than small ones.
3. Options are under **Settings → Auto sort** (per organization): review threshold, transactions
   per AI request, and the accounts payable account.
4. The module's **Status** tab shows whether the LLM API is ready, and what's missing if not.

**Updating to 0.6.0:** the email checker is gone (Gmail and IMAP). Bills and receipts already read
from email stay. Upload new ones on the Bills or Receipts tab, or let another module send them. Ledger may
keep the old email settings' values (including an IMAP password) in its settings table until the
module is removed; they're no longer used. You can disallow Auto sort under Settings → Gmail.

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
  Rogers 85.50 CAD" after approval), opening that bill. It's ticked when the payment is posted, and
  removed when the bill is ignored or deleted. Once a bill is past its due date the to-do reads
  **"Overdue: …"** at the danger level (refreshed hourly); Ledger shows its due date in red. To show
  the whole line in bright red, Ledger's dashboard needs a small change of its own (not part of this
  module).
- A **to-do** while there are possible duplicates, and one while Auto sort has matches to review.

## Use

The page has these tabs:

- **Statements:** **Upload a statement**, **Sort now**, and each statement to categorise and post,
  with **Auto sort** and **Create bill** (from what a card or loan statement says is owed).
- **Bills** and **Receipts:** **Upload a bill/receipt** (PDF, photo or saved email) or add one by
  hand; approve, match, **Split** and mark billable to a customer.
- **Duplicates:** duplicates and things already in the journal, to merge or link.
- **Learned rules** and **Status** (also lists files other modules sent).

1. **Upload a statement** (Statements tab): choose the file and the bank or card account it belongs to. For credit-card
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

If you also get the credit card's statement as a bill, ignore it rather than approving it
into payables. The card's own statement already records those charges.

## Photos of bills and receipts

Upload a photo or scan (JPEG, PNG, WebP, GIF) on the Bills or Receipts tab like a PDF; large phone photos are
shrunk in the browser first. Pictures go to Ledger's LLM connection for images (Settings → LLM API;
Claude, or a local vision model such as one served by Ollama), which can be a different model than
the one for text. Photos inside an uploaded email (with no PDF) and pictures other modules send are
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
- Bills and receipts read from uploads or files wait as **Needs review** until you **Approve** them.
- A match **Auto sort** finds is carried out only when you press **Approve**.
- A new account the AI suggests is created only when you press **Create account**.
- The bank or card account the AI guesses for a PDF statement is only preselected; you choose it.
- A file another module sent that the AI read is marked done for its sender only when you approve
  it (Status tab), approve the bill it became, or post from the statement it became.

There's no auto-approve setting. Transfers, duplicates and learned rules don't use the AI.

## Duplicates

The **Duplicates** tab lists transactions waiting to be posted that look like one payment:

- **Uploaded twice:** two rows on the same account, from different statements, with exactly the
  same amount within 3 days. Same day and similar payee scores highest; a day apart with a similar
  payee (pending, then posted) next. Rows on one statement are never paired: banks list real repeats.
- **Already in the journal:** an entry on the same account with the same amount within 3 days that
  this module didn't post (e.g. entered by hand). Reversed entries don't count.

**Recheck** with *Last week*, *Last month*, *Last year* or *All time* looks at every transaction
dated in that period, posted ones too. Two **posted** copies of one payment show as *Posted twice?*:
**Reverse the copy** posts a reversing entry for the second one (after you confirm) and keeps the
other. A copy that paid a bill, or an entry shared by both sides of a transfer, is left for you to
reverse in the journal.

**Merge** keeps one and never posts the other (the posted copy, or the one you've worked on, or the
older one is kept; **Merge, keep the other copy** swaps them). The kept row takes the account you
chose for the merged one. **Not duplicates** is remembered. Merged rows show under *Show: Merged
duplicates* on their statement, with **Unmerge**. While there are any, Ledger's dashboard has a
to-do.

## New accounts

If none of your accounts fits a transaction, the AI can answer "new account" with a name and type
(e.g. *Pet care*, expense). The module picks a free code next to that type's accounts (5910 after
5900) and shows it under the row. **Create…** opens Ledger's New account dialog with it filled in
(change anything there); every row of the statement it was suggested for then uses it. Every
account list ends with **+ New account…**, which opens the same dialog.

A statement whose account isn't in your chart yet (from another module) offers the same:
a bank or card account named after the sender and the account number's last digits
(e.g. *RBC Visa ••4411*, a liability): **Create and use it…**.

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
  *accepted* until you approve it: **Approve** on the Status tab, approving the bill, or posting from
  the statement; deleting the bill or discarding the statement rejects it. The Status tab lists them under *Files from other modules*, with
  **Try again** for rejected ones. Nothing is posted until you approve it.

## Organizations

With several organizations on one Ledger server, each one's statements, bills, rules and imports
are kept in its own books; the module works in whichever organization you're in, and each has its
own Settings → Auto sort. The LLM API connection is shared by the server. Files from other modules
land in the organization they were sent in.

## Journal matches and Auto sort

**Found in the journal (no AI).** When an unposted statement line has an entry in the journal on
the same account, with the same amount, within 3 days, and Auto sort didn't post it (you entered it
by hand, or another module did), the line shows **In the journal: entry #12 · … [Link] [Not the
same]**. **Link** keeps the line from being posted and links the entry to it (Ledger shows the link
on the entry). Open bills and receipts already in the journal (an entry with a line of exactly the
bill's amount in its date window, vendor words in the description raising the score) show the same
in the bill's view; **Link** counts the bill as paid by that entry and links them (**Unlink** undoes
it). Everything found is also listed on the **Duplicates** tab, and **Sort now** says how many.

**Auto sort (LLM).** On an open statement, bill or receipt, **Auto sort** looks wider and lets the
LLM judge:

- For each unposted statement line, candidates with the same amount within 10 days: journal entries
  on its account, lines on other statements (the same payment uploaded twice, or the other side of
  a transfer: opposite amount on another account), and open bills and receipts it could pay.
- For a bill or receipt: unposted lines and journal entries with its amount in its date window
  (a receipt: a few days before to 15 after; a bill: 10 days before to 60 after its due date).

Ledger's LLM API picks the candidate that is the same transaction, or none, by payee names, dates
and references. Each pick shows under the line or in the bill's view as **Auto sort: same as …
· 88% · reason [Approve] [Reject]**. Approve carries it out: a line already in the journal is
linked to that entry and not posted; a duplicate line is merged into the other; two sides of a
transfer are linked and posted once; a payment is matched to its bill; a bill already in the journal
is linked to its entry. Rejected matches aren't suggested again. Nothing changes before you
approve, and a to-do on Ledger's dashboard counts the matches waiting.

## Bills

Bills and receipts come from the Bills and Receipts tabs (a PDF, a photo or a saved email, `.eml`), from other
modules (Ledger's file exchange), or by hand. Ledger's LLM API reads the vendor, invoice number,
dates, amount and a suggested account (PDFs need a connection for images that's Claude; photos any
connection for images). Repeats of a bill that's already listed (same vendor and invoice number, or
same amount and due date) are refused.

**Sort now** (Statements tab) matches bills and receipts, and transfers between your accounts, to the
statement transactions waiting to be posted, looks for bills and receipts already in the journal,
and says what it found.

**A bill from a statement:** on a card or loan statement, **Create bill** has Ledger's LLM API read
what the statement says is owed: the new balance, due date, statement date, minimum payment and
reference (from the statement file; for PDFs, Claude). It never adds up the transactions itself.
You check the form, then **Create bill**; one bill per statement. Its account is the card or loan
account, so paying it pays down the card. Statements uploaded before 0.7.0 have no file kept; the
LLM then only sees the transactions, so type the amount.

**Billable:** a bill or receipt can be marked **Billable to the customer** with a **Customer**:
customers from the Sales module (when it's installed) and names you used before are offered. The
list shows them as *billable · Acme Corp*.

**Split:** a receipt (or bill) for things booked to different accounts, e.g. groceries and
household supplies: **Split into lines…**, then **Suggest lines with the LLM** reads the document's
line items (the PDF or photo through the connection for images, or the email text) and proposes
lines with accounts. Edit them; they must add up to the total; **Save split**. When its payment is
posted, the entry books each line to its account (a bill posted to payables books the lines on
approval). A split can change until it's posted.

**Review on the Bills and Receipts tabs:** fix anything that's wrong, then **Approve**.

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
one** unlinks a wrong match, **This is the payment** links one by hand, and **Auto sort** asks the
LLM (see above).

## API

All routes are under `/api/v1/m/categorizer` and use your Ledger login.

| Method | Path | |
|---|---|---|
| `POST` | `/statements` | `{filename, content, account_code, flip_signs?, date_order?: "auto"\|"mdy"\|"dmy"}` stages a statement and starts categorising it |
| `GET` | `/statements`, `/statements/:id` | list; one statement with its transactions |
| `POST` | `/statements/:id/categorize` | `{all?: true}` asks the model again (only unposted rows) |
| `POST` | `/statements/:id/post` | `{ids?: [...]}` posts rows that have an account |
| `POST` | `/statements/:id/account` | `{account_code, flip_signs?}`: choose or change the statement's account while nothing is posted (remembered for the sending module) |
| `GET` | `/statements/:id/journal-matches` | its unposted lines already in the journal (no AI) |
| `POST` | `/statements/:id/auto-sort` | Auto sort: the LLM looks for its unposted lines elsewhere; stores pending matches |
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
| `GET` | `/status` | Ledger's LLM API status for this module, the options in effect, the user's role, the organization |
| `POST` | `/sort-now` | match bills and transfers, count bills already in the journal; returns `{bill_matches, transfer_links, journal_matches}` |
| `GET` | `/journal-matches?bill_id=` | open bills and receipts already in the journal (no AI) |
| `GET` | `/match-suggestions?statement_id=\|bill_id=` | Auto sort's pending matches, with what they point to |
| `POST` | `/match-suggestions/:id/approve`, `/reject` | carry a match out, or turn it down |
| `GET`/`POST` | `/bills?status=unpaid\|new\|open\|paid\|ignored&kind=bill\|receipt`, `/bills` | list; add by hand `{vendor, amount, due_date, ...}` |
| `POST` | `/bills/upload` | `{filename, content_base64}`: a PDF, a picture or an `.eml` |
| `GET`/`PATCH`/`DELETE` | `/bills/:id` | one bill with its payment and lines; edit fields (incl. `billable`, `customer_name`, `customer_ref`) or `status`; delete |
| `GET` | `/bills/:id/document` | the stored PDF, base64 |
| `POST` | `/bills/:id/approve`, `/unapprove` | approve (posts to payables if configured); undo (reverses that entry) |
| `GET`/`POST` | `/bills/:id/candidates`, `/match {transaction_id}`, `/unmatch` | manual matching |
| `POST` | `/statements/:id/bill-draft` | what the statement says is owed, read by the LLM (nothing saved); create it with `POST /bills {..., statement_id}` |
| `POST` | `/bills/:id/split-draft` | proposed split lines, read by the LLM (nothing saved) |
| `PUT`/`DELETE` | `/bills/:id/lines` | `{lines: [{description, amount, account_code}]}`: save a split (adds up to the amount); remove it |
| `GET` | `/customers` | customer names used on bills |
| `GET` | `/duplicates?period=week\|month\|year\|all` | recheck a period, posted rows included (`both_posted` pairs) |
| `POST` | `/duplicates/reverse {merge_id, keep_id}` | reverse the entry of a posted copy |
| `POST` | `/bills/:id/link-entry {entry_id}`, `/unlink-entry` | it's already in the journal: count it paid by that entry, or undo |
| `POST` | `/bills/:id/auto-sort` | Auto sort for a bill or receipt |

Options are Ledger's module settings (`GET`/`PUT /api/v1/modules/categorizer/settings`, admins
only). Viewers can look but not change anything; Ledger enforces that. Ledger's search bar finds
bills, statements and transactions; the links open them on the module's page.

## Backups

Auto sort's tables are in Ledger's database backups. Since Ledger 0.13.0 each backup also saves them
as CSV files you can open in a spreadsheet (`ledger-<stamp>-categorizer-<table>.csv`): `statements`
and `transactions` (what was uploaded and how each line was categorised and posted), `bills` and
`bill_lines`, `rules` (learned payee rules), `statement_sources` (which account a sender's statements
go to), `received_files`, `match_suggestions` and `not_duplicates`. The files themselves (bill PDFs
and photos, statement files) are in `bill_documents` and `statement_files`, as base64, so the other
tables stay readable. No secrets are kept in any table.

## Privacy

With Claude as Ledger's AI, each transaction's date, description, memo and amount, your account
codes, names and descriptions, and descriptions of recent entries on the statement account are
sent to the Anthropic API, and so are the bills, receipts and photos you upload. Auto sort sends a
line's or bill's date, description and amount with its candidates (dates, descriptions, amounts and
account codes of matching entries, lines and bills). With Ollama or another server on your network,
nothing leaves it. Bill documents are stored in the Ledger database. Ledger logs each AI call (tokens, not content) under
Settings → LLM API.

## Notes on Ledger's module guidelines

- **No dependencies:** only Node built-ins. `server.mjs` imports its own files from `lib/`, which
  install with the release archive.
- **AI** goes through `ctx.llm`; the module has no key of its own and makes no outbound calls.
- **AI only proposes:** see [The AI only suggests](#the-ai-only-suggests).
- **Secrets:** none.
- **Layout:** the page works from about 260 px wide (Ledger's side-by-side panes) up to full
  width, in light and dark mode.

## Layout

```
ledger-module.json     manifest
server.mjs             routes, background categorisation, posting
lib/parse.mjs          CSV / OFX parsing, amounts, dates, payee keys
lib/categorize.mjs     prompt, schema, rules, batching
lib/bill-routes.mjs    bill routes, reading uploads and files, matching bills to transactions, linking to entries
lib/bills.mjs          bill extraction prompt, picture types, duplicates, match scoring
lib/email-statements.mjs  statements from other modules: account hints, PDF statements, card signs
lib/mime.mjs           email (MIME) parser for uploaded .eml files
lib/matching.mjs       journal and Auto sort candidates, the LLM's match prompt
lib/journal-matches.mjs  bills in the journal, the Auto sort routes, approving matches
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

**Releasing:** bump `version` in `ledger-module.json` and merge to `main`. The Release workflow
(`.github/workflows/release.yml`) then tags `v<version>` and publishes the GitHub Release that
Ledger installs; it does nothing for a version that's already released. To release the current
version without a change, run it from Actions → Release → Run workflow. If it fails with "Resource
not accessible by integration", allow it under Settings → Actions → General → Workflow permissions
→ "Read and write permissions".

## Changes

- **0.7.1:** Readable backup CSVs (Ledger 0.13.0 saves each module table as a CSV): bill documents
  and statement files moved to their own tables (`bill_documents`, `statement_files`), and the old
  email log table (unused since 0.6.0) is removed. Migration 012. Nothing changes on the page.

- **0.7.0:** Needs Ledger 0.11.3. The Import tab is gone: uploads are on the Statements, Bills and
  Receipts tabs, Sort now on Statements, and files from other modules on Status. **Create bill** from
  a statement's amount owed (read by the LLM, edited by you). **Recheck** duplicates over the last
  week, month, year or all time, posted copies included (reverse one with a click). Overdue bills'
  to-dos say **Overdue** at the danger level. Bills and receipts can be **billable** to a
  **customer** (Sales module customers offered). **Split** receipts into lines with accounts, the
  LLM reading the line items; posting books each line. Account lists use Ledger's **New account**
  dialog. Migration 011.

- **0.6.0:** **Auto sort** button on statements, bills and receipts: Ledger's LLM API looks for the
  same transaction among unposted lines and posted journal entries; you approve or reject each
  match. Lines, bills and receipts already in the journal are found without AI and linked with one
  click. The **email checker is removed** (Gmail, IMAP, the email log, and their settings). Migration
  010.

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
