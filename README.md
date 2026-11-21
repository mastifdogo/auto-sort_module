# Auto sort: a Ledger module

A module for [Ledger (Bookeeping)](https://github.com/mastifdogo/Bookeeping) that takes in bank and
card statements, bills and receipts from wherever they arrive, and gets them into your books with
you approving every step. The AI suggests an account for each statement line and reads bills and
receipts; nothing is posted until you say so. It uses Ledger's own LLM API: there's no API key to
set up in the module.

Since 0.17.0 it is also what the **Import** module (`mastifdogo/download_module`) was: the inbox,
the browser extension, email import, the scanner, the phone camera and the Android app are part of
Auto sort now. See [Coming from the Import module](#coming-from-the-import-module).

**Where files come from**

- **Uploads** on the page, of any size the inbox takes (25 MB unless changed).
- **Your browser:** the [Send to Ledger extension](#the-browser-extension) sends a file from a
  bank's or supplier's site without saving it first.
- **Email:** attachments of bill-like emails in Ledger's mailbox, with a check that
  [learns](#what-the-email-check-learns) what you don't want. See [Email](#email).
- **A scanner** on your network, a **phone's camera**, or the **Android app** for receipts. See
  [Scanner](#scanner) and [The phone app](#the-phone-app-android).
- **Other modules**, through Ledger's file exchange. See [Files from other modules](#files-from-other-modules).

Everything lands in the **Inbox**, and every file is kept in **Ledger's Documents**, never by the
module itself. See [Files, tags and reading a file once](#files-tags-and-reading-a-file-once).

**What it does with them**

- **Statements:** CSV exports (columns are found from the header, or guessed from the data when
  there's no header; single amount or debit/credit columns) and **OFX / QFX / QBO**. A PDF or a
  photographed statement is read by the AI in the inbox (**Extract data**); you check and correct
  what it read before it is used.
- **AI:** whichever LLM connection the admin set up under **Settings → LLM API** in Ledger: any
  provider Ledger supports, including a model on your own network so statements stay there.
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
- **Organizations:** each organization's inbox, statements, bills and rules stay in its own books.
- **Already in the journal?** Staged lines, bills and receipts that are already recorded (entered by
  hand, or by another module) are found and linked instead of being posted twice. See
  [Journal matches and Auto sort](#journal-matches-and-auto-sort).
- **Auto sort button:** on an open statement, the AI looks for the same transaction among unposted
  lines and posted journal entries; you approve each match. On a bill or receipt it asks no AI: it
  searches the journal for similar transactions, by amounts, dates and accounts you can change.
- **Bills and receipts:** a PDF, a photo or a saved email; the AI reads it, you approve it, and it's
  matched to the bank transaction that pays it. See [Bills](#bills).
- **Sends on:** a file can also be handed to another module, filed in Ledger's Documents as what it
  is, or saved to Ledger's CSV files for the journal import.

## Install

Needs **Ledger 0.27.0 or newer** (one file store for every kind of file, tags on files, and the data
read out of a file kept with it).

1. In Ledger, open **Settings → Modules**, enter `mastifdogo/auto-sort_module` and press **Add**.
   **Auto sort** appears in the sidebar with a robot icon. You can hide or reorder it under
   Settings → Sidebar. Updates install on Ledger's update schedule, or with **Update modules now**.
2. An admin allows the module under **Settings → LLM API**: set up a connection and tick **Auto
   sort** under the modules allowed to use it. A connection for images reads photos of bills and
   receipts, and PDFs when it can read PDFs (the Status tab says whether it does). Larger
   local models (14B and up) categorise noticeably better than small ones.
3. To import from email, an admin connects a mailbox under **Settings → Mail** and allows **Auto
   sort** to read it. See [Email](#email).
4. Options are under **Settings → Auto sort** (per organization), on five tabs: **Sorting** (review
   threshold, lines per AI request), **Bills** (the accounts payable account), **Inbox** (largest
   file, how long sent and archived entries are kept), **Email** (whether and how often mail is
   read, keywords, and importing a date range) and **Scanner**.
5. The module's **Status** tab shows whether the LLM API is ready, and what's missing if not.

**Updating to 0.17.0** (from 0.16.0 or older):

- Update Ledger to 0.27.0 first; older Ledgers refuse this version and keep the one they have.
- The module no longer keeps any file itself. CSV and OFX statements (and a few pictures) that
  older versions kept in the module's own storage are filed in Ledger's Documents when Ledger
  starts, in every organization, a few at a time; it is safe to restart in the middle. The Status
  tab says if any are left, with a **Move them now** button.
- Migration 020 drops the columns that once held file bytes (before 0.8.0). It refuses to run, and
  changes nothing, if a row still holds bytes: the version you have keeps running and moves them
  out when Ledger starts. Restart Ledger, wait a minute, and update again.
- If the **Import** module is installed, see [Coming from the Import module](#coming-from-the-import-module).
- The old browser extension and the old phone app send to the Import module: get the new ones (see
  [The browser extension](#the-browser-extension) and [The phone app](#the-phone-app-android)).

The module was called "LLM API" before 0.1.2 (and this repository llm-api-module). Its id stays
`categorizer` (its page is `/apps/categorizer` and its data lives in the `mod_categorizer`
schema), so renaming it and updating keep all existing data.

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
- A **notification** while files wait in the inbox ("3 files waiting in Auto sort's inbox"), and a
  **to-do** while something the AI read from a file waits to be checked.
- A **notification** when the email check fails (no mailbox, not allowed to read it).
- A **to-do** while the Import module's data waits to be taken over.

## Use

The page has these tabs:

- **Inbox:** every file that came in, with where it came from. **Send…** on a file makes it a
  statement, a bill or a receipt, hands it to another module, files it in Ledger's Documents, saves
  it to Ledger's CSV files, or has the AI read its transactions (**Extract data**). Also **Check
  email now**, **What it learned**, and **Get the browser extension**.
- **Statements:** **Upload a statement**, **Sort now**, and each statement to categorise and post,
  with **Auto sort** and **Create bill** (from what a card or loan statement says is owed).
- **Bills** and **Receipts:** **Upload a bill/receipt** (PDF, photo or saved email) or add one by
  hand; approve, match, **Split** and mark billable to a customer.
- **Duplicates:** duplicates and things already in the journal, to merge or link.
- **Learned rules.**
- **Scan:** the network scanner, a phone's camera, the Android app, and plain uploads to the inbox.
- **Status** (also lists files other modules sent).

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

## The inbox

Files wait in the inbox until you say what they are. Each row shows the file, where it came from
(a website, an email's sender, the scanner, a phone), Ledger's tags on it, and what it became.

**Send…** opens the file's panel, with a preview and, for a file from email, **View the email**:

- **Statement:** choose the bank or card account (and *flip signs* for a card export that shows
  purchases as positive amounts). A CSV, OFX, QFX or QBO file is parsed and its lines are staged on
  the Statements tab. A PDF or picture can be staged once its transactions have been read (below).
- **Bill** or **Receipt:** a PDF, a photo or a saved email. The AI reads the vendor, amount, dates
  and line items; it lands on the Bills or Receipts tab as **Needs review**.
- **Extract data:** the AI reads the transactions out of a PDF, a photo or a text file. You get the
  rows to check, correct, add to or remove; nothing is kept until you press **Approve**. Then the
  transactions are saved with the file in Ledger's Documents, and **Statement** stages them as they
  are. **CSV of its transactions** downloads them, and **Ledger's CSV files** sends them to the
  journal import.
- **Another module** that takes that kind of file (Ledger's file exchange). The module is handed
  the document itself; no copy is made. The row then shows what that module did with it.
- **Ledger's Documents:** only say what the file is there (a receipt, a statement of an account,
  an invoice), where Reconcile and other modules pick it up.
- **Ledger's CSV files**, for a CSV.

Inside this module nothing is "sent": the statement or bill simply points at the same document
as the inbox row. **Archive** puts a row aside; **Delete** deletes the file for good: the row and
its document under Ledger's Documents, whoever filed it (also files taken over from the Import
module). The document stays only when the file was sent on or filed (then it is one of the
organization's documents) or a bill or statement here still uses it. A deleted file is not
offered again as one of Import's to take over.

Uploads from the page, the extension and the phone app arrive in pieces of 512 KB (Ledger takes
requests up to 1 MB). The pieces wait in temporary files on the server until the last one is in;
then the file is filed in Documents and the temporary files are deleted. An upload that is never
finished is swept away after a day.

## The browser extension

**Send to Ledger** (Chrome, Edge, Brave and Firefox 128+) sends a file from any website straight
to Ledger without saving it to your computer: right-click a download link and choose **Send to
Ledger…**, send the PDF open in a tab, or drop a file on its toolbar button. It can put the file
in the inbox, or make it a statement, a bill or a receipt right away.

Get it with **Get the browser extension** on the Inbox tab, which downloads it as a zip that
already knows this Ledger's address. It is in `ui/extension/` in this repository;
[its README](ui/extension/README.md) has the installation steps, how it signs in and its limits.
The extension from the Import module (0.5.0 or older) sends to the Import module: replace it with
this one (0.6.0), unzipped over the same folder.

## Email

The module has one mail check. It reads the mailbox Ledger is connected to (**Settings → Mail**: an
IMAP account such as Proton Mail Bridge, or Gmail), which an admin must allow Auto sort to read.
On a schedule (every 60 minutes unless changed), and with **Check email now** on the Inbox tab, it
looks at new messages and puts the documents of bill-like emails in the inbox: PDFs, statements
(CSV, OFX, spreadsheets) and photos big enough to be a receipt. With **Save emails without
attachments** on, a matching email with no document is saved itself, as an `.eml` file, which the
Bills tab reads like any bill.

- **Keywords** (Settings → Auto sort → Email) decide which emails are bill-like. Empty: every email.
- **Read email:** *In the main books only* (the default) reads the mailbox in the main books and
  not in other organizations, so one mailbox isn't imported into several books. Choose *Yes* or
  *No* per organization.
- **Nothing is imported twice:** each message is looked at once per mailbox; a file whose bytes are
  already in the inbox, or already a bill's or a statement's document, is left out; and a saved
  email that became a bill before is recognised by its Message-ID. Mail you sent yourself is
  skipped.
- **Import a date range** (Settings → Auto sort → Email) reads the email of some days again, for
  mail from before the module was set up. What is already here is left out.
- **View the email** in a file's Send panel shows the email a file is, or came from, with its other
  attachments, before you decide what the file is. The HTML of an email is never rendered: you see
  its text.

No AI is involved in the email check. Reading mail never marks it read or changes the mailbox.

Before 0.6.0 Auto sort had an email checker of its own; it was removed then, and there is nothing
of it left to migrate (Ledger may still hold its old settings' values until the module is removed;
they are not used). The check described here is the Import module's.

### What the email check learns

Deleting a file that came from email asks: **Delete and learn** (files like this aren't wanted) or
**Just delete** (a duplicate, a one-off). Files you send on (made a statement, a bill or a receipt,
read with Extract data, sent to another module or Ledger's CSV files) count as wanted. Each check then scores every attachment against what
you taught about **its own sender**: the sender and its domain, words in the subject and in the file
name, the file type. It's skipped when it looks like what you deleted (85% sure or more), and only
with a file like the deleted ones (a file name word in common, or an email without attachments),
so deleting one sender's `terms-and-conditions.pdf` skips those, not its invoices; a sender whose
files you deleted three times and never kept is skipped whatever the file. A new sender is never
skipped. No AI is involved: it's word counting over your own choices.

*What it learned* (next to *Check email now*) lists the senders with what you deleted and kept, with
*Forget* for each, and the **skipped emails with the reason** and **Import anyway** (which also
teaches it that such files are wanted). **Download the training file** saves everything learned as
JSON (`"format": "ledger-import-email-training"`, the same as the Import module's, so its training
files load here); **Load a training file** adds one, e.g. in another organization or after a
reinstall; examples it already knows are skipped.

## Scanner

On the **Scan** tab an admin presses **Find scanners** (the Ledger server looks for AirScan scanners
on its network) and **Use** one, or types its address (on the scanner's screen or network settings
page, e.g. `192.168.1.40`). It's saved as *Network scanner* under Settings → Auto sort → Scanner. Then anyone can
scan. Only addresses on your local network are accepted (private, link-local, Tailscale, and the
Ledger machine itself).

- **Find scanners finds nothing:** the Ledger server must be on the scanner's network; in a
  container it may need host networking. Enter the address instead.
- **USB scanners:** a web page can't reach USB, so the computer the scanner is plugged into (your
  PC, or the Ledger server itself) runs the **scan bridge**, which shares it as an AirScan scanner;
  then it scans from the Scan tab on any device. Download it on the Scan tab (*Scanner plugged into a
  computer by USB?*):
  - **Windows:** `ledger-scan-bridge.ps1` uses Windows' own scanner support (WIA), nothing to
    install. Run it once as Administrator (`powershell -ExecutionPolicy Bypass -File
    .\ledger-scan-bridge.ps1` in *Terminal (Admin)*): it reserves port 8090 and opens it in the
    firewall for private networks (if Windows calls your network *Public*, make it *Private*).
  - **Mac and Linux:** `ledger-scan-bridge.py` uses SANE (`brew install sane-backends`, or
    `sudo apt install sane-utils`; version 1.0.28 or newer): `python3 ledger-scan-bridge.py`.
  - It prints the address to enter as the scanner (e.g. `http://192.168.1.25:8090/eSCL`; on the
    Ledger server itself `http://127.0.0.1:8090/eSCL`). Only computers on your local network can
    use it; `-Allow` / `--allow <Ledger server's address>` narrows that. Leave it running.

  Or scan with the scanner's own app and **Upload files**, or use
  [AirSane](https://github.com/SimulPiscator/AirSane), which does the same as the bridge on Linux.
- A scan runs on the server in the background (a feeder of pages takes a while) and becomes a PDF
  with one page per sheet, filed in Documents and listed in the inbox; it must fit the *Largest
  file* setting.

## The phone app (Android)

**Ledger Import** is a small Android app for receipts, in `android/` of this
repository (it came with the Import module and keeps its name). Each release
of the module carries it as `ledger-import.apk`; the Scan tab has the
download link.

- **Scan:** the camera finds the receipt's edges by itself, takes the
  picture, straightens it and makes a PDF (several pages if you like). This
  is Google's document scanner, so the phone needs Google Play services.
- **Account and note:** choose the account the receipt belongs under (the
  list comes from Ledger and is kept on the phone) and add a note, typed or
  spoken. Speech is turned into text by the phone's own speech-to-text;
  nothing is sent to an AI service.
- **Organization:** with more than one organization on the server, Settings
  has *Send receipts to this organization*: the one receipts go to unless
  you choose another for a receipt. Each organization has its own accounts
  and its own inbox.
- **Sending:** the receipt goes to Auto sort's inbox, marked "phone app",
  with the account and the note; made a receipt there, it gets that account. With no connection, or away from the server, it
  stays on the phone and is sent by itself when the server can next be
  reached (or with **Send now**; sending by itself can be turned off).
- **Only on your Wi-Fi:** under Settings, *Only on this Wi-Fi* takes the name
  of the Wi-Fi your server is on (*Use the Wi-Fi this phone is on* fills it
  in). Receipts are then sent by themselves only while the phone is on that
  Wi-Fi, a few minutes after it joins at the latest; **Send now** still
  sends from anywhere. Android gives a Wi-Fi's name only to apps with the
  location permission and with Location turned on, and while the app is
  closed only when location is allowed "all the time" (the app offers
  both; it never reads where the phone is). When Android won't give the
  name, the app tries on whatever Wi-Fi the phone is on, never on mobile
  data.
- **Changing a receipt:** tap a receipt that still waits on the phone to
  change its account, note, name or organization, or to delete it. Once
  sent, change it in Ledger.
- **Setting up:** the server's address, your Ledger username and password.
  The password is kept encrypted on the phone and used to log in again when
  the session runs out. The app needs to reach the server: the same network,
  or a VPN such as Tailscale.
- **Updates:** the app checks this repository's releases
  (`mastifdogo/auto-sort_module`) once a day and when opened, and installs
  a newer version. Android asks once to allow it; from Android 12 later
  updates install without asking. The app has its own version number
  (0.22.0 now), apart from the module's.
- **Coming from the Import module's app (0.21.1 or older):** that app sends
  to the Import module and looks for updates in its repository. Install
  0.22.0 or newer over it (same app, same signing key; nothing on the phone
  is lost): download it from the Scan tab.

**Signing key.** Android only installs an update signed with the same key
as the app it replaces, so releases are signed with one key kept in this
repository's secrets (Settings → Secrets and variables → Actions):
`APP_KEYSTORE_BASE64` (the keystore file, base64) and
`APP_KEYSTORE_PASSWORD`. Keep a copy of the keystore and its password
somewhere safe: if they are lost, phones must uninstall the app and install
it again. This repository must hold the same key the Import module's
repository had, or the app from here can't be installed over the one from
there. Without the secrets a release is published without the app; add
them and run the Release workflow by hand to attach it.

## Files, tags and reading a file once

**The module keeps no files.** Every file it receives or handles, of any type (PDFs and scans, CSV,
OFX and QFX statements, saved emails), is one of **Ledger's Documents** (in the sidebar), the one
file store Ledger and every module share (Ledger 0.27.0). The module's tables hold only the
document's number. You can open, rename, search and tag the files there, and backups carry them.

- A statement is filed under its bank or card account once that is known; a bill as an invoice and
  a receipt as a receipt, with the vendor and date once you approve it.
- A file Ledger already has is used as it is, never stored twice: uploading the same file again
  gives the same document.
- Deleting a bill or a statement removes the document only if this module filed it and nothing
  else here uses it. Deleting an inbox file removes its document whoever filed it, unless it was
  sent on or is used here (0.17.1).

**Tags on files.** Ledger has one tag system for files, shared by every module, and Auto sort keeps
it in line with its own records:

| Tag | On | When |
|---|---|---|
| `posted` | a bill's or receipt's document | it is in the books; the note names the entry ("entry 12", or "entry 12, paid by entry 15") |
| `paid` | a bill's or receipt's document | the bill is paid |
| `overdue` | a bill's document | it is approved and past its due date (checked hourly) |
| `posted` | a statement's document | every one of its lines is dealt with and at least one is posted ("34 entries") |
| `extracted` | any document | set by Ledger while what was read out of the file is kept with it |

A tag belongs to the file, not to who set it. If you (on the Documents page) or another module tag
a bill's document **paid**, the bill becomes paid here too, without anything being posted; take
the tag off and it is unpaid again, unless its payment is in the journal (then the tag goes back).
**posted** taken off a file that is in the books is put back. Tags this module didn't set are
otherwise left alone. The same holds for the tags on journal entries (see [Bills](#bills)); the two
are kept consistent.

**A file is read once.** What is read out of a file is kept with the document in Ledger, for every
module, and Auto sort looks there before parsing a file or sending it to the AI:

- What a parser reads (CSV, OFX, QFX) is saved straight away: the transactions, the period, an
  OFX file's closing balance. Staging the same file again, here or in another module, uses that.
- What the **AI** reads is only a suggestion, and is saved with the document only once you approve
  it: the rows of **Extract data** when you press Approve, a bill's or receipt's details (vendor,
  number, dates, total, line items) when you approve the bill, a PDF statement another module sent
  when you post from it.
- A bill or receipt whose details are already with the document (approved here before, or read by
  another module) is made from them: the AI isn't asked. So is **Create bill** from a statement
  whose document says what is owed.

The data uses the keys Ledger's modules share (`type`, `vendor`, `number`, `date`, `due_date`,
`currency`, `total_cents`, `items`, `period`, `closing_balance_cents`, `transactions`), with money
in integer cents and money out negative. What only Auto sort needs (the parser's format, each
line's bank id and memo, whether the file's signs were flipped) is under `categorizer`.

## Coming from the Import module

The Import module (`mastifdogo/download_module`, id `downloads`) is merged into Auto sort. Its last
version only hands its data over; everything it did is done here.

1. **Update Import** to its last version first (Settings → Modules). It moves every file it holds
   into Ledger's Documents.
2. **Update Auto sort** to 0.17.0 or newer.
3. On Auto sort's **Inbox** tab a notice says what waits (there is also a to-do on the dashboard).
   An **admin** presses **Take it over**. This is asked because it moves your data from one module
   to another; nothing happens before.
4. Then remove the Import module, replace the browser extension, and update the phone app.

What is taken over, per organization: the inbox entries (each with its document, status, where it
came from, the email it came from, where it was sent), what the AI read (and what you approved
there is saved with the original document), the email check's log of messages already looked at,
what it learned, its last-run state, and Import's settings. **Rows only:** no file is copied or
moved, and nothing in Import's own tables is changed or deleted.

- **Safe to do again.** Every row remembers the one it came from, so nothing is taken twice.
  Settings are copied the first time only.
- **Files not in Documents yet** (Import wasn't updated, or a file was lost) are counted and
  reported, not taken; update Import and press the button again.
- **Email isn't read here until then**, so the mail Import already looked at isn't imported a
  second time. An admin who doesn't want Import's data chooses **Don't take it over**.
- Allow **Auto sort** to read mail under Settings → Mail (the permission is per module), and turn
  Import's own email off if it is still running.

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
shrunk in the browser first. Pictures go to Ledger's LLM connection for images (Settings → LLM
API), which can be a different model than
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

- **Statements and transaction lists** (CSV, OFX, QFX, QBO, or a PDF when the LLM connection reads PDFs) are staged on
  the Statements tab. Put the account in `meta.account_code` (and optionally `meta.flip_signs`,
  `meta.date_order`); without it the statement waits for you to choose, and your choice is
  remembered for that module and account number. What the statement says is owed can come along in
  `meta.amount_due`, `due_date`, `statement_date`, `minimum_payment`, `reference`, `vendor` and
  `currency`, so **Create bill** needs no LLM.
- **Bills and receipts** (a PDF, a picture or a saved `.eml`) go to the Bills or Receipts tab; the
  sender's label decides which.
- A file handed over is a document in Ledger (`summary.document_id`, Ledger 0.27.0): Auto sort
  keeps that id, never a copy, and uses what was already read out of the document instead of
  parsing it or asking the AI again.
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

**Auto sort on a bill or receipt: a search, no AI (0.19.0).** **Auto sort** searches the journal,
and the statement lines not posted yet, for transactions like the bill or receipt and lists them
under **Similar transactions**, best first (the exact amount, the vendor's name in the description,
the nearest date). It starts from the bill's exact amount and the dates around it (a receipt: 5
days before to 15 after; a bill: 10 days before to 60 after its due date). Change what it looks for
and press **Search** again:

- **Amount from / to:** a range, for a payment with a fee, a tip or a discount;
- **Dated from / to:** up to 800 days;
- **In accounts:** only entries with a line on one of the chosen accounts (none chosen: all).

Entries that are reversed, or already linked to another record of this module, are left out; a
result with another amount than the bill's is marked. **Link** counts the bill as recorded by that
journal entry; **Match** makes a statement line its payment. Nothing is sent to the AI and nothing
changes until you choose one.

**Splitting a payment, skipping duplicates, numbers on the tabs (0.20.0).**

- **Split a payment:** when a statement line you match to a bill or receipt is larger than it (one
  card payment for a receipt and something else), you're offered a split: the bill's amount pays
  it, and the rest goes to an account you choose (with a note). Posting the line books both parts
  in one entry. The bill's view also lists larger unposted payments dated near it, with
  **Split and match…**. A smaller line can still be matched as a partial payment, after a question.
- **Skip on the Duplicates tab:** **Skip** hides an entry for now without marking it "not
  duplicates". **Skipped** lists what was skipped, by whom and when; **Unskip** brings it back.
- **Similar entries before sending from the Inbox:** making an inbox file a bill or receipt, or a
  statement, first looks for what's already here. Bills and receipts: the same one, or one with the
  same amount within 14 days, or the same vendor with an amount within 5% (or the same invoice
  number). Statements: lines uploaded before, or with the same date and amount on that account.
  They are shown side by side with the file, and you choose: **It's this one** (nothing is added;
  the file is marked as that bill, receipt or statement), **Add it** / **Stage it** anyway, or
  Cancel. What the AI read is kept meanwhile, so adding it doesn't ask the AI again. The browser
  extension and the phone app send as before, without asking.
- **Numbers on the tabs:** an amber number (styled like the "Choose account" pills, since 0.20.1) on Statements (lines needing review, statements
  waiting for their account), Bills and Receipts (ones to review), Duplicates and Inbox; a red
  number on Bills for unpaid bills past their due date.

**Auto sort on a statement (LLM).** On an open statement, **Auto sort** looks wider and lets the
LLM judge:

- For each unposted statement line, candidates with the same amount within 10 days: journal entries
  on its account, lines on other statements (the same payment uploaded twice, or the other side of
  a transfer: opposite amount on another account), and open bills and receipts it could pay.

Ledger's LLM API picks the candidate that is the same transaction, or none, by payee names, dates
and references. Each pick shows under the line or in the bill's view as **Auto sort: same as …
· 88% · reason [Approve] [Reject]**. Approve carries it out: a line already in the journal is
linked to that entry and not posted; a duplicate line is merged into the other; two sides of a
transfer are linked and posted once; a payment is matched to its bill. Rejected matches aren't suggested again. Nothing changes before you
approve, and a to-do on Ledger's dashboard counts the matches waiting.

## Bills

Bills and receipts come from the Bills and Receipts tabs (a PDF, a photo or a saved email, `.eml`), from other
modules (Ledger's file exchange), or by hand. Ledger's LLM API reads the vendor, invoice number,
dates, amount and a suggested account (PDFs need a connection for images that reads PDFs; photos any
connection for images). Repeats of a bill that's already listed (same vendor and invoice number, or
same amount and due date) are refused.

**Sort now** (Statements tab) matches bills and receipts, and transfers between your accounts, to the
statement transactions waiting to be posted, looks for bills and receipts already in the journal,
and says what it found.

**A bill from a statement:** on a card or loan statement, **Create bill** fills in what the
statement says is owed: the new balance, due date, statement date, minimum payment and reference.
When that is already known, the LLM isn't asked: a PDF statement's balance is read in the same call
that lists its transactions, an OFX/QFX file's ledger balance counts for a card or loan account, a
module that sends a statement can say it in the file's meta (`amount_due`, `due_date`,
`statement_date`, `minimum_payment`, `reference`, `vendor`, `currency`), and an earlier Create bill
reading is kept. Otherwise Ledger's LLM API reads the statement file (a PDF needs a connection that
reads PDFs); **Read again with the LLM** asks it anyway. It never adds up the transactions itself.
You check the form, then **Create bill**; one bill per statement. Its account is the card or loan
account, so paying it pays down the card. Statements uploaded before 0.7.0 have no file kept; the
LLM then only sees the transactions, so type the amount.

**Customers and vendors** (Ledger 0.16.0): a bill's vendor and customer are linked to Ledger's own
list of customers and vendors (**Entities** in Ledger's sidebar), shared with every module, and the
fields offer the names on it. A vendor or customer you type, save, approve or import is added to
the list (or given the role) if it isn't there; a vendor the AI read from a document is only linked
when it's already on the list, and added when you approve the bill. Entries Auto sort posts for a
bill (into payables, and its payment) record the vendor.

**Billable:** a bill or receipt can be marked **Billable to the customer** with a **Customer**. The
list shows them as *billable · Acme Corp*.

**A category per line item (0.18.0):** each line item has its own **category** (account) picker,
next to its amount. Leave it at *Same as the bill* and the item goes with the rest; choose an
account and that item's amount is booked there. Items without their own category, and whatever the
items don't cover (tax, a tip), go to the bill's own **Account**, which still categorizes the whole
bill or receipt in one go when no item is given its own. The result shows as **Booked by item** and
is what the journal entry gets: one line per categorized item and one for the rest. The categorized
items can't add up to more than the total, and the categories are fixed once the bill or its
payment is posted (undo the approval to change them). A split made by hand (below) replaces them.

**Line items:** when a bill or receipt is scanned (PDF, photo or email), the LLM also lists its
individual line items: item, quantity, unit, price per unit and line total. They show under
**Line items** on the bill, where you can edit, add or remove them (**Read items with the LLM** for
bills scanned before 0.16.0). Tick **Billable** on the items you'll bill a customer for: each
billable item is put on the bill's journal entry as one of Ledger's rate items (item, quantity,
rate; Ledger 0.25.0), so an invoice can fill itself in from it. That entry is the payables entry
made on approval, else the entry its payment or receipt is recorded in; until there is one, the
items wait. Unticking or removing an item, undoing the approval or ignoring the bill takes its rate
item off; changing or removing the rate item in Ledger updates or unticks the line item here.

**Split:** a receipt (or bill) for things booked to different accounts, e.g. groceries and
household supplies: **Split into lines…**, then **Suggest lines with the LLM** reads the document's
line items (the PDF or photo through the connection for images, or the email text) and proposes
lines with accounts. Edit them; they must add up to the total; **Save split**. When its payment is
posted, the entry books each line to its account (a bill posted to payables books the lines on
approval). A split can change until it's posted.

**Tags** (Ledger 0.23.0): Ledger keeps tags on journal entries that every module reads the same
way. Auto sort keeps them true on a bill's entry (the payables entry made on approval; without a
payables account, the entry its payment is recorded in):
- **vendor**: who the bill is from, set on approval.
- **paid**: when its payment is posted, when it's linked to an entry that records it, or on
  **Mark paid**; taken off on **Reopen**.
- **overdue**: an approved, unpaid bill past its due date (checked hourly and whenever bills
  change); taken off when it's paid or no longer due.
- **Undo approval** takes paid and overdue off the reversed entry.

The tags belong to the entry, so anyone can change them in Ledger, and the bill follows: tag a
bill's entry **paid** (a person, or another module that paid it) and the bill becomes
*Paid (tagged in Ledger)* here, with nothing posted and its statement match dropped; take the tag
off and it is unpaid again. If the bill's payment is in the journal, it stays paid and the tag is
put back. A vendor tagged on the entry of a bill that has none fills in the bill's vendor.

**Paying what other modules posted:** entries another module tagged **billed** or **overdue**
(e.g. a Sales invoice) or with a **vendor**, and not **paid**, are what a statement deposit or
payment may pay. A row with exactly such an entry's amount is offered it (*Pays entry #12*; the
customer's or vendor's name in the description raises the confidence; without the name it's only
offered when nothing else has that amount) and gets the entry's receivable or payable account.
**Not this one** drops the offer. Posting the row, which only a person does, tags that entry
**paid** and the new entry with the customer or vendor. No AI is involved.

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
| `POST` | `/statements` | `{filename, content, account_code, flip_signs?, date_order?: "auto"\|"mdy"\|"dmy"}` files the text as a document, stages the statement and starts categorising it (up to about 1 MB; larger files go through `/inbox`) |
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
| `POST` | `/transactions/:id/not-paying` | the row doesn't pay the tagged entry it was offered (not offered again) |
| `GET` | `/duplicates` | likely duplicates: `{pairs: [{keep, merge, score}], entries: [{merge, entry, score}], count}` |
| `POST` | `/duplicates/merge` | `{merge_id, keep_id}` or `{merge_id, entry_id}`: the merged row is never posted |
| `POST` | `/duplicates/dismiss` | `{tx_id, other_id}` or `{tx_id, entry_id}`: not duplicates |
| `POST` | `/transactions/:id/unmerge` | a merged row back to review |
| `POST` | `/accounts` | `{code, name, type, currency?, description?, transaction_ids?, proposal?}`: create an account in Ledger and book those rows (or every row the AI proposed it for) to it |
| `GET` | `/files?limit=` | files other modules sent, with what each became; `POST /files/:id/approve`, `/reject`, `/retry`, `DELETE /files/:id` |
| `POST` | `/inbox` | `{name, content_type, size, source_url?, origin?: "camera"\|"upload"\|"app", note?, account_code?, device?}` starts an upload: `{id, chunk_size, chunks}` |
| `PUT` | `/inbox/:id/chunks/:index` | `{data: base64}`, one piece (each `chunk_size` bytes but the last) |
| `POST` | `/inbox/:id/complete` | puts the pieces together and files the file in Documents: the inbox entry |
| `GET` | `/inbox?status=new\|sent\|archived\|all`, `/inbox/:id` | the inbox, with each file's document (kind, account, tags, whether its data was read) |
| `POST` | `/inbox/:id/statement` | `{account_code, flip_signs?, date_order?}`: stage it as a statement |
| `POST` | `/inbox/:id/bill` | `{kind?: "bill"\|"receipt"}`: read it as a bill or receipt (what was read before is used) |
| `POST` | `/inbox/:id/extract` | `{instructions?, reread?}`: the AI reads its transactions; a pending suggestion |
| `GET` | `/extractions?status=`, `/extractions/:id` | what the AI read, to review |
| `POST` | `/extractions/:id/approve`, `/reject` | `{rows?}`: approve (saved with the document) or turn down |
| `GET` | `/inbox/:id/transactions` | the transactions kept with the file, as rows `{date, description, amount, balance}` |
| `POST` | `/inbox/:id/file-as` | `{kind: "receipt"\|"statement"\|"invoice"\|"other", account_code?}`: say what it is in Documents |
| `POST` | `/inbox/:id/handoff` | `{to, kind, account_code?, note?}`: hand it to another module; `GET /targets` lists them |
| `POST` | `/inbox/:id/sent` | `{to, link?}`: the page sent it somewhere itself (Ledger's CSV files) |
| `PATCH`/`DELETE` | `/inbox/:id` | `{status?: "new"\|"archived", note?, name?}`; delete (`?learn=1` also teaches the email check) |
| `GET` | `/inbox/:id/email`, `/inbox/:id/email/attachment?attachment=` | the email a file is or came from |
| `GET`/`POST` | `/mail`, `/mail/check` | the email check's state; check now |
| `GET`/`POST` | `/mail/range` | import a date range `{from, to}`, in the background; its progress |
| `GET`/`POST` | `/mail/message?id=&folder=`, `/mail/message/attachment`, `/mail/message/import` | look at one email, then import what is ticked |
| `GET`/`POST` | `/mail/skipped`, `/mail/skipped/import` | emails the check skipped from what it learned; import one anyway |
| `GET`/`POST`/`DELETE` | `/training`, `/training/file`, `/training/forget`, `/training/:id` | what the email check learned; the training file |
| `GET`/`POST` | `/scanner`, `/scanner/find`, `/scans`, `/scans/:id` | the network scanner (admins set it up); start a scan and follow it |
| `GET`/`POST` | `/adoption`, `/adoption/dismiss` | the Import module's data: what waits; `POST /adoption {confirm: true}` takes it over (admins) |
| `GET` | `/app`, `/me`, `/ai` | the phone app's download address; who is asking; whether the AI can read text, pictures and PDFs |
| `POST` | `/documents/move` | file what is still in the module's old storage in Documents now |
| `POST` | `/suggest` | `{account_code, transactions: [{date, description, amount, memo?}]}` returns suggestions without storing anything (for scripts or other modules) |
| `GET`/`DELETE` | `/rules`, `/rules/:key` | learned payee rules |
| `GET` | `/status` | Ledger's LLM API status for this module, the options in effect, the user's role, the organization |
| `POST` | `/sort-now` | match bills and transfers, count bills already in the journal; returns `{bill_matches, transfer_links, journal_matches, tag_matches}` (rows matched to entries tagged as owed) |
| `GET` | `/journal-matches?bill_id=` | open bills and receipts already in the journal (no AI) |
| `GET` | `/match-suggestions?statement_id=\|bill_id=` | Auto sort's pending matches, with what they point to |
| `POST` | `/match-suggestions/:id/approve`, `/reject` | carry a match out, or turn it down |
| `GET`/`POST` | `/bills?status=unpaid\|new\|open\|paid\|ignored&kind=bill\|receipt`, `/bills` | list; add by hand `{vendor, amount, due_date, ...}` |
| `POST` | `/bills/upload` | `{filename, content_base64}`: a PDF, a picture or an `.eml` (up to about 700 KB; larger files go through `/inbox`) |
| `GET`/`PATCH`/`DELETE` | `/bills/:id` | one bill with its payment and lines; edit fields (incl. `billable`, `customer_name`, `customer_ref`) or `status`; delete |
| `GET` | `/bills/:id/document` | the bill's document, base64 (it also opens at `document_url`, in Ledger's Documents) |
| `POST` | `/bills/:id/approve`, `/unapprove` | approve (posts to payables if configured); undo (reverses that entry) |
| `GET`/`POST` | `/bills/:id/candidates`, `/match {transaction_id}`, `/unmatch` | manual matching |
| `POST` | `/statements/:id/bill-draft` | `{reread?}`: what the statement says is owed (nothing saved), from what was already read, else read by the LLM; create it with `POST /bills {..., statement_id}` |
| `POST` | `/bills/:id/split-draft` | proposed split lines, read by the LLM (nothing saved) |
| `PUT` | `/bills/:id/items` | `{items: [{id?, description, quantity?, unit?, rate?, amount?, billable?}]}`: the line items (billable ones become rate items on the bill's entry) |
| `POST` | `/bills/:id/items-draft` | line items read by the LLM (nothing saved) |
| `PUT`/`DELETE` | `/bills/:id/lines` | `{lines: [{description, amount, account_code}]}`: save a split (adds up to the amount); remove it |
| `GET` | `/customers` | customer names used on bills |
| `GET` | `/duplicates?period=week\|month\|year\|all` | recheck a period, posted rows included (`both_posted` pairs) |
| `POST` | `/duplicates/reverse {merge_id, keep_id}` | reverse the entry of a posted copy |
| `POST` | `/bills/:id/link-entry {entry_id}`, `/unlink-entry` | it's already in the journal: count it paid by that entry, or undo |
| `POST` | `/bills/:id/auto-sort` | Auto sort for a bill or receipt |

Options are Ledger's module settings (`GET`/`PUT /api/v1/modules/categorizer/settings`, admins
only). Viewers can look but not change anything; Ledger enforces that. Ledger's search bar finds
bills, statements, transactions and inbox files; the links open them on the module's page.

## Changes made in Ledger

- **Renumbered accounts** (Ledger 0.19.3): when someone changes an account's code, every account
  Auto sort remembers follows: statements, transactions (suggested and chosen accounts, proposed
  new accounts), bills, split lines, payee rules and the payable account setting.
- **Changed entries** (Ledger 0.19.5): a person can correct the amounts of an entry Auto sort
  posted. The statement row, bill or payment then shows **Changed in Ledger** with the entry's
  amount now, next to Auto sort's own; neither is overwritten.
- **Changed dates and moved lines** (Ledger 0.20.2): an entry's date changed in Ledger shows
  **Dated … in Ledger** beside the row's own date; a bank line a reconciliation moved to Ledger's
  Unreconciled account shows as **Changed in Ledger**.
- **Hidden accounts** (Ledger 0.20.1): clearing accounts and other hidden accounts aren't offered in
  Auto sort's pickers or to the AI, and can't be chosen for a row, bill or statement. Nothing is
  ever posted to Ledger's Unreconciled account.
- **Reconciled statements** (Ledger 0.19.4): a statement filed in Documents shows **Reconciled in
  Ledger** once an account has been reconciled against it.

## Root mode

When an admin turns on Ledger's root mode (Ledger 0.21.1), Auto sort shows red **Root:** buttons:
delete a statement with all its rows (posted ones too), delete a bill or receipt even when approved
or paid, mark a posted row not posted, or take a bill out of its journal entry. Journal entries
and documents are never touched by these. Every change goes through Ledger, so it's in Settings →
Root log and can be put back. Before root mode can be left, Auto sort lists rows and bills that
point at a journal entry that no longer exists.

## Backups and files

Files are in Ledger's Documents (see [Files, tags and reading a file once](#files-tags-and-reading-a-file-once)),
which Ledger's backups carry; the module has no files of its own to back up. After a restore from
a dump file, which brings back only the tables, a row can point at a file that isn't there: the
inbox says so (**The file itself is missing**) and the row can be deleted; a bill or statement
simply has no file to show.

Since Ledger 0.13.0 each backup also saves Auto sort's tables as CSV files you can open in a
spreadsheet: `statements` and `transactions` (what was uploaded and how each line was categorised
and posted), `bills` and `bill_lines`, `rules` (learned payee rules), `statement_sources` (which
account a sender's statements go to), `received_files`, `match_suggestions` and `not_duplicates`.
`bill_documents` and `statement_files` say which document a bill's or statement's file is (its
name, type, size and date). `inbox_files` is the inbox, `inbox_extractions` what the AI read from
files, `mail_seen` the email check's log, `mail_training` what it learned, and `module_state` its
last run and the record of the hand-over from Import. No file bytes and no secrets are kept in any
table.

## Import from CSV

**Settings → Modules → Auto sort → Import from CSV** (Ledger 0.13.2) brings in open bills and
receipts from other bookkeeping software: vendor, amount, due date, bill date, invoice number,
account (code or name), type (bill or receipt), currency, customer and billable. Ledger matches the
file's columns (by name, or with the AI) and shows a preview; Auto sort's check lists rows it can't
take (an unknown account, a type that isn't bill or receipt). Bills already here (the same row
again, or the same vendor and invoice number, or amount and dates) are skipped, so importing a file
twice adds nothing. Imported bills arrive on the Bills and Receipts tabs as **Needs review**; nothing
is posted until you approve them.

## Privacy

With a hosted LLM provider as Ledger's connection, each transaction's date, description, memo and
amount, your account codes, names and descriptions, and descriptions of recent entries on the
statement account are sent to that provider, and so are the bills, receipts and photos you upload. Auto sort sends a
line's or bill's date, description and amount with its candidates (dates, descriptions, amounts and
account codes of matching entries, lines and bills). With a model on your own network,
nothing leaves it. **Extract data** sends the file you chose. The email check and the scanner use
no AI. Files are kept in Ledger's Documents, on your server. The network scanner is reached from
the Ledger server and only at addresses on your local network. The browser extension and the phone
app talk to your Ledger only. Ledger logs each AI call (tokens, not content) under
Settings → LLM API.

## Notes on Ledger's module guidelines

- **No dependencies:** only Node built-ins. `server.mjs` imports its own files from `lib/`, which
  install with the release archive.
- **AI** goes through `ctx.llm` and mail through `ctx.mail`; the module has no key or password of
  its own. Its only outbound calls are to the network scanner you set up (local addresses only).
- **Files** go in `ctx.documents`, all of them; nothing is put in module storage, in tables or on
  disk (an upload's pieces wait in temporary files under the system's temporary folder and are
  deleted once it is filed).
- **AI only proposes:** see [The AI only suggests](#the-ai-only-suggests).
- **Secrets:** none.
- **Layout:** the page works from about 260 px wide (Ledger's side-by-side panes) up to full
  width, in light and dark mode.

## Layout

```
ledger-module.json     manifest
server.mjs             statements: routes, background categorisation, posting; wires the rest
lib/files.mjs          every file is a document in Ledger; moving what old versions kept in storage
lib/extraction.mjs     what was read from a file, in the keys Ledger's modules share (read once)
lib/doc-tags.mjs       Ledger's tags on files: posted, paid, overdue
lib/tags.mjs           Ledger's tags on journal entries
lib/inbox.mjs          the inbox: uploads, what a file becomes, Extract data, hand-offs, clean-up
lib/uploads.mjs        an upload's pieces in temporary files until it is complete
lib/extract-data.mjs   Extract data: the prompt and the checks on what the AI read
lib/mail.mjs           the email check, date ranges, viewing an email
lib/learn.mjs          what the email check learns (word statistics, no AI)
lib/eml.mjs            reading a saved email for the viewer
lib/scanner-routes.mjs the network scanner's routes
lib/escl.mjs           the eSCL (AirScan) client and scanner discovery
lib/pdf.mjs            JPEG pages into a PDF
lib/adopt.mjs          the hand-over of the Import module's data
lib/parse.mjs          CSV / OFX parsing, amounts, dates, payee keys
lib/categorize.mjs     prompt, schema, rules, batching
lib/bill-routes.mjs    bill routes, reading uploads and files, matching bills to transactions, linking to entries
lib/bills.mjs          bill extraction prompt, picture types, duplicates, match scoring
lib/email-statements.mjs  statements from other modules: account hints, PDF statements, card signs
lib/mime.mjs           email (MIME) parser for bills sent as .eml files
lib/matching.mjs       journal and Auto sort candidates, the AI's match prompt
lib/journal-matches.mjs  bills in the journal, the Auto sort routes, approving matches
lib/dashboard.mjs      notifications and to-dos on Ledger's dashboard
lib/transfers.mjs      transfer scoring and pairing
lib/transfer-sync.mjs  linking transfer rows (and existing journal entries), the unlink route
lib/duplicates.mjs     duplicate scoring and pairing
lib/duplicate-routes.mjs  the Duplicates tab's routes and dashboard to-do
lib/received-files.mjs files from other modules (ctx.files)
lib/root-routes.mjs    root mode
lib/ledger-sync.mjs    renumbered accounts, entries changed in Ledger
ui/index.html          the page shown in Ledger
ui/inbox.js, scan.js   the Inbox and Scan tabs
ui/mail-view.js        the email viewer
ui/receipt.js          finding and straightening a receipt in a photo
ui/mail-range.html     Settings → Auto sort → Email: import a date range
ui/extension/          the Send to Ledger browser extension
ui/scan-bridge/        small programs that share a USB scanner on the network
android/               the phone app (Kotlin)
migrations/            the module's tables (schema mod_categorizer)
test/                  tests: npm test (Node 22+)
```

Ledger installs modules without a build step or `npm install`, so the module has no dependencies.


## Development

Use the `ledger-module` skill in `.claude/skills/`: it checks the module against a real Ledger
(`sh .claude/skills/ledger-module/scripts/check.sh` with `TEST_DATABASE_URL` set) and links to
Ledger's module docs. `npm test` runs the tests (Node 22+). The tests of the hand-over from Import
and of the migrations run against a real PostgreSQL (`TEST_DATABASE_URL`, default the local one)
with the `pg` driver of a Ledger checkout beside this repository; without either they are
skipped. To try the module without spending API credit, point Ledger's AI (Settings → LLM API,
Server URL) at a local stub server.

**Releasing:** bump `version` in `ledger-module.json` and merge to `main`. The Release workflow
(`.github/workflows/release.yml`) then tags `v<version>` and publishes the GitHub Release that
Ledger installs; it does nothing for a version that's already released. To release the current
version without a change, run it from Actions → Release → Run workflow. If it fails with "Resource
not accessible by integration", allow it under Settings → Actions → General → Workflow permissions
→ "Read and write permissions".

**The phone app** is built, signed and attached to every release as `ledger-import.apk` by the same
workflow, when the repository has the signing key in its secrets (`APP_KEYSTORE_BASE64`,
`APP_KEYSTORE_PASSWORD`). It must be the key the Import module's repository used: Android only
installs an update signed like the app it replaces. The app has its own version, `appVersion` in
`android/gradle.properties` (0.22.0, above the last app released from the Import module); raise it
whenever the app changes. The workflow writes it in the label of the release's app file, where the
app's updater reads it. `.github/workflows/app.yml` builds the app unsigned on every change to
`android/`, to check that it compiles.

**The browser extension** has its own version in `ui/extension/manifest.json` (0.6.0); it ships
inside the module and is downloaded from the Inbox tab.

## Changes

- **0.17.0:** **The Import module is merged in.** The **Inbox** and **Scan** tabs, the Send to
  Ledger browser extension (0.6.0), the email check with what it learns, the network scanner, the
  phone camera and the Android app (0.22.0), **Extract data**, sending files on to other modules,
  Ledger's Documents and Ledger's CSV files are part of Auto sort; an inbox file becomes a
  statement, a bill or a receipt directly. Import's data is taken over when an admin presses
  **Take it over** on the Inbox tab. **The module keeps no files of its own** (Ledger 0.27.0):
  every file of any type is one of Ledger's Documents and tables keep its number; files older
  versions kept in module storage move there when Ledger starts. **Tags on files:** a bill's
  document is posted, paid or overdue as the bill is, a statement's document posted when all its
  lines are; tags a person or another module sets are followed. **A file is read once:** what the
  parsers read, and what the AI read once you approved it, is kept with the document for every
  module and used instead of reading again; **Create bill** and re-reading a bill go by it.
  Uploads of any size go in pieces. Settings have five tabs. Needs Ledger 0.27.0. Migrations 020
  (drops the columns that once held file bytes) and 021 (the inbox's tables).

- **0.16.0:** **Create bill** from a statement uses what is already known about it without the
  LLM: a PDF statement's balance (now read in the same call as its transactions), an OFX/QFX
  ledger balance on a card or loan account, what the sending module put in the file's meta, or an
  earlier reading; **Read again with the LLM** asks anyway. Scanned bills and receipts get their
  **line items** (item, quantity, unit, rate, amount); items ticked **Billable** are put on the
  bill's journal entry as Ledger's rate items (Ledger 0.25.0; on an older Ledger they're only kept
  here). Migration 019.

- **0.15.0:** Ledger's shared tags on journal entries (Ledger 0.23.0; on an older Ledger the module
  works as before, without tags). A bill's entry is tagged with its vendor, **paid** and
  **overdue**, kept true as the bill changes, and bills approved earlier get their tags once at
  startup. A bill whose entry is tagged paid in Ledger (by a person or another module) is paid here
  too, with nothing posted: *Paid (tagged in Ledger)*; taking the tag off reopens it. Statement
  rows are offered the entries other modules tagged as owed (billed, overdue, a vendor's) that
  they pay; posting such a row tags that entry paid. Migration 018.

- **0.14.0:** Needs Ledger 0.21.1. Root mode (delete or change any statement, row or bill through
  Ledger's root log, and a check before leaving it); hidden and clearing accounts left out of
  pickers and AI suggestions; changed entry dates and lines moved to Unreconciled shown on posted
  rows. Migration 017 (an id column on four tables, for root mode).

- **0.13.1:** Fixes, no new features and no migration.
  - A statement line was posted twice if something failed right after its entry was made (the
    line went back to "not posted" although the entry was in the journal). It now stays posted.
  - On a bill or receipt, **Save changes** (unless the vendor or customer changed), **Mark paid**,
    **Ignore** and **Reopen** saved but then showed "no such endpoint" and left the page stale;
    **Approve** stopped after saving an edit. They work now.
  - CSV statements: dates with the month written out as *June* or *July* ("5 June 2026") and
    amounts without a leading zero (".50") or with a typographic minus sign were skipped. They are
    read now.
  - The dashboard's "matches from Auto sort to review" to-do no longer counts matches whose
    statement line was posted, skipped or discarded.
  - Refused with a clear message: booking a line against its statement's own account, merging a
    line into a reversed journal entry, and matching a payment to a bill that is paid or ignored.

- **0.13.0:** Needs Ledger 0.19.8. The accounts payable account under Settings → Auto sort → Bills
  is chosen from a list of liability accounts instead of typed as a code.

- **0.12.0:** Needs Ledger 0.19.6. Settings → Auto sort has two tabs, Sorting (review threshold,
  batch size) and Bills (accounts payable account); the Status tab links to each. Settings keep
  their values.

- **0.11.0:** Needs Ledger 0.19.5. Follows renumbered accounts everywhere it keeps a code, shows
  when a person changed a posted entry's amounts in Ledger, and shows statements that have been
  reconciled. No migration.

- **0.10.0:** Needs Ledger 0.19.1. PDFs and scans of bills, receipts and statements are filed in
  Ledger's shared **Documents** instead of the module's own storage; older ones move when you press
  the button on the Status tab. Works with any LLM provider Ledger connects (no provider is named
  or assumed). Migration 016.

- **0.9.0:** Needs Ledger 0.16.0. Bills' vendors and customers are linked to Ledger's shared list
  of customers and vendors (entities), and entries for a bill record its vendor; AI-read vendors are
  added only when a person approves. Account pickers show sub-accounts under their parent, and
  bank and card pickers put accounts tagged chequing, savings or credit card first. A bill whose
  stored file is gone after a restore shows no document. Migration 015.

- **0.8.0:** Needs Ledger 0.13.2. Bill documents and statement files are kept in Ledger's storage
  for modules (carried by every backup) instead of the database; older ones move there after the
  update. **Import from CSV** for bills and receipts under Settings → Modules → Auto sort.
  Migration 014.

- **0.7.2:** `bill_documents` and `statement_files` keep each file's name, size and date in readable
  columns (Ledger 0.13.1 shows only the size of the file itself in backup CSVs). Migration 013.

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
  QFX, QBO attachments, or PDFs read by the AI) are staged for review and posted only with your
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
