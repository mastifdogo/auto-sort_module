# Send to Ledger: browser extension

Send bank statements and bills from your browser straight to your Ledger server (the
[Auto sort module](../README.md)), without saving them to your computer first. Works in
**Chrome** (and Edge, Brave, other Chromium browsers) and **Firefox** (128 or newer).

- **Right-click a download link** on your bank's or a supplier's site → **Send to Ledger…**. The
  file is downloaded in that tab, with that site's login, and a small window asks where it goes.
- **Toolbar button:** drop a file you already have (or choose one).
- **Where files go:**
  - Statements (CSV, OFX, QFX, QBO) are staged in Auto sort. You review the suggested accounts on
    its Statements tab and post the transactions.
  - Bills (PDF, EML) appear on Auto sort's Bills tab.
  - A CSV can also go to Ledger's own journal import (Files).

## Install

### Chrome, Edge, Brave
1. Download this folder (`browser-extension/` from the repository, or the release's source zip).
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose the
   `browser-extension` folder.
3. The options page opens from the extension's menu (**Details → Extension options**). Enter your
   Ledger address (e.g. `http://192.168.1.50:8080`), press **Save**, and allow access when the browser
   asks. Then press **Test**.

### Firefox
- **To try it:** open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → choose
  `browser-extension/manifest.json`. It stays until Firefox restarts.
- **To keep it:** regular Firefox only installs signed add-ons. Sign it for yourself (free, not
  listed publicly): create an account on [addons.mozilla.org](https://addons.mozilla.org/developers/),
  then in this folder run `npx web-ext sign --channel unlisted --api-key … --api-secret …` and
  install the `.xpi` it produces. (Firefox Developer Edition, Nightly and ESR can instead set
  `xpinstall.signatures.required` to `false` in `about:config` and install an unsigned zip.)
- Then open the add-on's **Options**, enter your Ledger address, **Save**, allow access, and **Test**.

## How it signs in

It uses your normal Ledger login in the same browser: log in to Ledger as usual. The extension
stores only Ledger's address, never a password.

Ledger accepts requests only from its own pages: its login cookie is `SameSite=Strict`, and it
refuses cross-site changes. So the extension makes each request *inside a Ledger tab*. It uses an
open Ledger tab if there is one; otherwise it opens a hidden one and closes it again. Ledger's
protections stay switched on.

**Permissions it asks for:**
- **Your Ledger address only:** asked for when you press Save in the options.
- **activeTab:** to download the link you right-clicked, in that page.
- **scripting**, **tabs**, **contextMenus**, **storage**.

It doesn't read pages you don't send from, and collects no data.

## Limits

- **Size:** statements up to about 1 MB of text, and bills up to 700 KB (the module's request limit).
- **Links that won't download:** some banks build the export in the page (a `blob:` link) or need
  a form submission. *Send to Ledger…* then says it couldn't download the file. Save it normally
  and drop it on the toolbar button.
- **Ledger version:** needs Ledger 0.10.0 or newer with the Auto sort module installed. The CSV files
  option works without the module.

## Files

```
manifest.json   Manifest V3 for both browsers (service_worker for Chrome, scripts for Firefox)
background.js   requests to Ledger through a Ledger tab, the right-click menu
popup.html/.js  choosing a file, where it goes and which account
options.html/.js Ledger's address and the permission for it
style.css       Ledger's colours, light and dark
icons/          toolbar icons
```
