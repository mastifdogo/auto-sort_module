# Send to Ledger: browser extension

Part of the [Auto sort module](../../README.md) for Ledger (until Auto sort 0.17.0 it belonged to
the Import module, which is merged into Auto sort). It sends files from your browser
straight to your Ledger server, without saving them to your computer first. Works in **Chrome**
(and Edge, Brave, other Chromium browsers) and **Firefox** 128 or newer.

- **Right-click a download link** on your bank's or a supplier's site and choose **Send to
  Ledger…**. The file is downloaded in that tab, with that site's login, and a small window asks
  where it goes.
- **A PDF open in the browser** (a statement shown in the PDF viewer, or inside the bank's page):
  click the toolbar button and **Send the PDF or file open in this tab**, or right-click the PDF
  and choose **Send this PDF to Ledger…** (inside a page: **Send this frame's file to Ledger…**).
  It's fetched in that tab with the site's login. Where the browser doesn't let extensions read its
  PDF viewer (Firefox's built-in one), download the PDF and drop it on the toolbar button.
- **Toolbar button:** drop a file you already have (or choose one).
- **No waiting around:** after *Send to Ledger…* the window opens at once while the file
  downloads. Choose where it goes (and the account) and press **Send** straight away, then close
  the window and carry on: the extension finishes the download and the sending in the background.
  A browser notification says how it went (click it to open the file in Ledger), and the toolbar
  button shows ✓ or !. If the choice turns out not to fit the file, it goes to the inbox
  instead; if Ledger can't be reached (not logged in, say), the file is kept so you can press Send
  again.
- **Destinations:**
  - **The inbox** (the default): any file, up to the module's size limit (25 MB unless
    changed). Files are sent in pieces, and Ledger keeps each one in its Documents.
  - **Statement** (CSV, OFX, QFX, QBO): staged for review with its bank or card account. A PDF
    statement goes to the inbox, where the AI reads its transactions and you check them.
  - **Bill** or **receipt** (PDF, photo, saved email): read, then waiting on the Bills or
    Receipts tab for you to approve.
  - **Only file it in Ledger's Documents**, any file: as a **receipt**, a **statement** (with
    its bank or card account) or an **invoice or bill**.
  - **Ledger's CSV files** for journal import.

  Whatever you choose, the file goes through the inbox first; if the next step fails, it is
  still there.

  It remembers where you last sent each kind of file.
- **Organization:** with more than one organization in Ledger, choose where files go in the
  extension's options (**Send files to**); the send window can pick another for one file.
  "Where Ledger is now" follows the organization you last chose in Ledger. Ledger keeps the
  organization on your login, not per request, so to send elsewhere the extension switches
  Ledger to that organization for the few seconds of sending and then back (also when sending
  fails). Ledger pages you have open are in that organization for those seconds. Organizations
  you can only view can't be chosen.

## Install

The easiest way is the **Get the browser extension** button on Auto sort's Inbox tab in Ledger,
which downloads this folder as a zip. Or take `ui/extension/` from this repository.

**Chrome, Edge, Brave**
1. Unzip it. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and
   choose the folder.
2. Click the extension's toolbar button. A copy downloaded from Ledger already knows
   that Ledger's address: press **Allow and continue** and accept the browser's question. (A copy
   taken from the repository asks for the address there, e.g. `http://192.168.1.50:8080`.) The
   options page (**Details → Extension options**) can change the address and has a **Test** button.
3. To update later, unzip the new download over the same folder and press **Reload** on the
   extensions page. From a new folder the browser treats it as a new extension, which has to be
   allowed again.

**Firefox**
- **To try it:** open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → choose
  `manifest.json`. It stays until Firefox restarts.
- **To keep it:** regular Firefox only installs signed add-ons. Sign it for yourself (free, not
  listed publicly): create an account on [addons.mozilla.org](https://addons.mozilla.org/developers/),
  then in this folder run `npx web-ext sign --channel unlisted --api-key … --api-secret …` and
  install the `.xpi`. (Developer Edition, Nightly and ESR can instead set
  `xpinstall.signatures.required` to `false` in `about:config` and install an unsigned zip.)
- Then open the add-on's **Options**, enter your Ledger address, **Save**, allow access, **Test**.

## How it signs in

It uses your normal Ledger login in the same browser and stores only Ledger's address, never a
password. Ledger accepts requests only from its own pages: its login cookie is `SameSite=Strict`,
and it refuses cross-site changes. So the extension makes each request *inside a Ledger tab*. It
uses an open one if there is one; otherwise it opens a hidden one and closes it again. Ledger's
protections stay on.

**Permissions:**
- **Your Ledger address only:** asked for when you press Save in the options.
- **activeTab:** to download the link you right-clicked, in that page.
- **scripting**, **tabs**, **contextMenus**, **storage**.

It collects no data.

## Limits

- **Links that won't download:** some banks build the export in the page (a `blob:` link) or need
  a form submission. *Send to Ledger…* then says it couldn't download the file. Save it normally
  and drop it on the toolbar button.
- **Sizes:** up to the inbox's limit (Settings → Auto sort → Inbox, 25 MB unless changed).
- **Coming from the Import module's extension (0.5.0 or older):** that one sends to the Import
  module, which is now part of Auto sort. Download this one from Auto sort's Inbox tab, unzip it over
  the same folder and press **Reload** on the extensions page.
