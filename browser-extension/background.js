// Send to Ledger: background script (a service worker in Chrome, an event page in Firefox).
//
// Ledger only accepts requests from its own pages: its login cookie is
// SameSite=Strict and it rejects cross-site POSTs. So every request to Ledger
// is made *inside a Ledger tab* (an open one, or a hidden one opened and closed
// again) with scripting.executeScript in the page's own world. It then runs
// exactly like Ledger's page, with your existing login. The extension stores
// no password, only Ledger's address.

const MODULE = "categorizer"; // the Auto sort module's id

async function settings() {
	const { ledgerUrl = "" } = await chrome.storage.local.get("ledgerUrl");
	return { ledgerUrl: ledgerUrl.replace(/\/+$/, "") };
}

/** A tab showing a Ledger page we may script: an open one, or a new hidden one (closed afterwards). */
async function ledgerTab(origin) {
	const tabs = await chrome.tabs.query({ url: `${origin}/*` });
	const open = tabs.find((t) => t.status === "complete");
	if (open) return { tabId: open.id, close: false };
	// robots.txt: a small same-origin page any browser lets extensions script (Firefox doesn't for its JSON viewer).
	const tab = await chrome.tabs.create({ url: `${origin}/robots.txt`, active: false });
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
	return { tabId: tab.id, close: true };
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

/** Calls Ledger's API through a Ledger tab. Throws a readable Error on failure. */
async function ledger(req) {
	const { ledgerUrl } = await settings();
	if (!ledgerUrl) throw new Error("Set your Ledger address in the extension's options first.");
	const origin = new URL(ledgerUrl).origin;
	if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) {
		throw new Error(`The extension isn't allowed to reach ${origin} yet. Open its options and press Save.`);
	}
	const { tabId, close } = await ledgerTab(origin);
	try {
		const [res] = await chrome.scripting.executeScript({ target: { tabId }, world: "MAIN", func: callInPage, args: [req] });
		const out = res?.result ?? { status: 0, body: null };
		if (out.status === 401) throw Object.assign(new Error("You're not logged in to Ledger in this browser. Log in, then try again."), { code: "login" });
		if (out.status === 404 && req.path.includes(`/m/${MODULE}/`)) throw new Error("The Auto sort module isn't installed or running in this Ledger.");
		if (out.status < 200 || out.status >= 300) {
			const e = out.body?.error;
			const details = e?.details?.map((d) => (d.field ? `${d.field}: ${d.message}` : d.message)).join("; ");
			throw new Error(details || e?.message || `Ledger answered ${out.status || "nothing"}`);
		}
		return out.body;
	} finally {
		if (close) chrome.tabs.remove(tabId).catch(() => {});
	}
}

/** Runs in the page where a link was clicked: downloads it with that site's login. */
async function fetchLinkInPage(url) {
	try {
		const r = await fetch(url, { credentials: "include" });
		if (!r.ok) return { error: `the site answered ${r.status}` };
		const buf = new Uint8Array(await r.arrayBuffer());
		if (buf.length > 10 * 1024 * 1024) return { error: "the file is larger than 10 MB" };
		let bin = "";
		for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
		const cd = r.headers.get("content-disposition") || "";
		const m = /filename\*=(?:UTF-8'')?([^;]+)|filename="?([^";]+)"?/i.exec(cd);
		let name = m ? decodeURIComponent((m[1] || m[2]).trim()) : "";
		if (!name) name = decodeURIComponent(new URL(r.url).pathname.split("/").pop() || "") || "download";
		return { name, type: r.headers.get("content-type") || "", base64: btoa(bin), size: buf.length };
	} catch (err) {
		return { error: String(err && err.message ? err.message : err) };
	}
}

// --- Right-click a link: "Send to Ledger" -----------------------------------

function setupMenu() {
	chrome.contextMenus.removeAll(() => {
		chrome.contextMenus.create({ id: "send-link", title: "Send to Ledger…", contexts: ["link"] });
	});
}
chrome.runtime.onInstalled.addListener(setupMenu);
chrome.runtime.onStartup?.addListener(setupMenu);

async function onLinkMenu(info, tab) {
	if (info.menuItemId !== "send-link" || !tab?.id) return;
	let file;
	try {
		// Fetch it inside the site's own tab (activeTab), so the bank's login cookies apply.
		const [res] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: fetchLinkInPage, args: [info.linkUrl] });
		file = res?.result ?? { error: "no answer from the page" };
	} catch (err) {
		file = { error: err.message };
	}
	if (file.error) file = { error: `Couldn't download ${info.linkUrl}: ${file.error}. Save the file, then drop it into the extension instead.` };
	await chrome.storage.session.set({ pending: { ...file, from: info.linkUrl } });
	await chrome.windows.create({ url: chrome.runtime.getURL("popup.html?pending=1"), type: "popup", width: 460, height: 620 });
}
chrome.contextMenus.onClicked.addListener(onLinkMenu);

// --- Messages from the popup and the options page ---------------------------

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
	(async () => {
		switch (msg.type) {
			case "whoami":
				return ledger({ method: "GET", path: "/api/v1/auth/me" });
			case "accounts":
				return ledger({ method: "GET", path: `/api/v1/m/${MODULE}/accounts` });
			case "statement":
				return ledger({ method: "POST", path: `/api/v1/m/${MODULE}/statements`, json: msg.body });
			case "bill":
				return ledger({ method: "POST", path: `/api/v1/m/${MODULE}/bills/upload`, json: msg.body });
			case "ledger-file":
				return ledger({ method: "POST", path: "/api/v1/files", form: { field: "file", filename: msg.filename, type: "text/csv", base64: msg.base64 } });
			default:
				throw new Error(`unknown request ${msg.type}`);
		}
	})().then(
		(data) => reply({ ok: true, data }),
		(err) => reply({ ok: false, error: err.message, code: err.code }),
	);
	return true; // reply comes later
});
