// Send to Ledger: background script (a service worker in Chrome, an event page in Firefox).
// Part of the Auto sort module for Ledger (mastifdogo/auto-sort_module; until 0.17.0 it belonged to
// the Import module, which was merged into it): files go to the module's inbox by default, or
// become a statement, a bill or a receipt right away, or go to Ledger's Documents or CSV files.
//
// Ledger only accepts requests from its own pages: its login cookie is
// SameSite=Strict and it rejects cross-site POSTs. So every request to Ledger
// is made *inside a Ledger tab* (an open one, or a hidden one opened and closed
// again) with scripting.executeScript in the page's own world. It then runs
// exactly like Ledger's page, with your existing login. The extension stores
// no password, only Ledger's address.

const INBOX = "categorizer"; // the Auto sort module (id "categorizer"): the inbox, statements, bills and receipts

async function settings() {
	let { ledgerUrl = "" } = await chrome.storage.local.get("ledgerUrl");
	// A copy downloaded from the module's page in Ledger comes with that Ledger's address (defaults.json).
	if (!ledgerUrl) ledgerUrl = await fetch(chrome.runtime.getURL("defaults.json")).then((r) => r.json()).then((d) => String(d.ledgerUrl || ""), () => "");
	return { ledgerUrl: ledgerUrl.replace(/\/+$/, "") };
}

// When no Ledger tab is open, a hidden helper tab is opened (robots.txt: a small same-origin page
// any browser lets extensions script; Firefox doesn't for its JSON viewer). It is kept for a short
// while and reused, since one send makes several calls; opening a tab for each made sending slow.
const HELPER_IDLE_MS = 45_000;
let helper = null; // { tabId, origin, ready: Promise, timer }

function closeHelperLater() {
	if (!helper) return;
	clearTimeout(helper.timer);
	const h = helper;
	h.timer = setTimeout(() => {
		if (helper === h) helper = null;
		chrome.tabs.remove(h.tabId).catch(() => {});
		chrome.storage.session.remove("helperTab").catch(() => {});
	}, HELPER_IDLE_MS);
}

/** A helper tab left behind when the browser stopped this script early: close it. */
async function closeStrayHelper() {
	const { helperTab } = await chrome.storage.session.get("helperTab").catch(() => ({}));
	if (helperTab && helperTab !== helper?.tabId) {
		chrome.tabs.remove(helperTab).catch(() => {});
		chrome.storage.session.remove("helperTab").catch(() => {});
	}
}

/** A tab showing a Ledger page we may script: an open one, or the hidden helper tab. → tab id */
async function ledgerTab(origin) {
	const tabs = await chrome.tabs.query({ url: `${origin}/*` });
	const open = tabs.find((t) => t.status === "complete" && t.id !== helper?.tabId);
	if (open) return open.id;
	if (helper && helper.origin === origin) {
		try {
			await helper.ready;
			await chrome.tabs.get(helper.tabId); // still there?
			closeHelperLater();
			return helper.tabId;
		} catch {
			helper = null;
		}
	}
	await closeStrayHelper();
	const h = (helper = { tabId: 0, origin, ready: null, timer: 0 });
	h.ready = (async () => {
		const tab = await chrome.tabs.create({ url: `${origin}/robots.txt`, active: false });
		h.tabId = tab.id;
		chrome.storage.session.set({ helperTab: tab.id }).catch(() => {});
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				chrome.tabs.onUpdated.removeListener(listener);
				reject(new Error(`Ledger didn't answer at ${origin}`));
			}, 20_000);
			const listener = (id, info) => {
				if (id === tab.id && info.status === "complete") {
					clearTimeout(timer);
					chrome.tabs.onUpdated.removeListener(listener);
					resolve();
				}
			};
			chrome.tabs.onUpdated.addListener(listener);
		});
	})();
	try {
		await h.ready;
	} catch (err) {
		if (helper === h) helper = null;
		if (h.tabId) chrome.tabs.remove(h.tabId).catch(() => {});
		throw err;
	}
	closeHelperLater();
	return h.tabId;
}

/** Gets a Ledger tab ready ahead of time (while a file downloads, or the popup is open), so Send doesn't wait for it. */
async function warmUp() {
	try {
		const { ledgerUrl } = await settings();
		if (!ledgerUrl) return;
		const origin = new URL(ledgerUrl).origin;
		if (await chrome.permissions.contains({ origins: [`${origin}/*`] })) await ledgerTab(origin);
	} catch {
		// the real call will say what's wrong
	}
}

/**
 * Runs in the Ledger page (its own world): one API call with the page's login.
 * req: { method, path, json? , form?: { field, filename, type, base64 } }. Returns { status, body }.
 */
async function callInPage(req) {
	const init = { method: req.method, credentials: "same-origin", headers: {} };
	if (req.json !== undefined) {
		init.headers["Content-Type"] = "application/json";
		init.body = JSON.stringify(req.json);
	} else if (req.form) {
		const bin = atob(req.form.base64);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		const fd = new FormData();
		fd.append(req.form.field, new Blob([bytes], { type: req.form.type || "application/octet-stream" }), req.form.filename);
		init.body = fd;
	}
	try {
		const r = await fetch(req.path, init);
		const text = await r.text();
		let body = null;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			body = { error: { message: text.slice(0, 300) } };
		}
		return { status: r.status, body };
	} catch (err) {
		return { status: 0, body: { error: { message: String(err && err.message ? err.message : err) } } };
	}
}

const UPLOADS_AT_ONCE = 3;

/**
 * Uploads a file to the inbox in pieces (each request stays under Ledger's 1 MiB limit),
 * a few at a time, telling the popup how far it is. file: { name, type, base64, size, from }.
 */
async function uploadToInbox(file) {
	const base = `/api/v1/m/${INBOX}/inbox`;
	// The inbox takes a plain file name: no folders or control characters, at most 255 characters.
	const name = String(file.name || "").replace(/[\u0000-\u001f/\\]/g, "-").trim().slice(-255) || "download";
	const start = await ledger({ method: "POST", path: base, json: { name, content_type: file.type || "", size: file.size, source_url: file.from || "" } });
	const { id, chunk_size } = start;
	const bin = atob(file.base64); // one character per byte
	const total = Math.max(1, Math.ceil(bin.length / chunk_size));
	let next = 0;
	let done = 0;
	const progress = () => chrome.runtime.sendMessage({ type: "progress", done, total }).catch(() => {});
	progress();
	const worker = async () => {
		while (next < total) {
			const i = next++;
			await ledger({ method: "PUT", path: `${base}/${id}/chunks/${i}`, json: { data: btoa(bin.slice(i * chunk_size, (i + 1) * chunk_size)) } });
			done++;
			progress();
		}
	};
	await Promise.all(Array.from({ length: Math.min(UPLOADS_AT_ONCE, total) }, worker));
	return ledger({ method: "POST", path: `${base}/${id}/complete` });
}

/** Calls Ledger's API through a Ledger tab. Throws a readable Error on failure. */
async function ledger(req) {
	const { ledgerUrl } = await settings();
	if (!ledgerUrl) throw Object.assign(new Error("Set your Ledger address first."), { code: "setup" });
	const origin = new URL(ledgerUrl).origin;
	if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
		throw Object.assign(new Error(`The extension isn't allowed to reach ${origin} yet.`), { code: "setup" });
	}
	const tabId = await ledgerTab(origin);
	{
		const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: callInPage, args: [req] });
		const out = res?.result ?? { status: 0, body: null };
		const path = req.path ?? `/api/v1/m/${INBOX}/`;
		if (out.status === 401) throw Object.assign(new Error("You're not logged in to Ledger in this browser. Log in, then try again."), { code: "login" });
		// No such route: the module isn't there, or is older than 0.17.0 (before it had the inbox).
		if (out.status === 404 && path.includes(`/m/${INBOX}/`) && !/\/inbox\/\d+\//.test(path)) throw Object.assign(new Error("The Auto sort module (0.17.0 or newer) isn't installed or running in this Ledger (Settings → Modules: mastifdogo/auto-sort_module)."), { code: "no-autosort" });
		if (out.status < 200 || out.status >= 300) {
			const e = out.body?.error;
			const details = e?.details?.map((d) => (d.field ? `${d.field}: ${d.message}` : d.message)).join("; ");
			throw new Error(details || e?.message || `Ledger answered ${out.status || "nothing"}`);
		}
		return out.body;
	}
}

/** Runs in the page where a link was clicked: downloads it with that site's login. */
async function fetchLinkInPage(url) {
	try {
		const r = await fetch(url, { credentials: "include" });
		if (!r.ok) return { error: `the site answered ${r.status}` };
		const buf = new Uint8Array(await r.arrayBuffer());
		if (buf.length > 100 * 1024 * 1024) return { error: "the file is larger than 100 MB" };
		let bin = "";
		for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
		// A name isn't always percent-encoded ("100% paid.pdf"): then it is used as it is.
		const decode = (s) => {
			try {
				return decodeURIComponent(s);
			} catch {
				return s;
			}
		};
		const cd = r.headers.get("content-disposition") || "";
		const m = /filename\*=(?:UTF-8'')?([^;]+)|filename="?([^";]+)"?/i.exec(cd);
		let name = m ? decode((m[1] || m[2]).trim()) : "";
		if (!name) name = decode(new URL(r.url).pathname.split("/").pop() || "") || "download";
		return { name, type: r.headers.get("content-type") || "", base64: btoa(bin), size: buf.length };
	} catch (err) {
		return { error: String(err && err.message ? err.message : err) };
	}
}

// --- Right-click a link: "Send to Ledger" -----------------------------------

const PDF_URLS = ["*://*/*.pdf", "*://*/*.pdf?*", "*://*/*.PDF", "*://*/*.PDF?*"];
function setupMenu() {
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({ id: "send-link", title: "Send to Ledger…", contexts: ["link"] });
		// A PDF shown in the tab, or in a frame of the page (how many banks show statements).
		chrome.contextMenus.create({ id: "send-page", title: "Send this PDF to Ledger…", contexts: ["page"], documentUrlPatterns: PDF_URLS });
		chrome.contextMenus.create({ id: "send-frame", title: "Send this frame's file to Ledger…", contexts: ["frame"] });
	});
}

/** The file a tab is showing (its own address), fetched inside the tab so the site's login applies. */
async function fileOfTab(tab, url = tab.url) {
	if (!/^https?:/i.test(url || "")) throw new Error("This tab isn't a web address the extension can read. Save the file, then drop it here.");
	let file;
	try {
		const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: fetchLinkInPage, args: [url] });
		file = res?.result ?? { error: "no answer from the page" };
	} catch (err) {
		file = { error: err.message };
	}
	if (file.error) throw new Error(`Couldn't get the file from this tab (${file.error}). Download it, then drop it here.`);
	if (/^text\/html/i.test(file.type)) throw new Error("This tab shows a web page, not a file. Right-click the link to the PDF and choose Send to Ledger…, or open the PDF in its own tab first.");
	if (!/\.[a-z0-9]{2,5}$/i.test(file.name) && /pdf/i.test(file.type)) file.name += ".pdf";
	return { ...file, from: url };
}
chrome.runtime.onInstalled.addListener(setupMenu);
chrome.runtime.onStartup?.addListener(setupMenu);

// The file a menu click is fetching, for the window that opens straight away: { from, file: Promise }.
// (Kept here, not in storage: files can be larger than session storage allows.)
let pending = null;

async function onLinkMenu(info, tab) {
	if (!tab?.id || !["send-link", "send-page", "send-frame"].includes(info.menuItemId)) return;
	const url = info.menuItemId === "send-link" ? info.linkUrl : info.menuItemId === "send-frame" ? info.frameUrl : info.pageUrl;
	// Start the download in the site's own tab (so its login applies), and open the window at once:
	// it shows that the file is on its way instead of nothing happening until the download ends.
	const fetching =
		info.menuItemId === "send-link"
			? chrome.scripting
					.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: fetchLinkInPage, args: [url] })
					.then(([res]) => res?.result ?? { error: "no answer from the page" }, (err) => ({ error: err.message }))
					.then((file) => (file.error ? { error: `Couldn't download ${url}: ${file.error}. Save the file, then drop it into the extension instead.` } : { ...file, from: url }))
			: fileOfTab(tab, url).catch((err) => ({ error: err.message }));
	pending = { from: url, file: fetching };
	warmUp(); // a Ledger tab, ready by the time Send is pressed
	let host = "";
	let name = "";
	try {
		const u = new URL(url);
		host = u.host;
		name = decodeURIComponent(u.pathname.split("/").pop() || "");
	} catch {}
	// The link's own name, when it has one (statement.pdf): the window offers the fitting choices before the file is here.
	if (!/\.[a-z0-9]{2,5}$/i.test(name)) name = "";
	await chrome.windows.create({ url: chrome.runtime.getURL(`popup.html?pending=1&from=${encodeURIComponent(host)}&name=${encodeURIComponent(name.slice(0, 120))}`), type: "popup", width: 460, height: 620 });
}
chrome.contextMenus.onClicked.addListener(onLinkMenu);

// --- Sending, here in the background ---------------------------------------
// The popup only says where a file goes. The work (waiting for the download, uploading, filing)
// happens here, so the window can be closed and the browser used for something else meanwhile.
// The outcome goes back to the window if it's still open, and always to a notification and the
// toolbar button's badge.

const STATEMENT_RE = /\.(csv|ofx|qfx|qbo|txt)$/i;
/** A choice that doesn't fit the file: it goes to the inbox instead, which takes anything. */
const misfit = (message) => Object.assign(new Error(message), { misfit: true });
const inboxLink = (id) => ({ path: `/apps/${INBOX}?file=${id}`, linkText: "Open it in Ledger" });

/** Sends the file where the job says. → { text, path } (what happened, and where to see it in Ledger). */
async function deliver(file, job) {
	const dest = job.dest;
	if (dest === "inbox") {
		const r = await uploadToInbox(file);
		return { text: `Sent to the inbox.${r.duplicate_of ? ` The same file arrived before (${r.duplicate_of.name}).` : ""}`, ...inboxLink(r.id) };
	}
	if (dest === "ledger-file") {
		if (!/\.csv$/i.test(file.name)) throw misfit("Ledger's journal import takes CSV files.");
		await ledger({ method: "POST", path: "/api/v1/files", form: { field: "file", filename: file.name, type: "text/csv", base64: file.base64 } });
		return { text: "Saved to Ledger's CSV files.", path: "/files", linkText: "Open Files in Ledger" };
	}
	const isStatementDoc = dest === "doc-statement";
	if ((dest === "statement" || isStatementDoc) && !job.account) throw new Error("Choose the bank or card account the statement is for.");
	if (dest === "statement" && !STATEMENT_RE.test(file.name)) throw misfit("A statement to review must be a CSV, OFX, QFX or QBO file; a PDF's transactions are read in the inbox (Extract data).");
	if (!dest.startsWith("doc-") && dest !== "statement" && dest !== "bill" && dest !== "receipt") throw new Error(`unknown destination ${dest}`);
	// Every file goes into the inbox first, in pieces (any size it takes), where Ledger files it in
	// Documents; then the module is told what it is. Should that fail, the file is safe in the inbox.
	const f = await uploadToInbox(file);
	const base = `/api/v1/m/${INBOX}/inbox/${f.id}`;
	try {
		if (dest.startsWith("doc-")) {
			const kind = dest.slice(4);
			const r = await ledger({ method: "POST", path: `${base}/file-as`, json: { kind, ...(kind === "statement" ? { account_code: job.account } : {}) } });
			return { text: `Filed in Ledger's ${r.sent_to}${kind === "statement" ? ` for account ${job.account}` : ""}.`, path: "/documents", linkText: "Open Documents in Ledger" };
		}
		if (dest === "statement") {
			const r = (await ledger({ method: "POST", path: `${base}/statement`, json: { account_code: job.account, flip_signs: !!job.flip, date_order: job.dateOrder || "auto" } })).statement;
			return { text: `${r.transactions} transactions staged${r.duplicates ? ` (${r.duplicates} already uploaded were skipped)` : ""}.`, path: `/apps/${INBOX}?statement=${r.id}`, linkText: "Review them in Ledger" };
		}
		const r = (await ledger({ method: "POST", path: `${base}/bill`, json: { kind: dest } })).bill;
		return { text: `${r.kind === "receipt" ? "Receipt" : "Bill"} read: ${r.vendor || "unknown vendor"}${r.amount_cents != null ? `, ${(r.amount_cents / 100).toFixed(2)} ${r.currency}` : ""}.`, path: `/apps/${INBOX}?bill=${r.id}`, linkText: "Review it in Ledger" };
	} catch (err) {
		if (err.code === "login" || err.code === "setup") throw err;
		return { text: `${err.message} It's in the inbox, where you can sort it out.`, ...inboxLink(f.id), fallback: true };
	}
}

function badge(text, color) {
	try {
		chrome.action.setBadgeText({ text });
		if (color) chrome.action.setBadgeBackgroundColor({ color });
	} catch {
		// no badge in this browser
	}
}

/** Tells the outcome where it will be seen with the window closed: a notification, the badge, and the popup's next opening. */
async function announce(result) {
	await chrome.storage.local.set({ lastResult: { ...result, at: Date.now() } }).catch(() => {});
	badge(result.ok ? "✓" : "!", result.ok ? "#1a7f37" : "#cf222e");
	try {
		chrome.notifications?.create(`send-${Date.now()}`, { type: "basic", iconUrl: chrome.runtime.getURL("icons/icon-128.png"), title: result.ok ? `Sent to Ledger: ${result.name}` : `Not sent: ${result.name}`, message: result.text });
	} catch {
		// notifications aren't available: the badge and the popup still say it
	}
}

// --- The organization files go to --------------------------------------------
// Ledger keeps the organization on the login session, which this browser's Ledger tabs share; it has no
// way to say it per request. So to send to another organization than the one Ledger is in, the session
// is switched to it for the few seconds the sending takes, then switched back (also when sending fails).
// One switch at a time: everything that runs in another organization goes through this queue.
let orgQueue = Promise.resolve();

/** The organization chosen in the extension's options (0: whichever Ledger is in at the time). */
async function savedOrg() {
	const { orgId = 0 } = await chrome.storage.local.get("orgId");
	return Number(orgId) || 0;
}

/** The organizations this Ledger login can use, and the one it is in now. */
async function organizations() {
	const me = await ledger({ method: "GET", path: "/api/v1/auth/me" });
	const list = (me.organizations ?? []).filter((o) => !o.status || o.status === "ready").map((o) => ({ id: o.id, name: o.name, role: o.role }));
	return { current: me.organization ? { id: me.organization.id, name: me.organization.name } : null, list };
}

const switchTo = (id) => ledger({ method: "POST", path: "/api/v1/auth/organization", json: { organization_id: id } });

/** Runs fn with the session in organization orgId (0: as it is), and puts it back afterwards. → { value, org } */
function inOrganization(orgId, fn) {
	if (!orgId) return fn().then((value) => ({ value, org: null }));
	const run = async () => {
		const { current, list } = await organizations();
		const target = list.find((o) => o.id === orgId);
		if (!target) throw new Error("This Ledger login can't use the organization chosen in the extension's options any more. Choose another there.");
		if (target.role === "viewer") throw new Error(`You can only view ${target.name} in Ledger, so files can't be sent there. Choose another organization.`);
		if (!current || current.id === orgId) return { value: await fn(), org: target };
		await switchTo(orgId);
		try {
			return { value: await fn(), org: target };
		} finally {
			// Back where Ledger was, also when sending failed; a second try before saying so.
			await switchTo(current.id).catch(() => switchTo(current.id)).catch(() =>
				announce({ ok: false, name: "Ledger's organization", text: `Ledger was left in ${target.name}. Switch back to ${current.name} in Ledger.` }),
			);
		}
	};
	const next = orgQueue.then(run, run);
	orgQueue = next.catch(() => {});
	return next;
}

let jobs = 0;
/** One Send: waits for the file if it's still downloading, delivers it, and announces the outcome. → the result */
async function runJob(job, given) {
	const p = given ? null : pending;
	let name = given?.name || "the file";
	jobs++;
	badge("…", "#1f6feb");
	try {
		const file = given ?? (p ? await p.file : null);
		if (!file) throw new Error("Nothing is waiting to be sent. Right-click the link and choose Send to Ledger… again.");
		if (file.error) throw new Error(file.error);
		name = file.name;
		const orgId = job.org === undefined ? await savedOrg() : Number(job.org) || 0;
		const { value: out, org } = await inOrganization(orgId, async () => {
			try {
				return await deliver(file, job);
			} catch (err) {
				if (!err.misfit) throw err;
				// Chosen before the file was known, or it doesn't fit: nobody may be there to choose again, so keep it safe in the inbox.
				const r = await uploadToInbox(file);
				return { text: `${err.message} It's in the inbox instead, where you can sort it out.`, ...inboxLink(r.id), fallback: true };
			}
		});
		if (org) out.text = `${out.text.replace(/\.$/, "")} (${org.name}).`;
		if (p && pending === p) pending = null;
		if (job.account) await chrome.storage.local.set({ lastAccount: job.account });
		if (!out.fallback) {
			const kind = BILL_RE.test(file.name) || /pdf|rfc822/.test(file.type || "") ? "bill" : STATEMENT_RE.test(file.name) ? "statement" : "other";
			const { lastDest = {} } = await chrome.storage.local.get("lastDest");
			await chrome.storage.local.set({ lastDest: { ...lastDest, [kind]: job.dest } });
		}
		const result = { ok: true, name, ...out };
		await announce(result);
		return result;
	} catch (err) {
		// The file stays here (when it came from a menu click), so Send can be pressed again.
		await announce({ ok: false, name, text: err.message, code: err.code });
		throw err;
	} finally {
		if (--jobs > 0) badge("…", "#1f6feb");
	}
}

// A notification about a send: open Ledger where the file went.
chrome.notifications?.onClicked.addListener(async (id) => {
	if (!id.startsWith("send-")) return;
	chrome.notifications.clear(id);
	const { lastResult } = await chrome.storage.local.get("lastResult");
	const { ledgerUrl } = await settings();
	if (ledgerUrl && lastResult?.path) chrome.tabs.create({ url: ledgerUrl + lastResult.path });
	badge("");
});

// --- Messages from the popup and the options page ---------------------------

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
	(async () => {
		switch (msg.type) {
			case "whoami":
				return ledger({ method: "GET", path: "/api/v1/auth/me" });
			case "warm-up":
				return void warmUp();
			case "pending": {
				// The file a menu click is fetching: answers when it has arrived.
				const p = pending;
				if (!p) throw new Error("Nothing is waiting to be sent. Right-click the link and choose Send to Ledger… again.");
				const file = await p.file;
				if (file.error) {
					if (pending === p) pending = null;
					return file;
				}
				// Only what the window shows; the file itself stays here until it is sent.
				return { name: file.name, type: file.type, size: file.size, from: file.from };
			}
			case "send":
				// From the popup's Send: the file it holds, or the one a menu click is still fetching.
				// It runs here, so the window can be closed; the answer also goes to a notification.
				return runJob(msg.job, msg.file);
			case "last-result": {
				const { lastResult = null } = await chrome.storage.local.get("lastResult");
				chrome.action?.setBadgeText({ text: "" });
				return lastResult;
			}
			case "orgs":
				return { ...(await organizations()), saved: await savedOrg() };
			// Accounts of the organization the file will go to.
			case "accounts":
				return (await inOrganization(Number(msg.org) || 0, () => ledger({ method: "GET", path: `/api/v1/m/${INBOX}/accounts` }))).value;
			case "ledger-accounts":
				return (await inOrganization(Number(msg.org) || 0, () => ledger({ method: "GET", path: "/api/v1/accounts" }))).value;
			case "tab-file": {
				const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
				if (!tab?.id) throw new Error("No tab to read.");
				return fileOfTab(tab);
			}
			default:
				throw new Error(`unknown request ${msg.type}`);
		}
	})().then(
		(data) => reply({ ok: true, data }),
		(err) => reply({ ok: false, error: err.message, code: err.code }),
	);
	return true; // reply comes later
});
