// Send to Ledger: the popup (also opened as a window after "Send to Ledger…" on a link).
// Destinations: the inbox (always), a statement, a bill or a receipt (read and reviewed in the
// Auto sort module), Ledger's Documents for any file (as a receipt, statement or invoice), and Ledger's
// CSV files.
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => {
	if (!r?.ok) throw Object.assign(new Error(r?.error || "no answer from the extension"), { code: r?.code });
	return r.data;
});
const STATEMENT_RE = /\.(csv|ofx|qfx|qbo|txt)$/i;
const BILL_RE = /\.(pdf|eml)$/i;
/** What Ledger's Documents keeps: PDFs, and PNG or JPEG scans. */
const isDoc = (f) => /\.(pdf|png|jpe?g)$/i.test(f.name) || /^(application\/pdf|image\/(png|jpeg))/i.test(f.type || "");

let file = null; // { name, type, base64, size, from? }
let accounts = [];
let autosort = null; // null = not checked yet, true/false once known

function show(text, cls = "") {
	$("msg").className = `small ${cls}`;
	$("msg").replaceChildren(...(Array.isArray(text) ? text : [text]));
}

function link(text, onclick) {
	const a = document.createElement("a");
	a.href = "#";
	a.textContent = text;
	a.onclick = (e) => { e.preventDefault(); onclick(); };
	return a;
}

/** The address saved in options, else the one this copy came with (downloaded from the module's page in Ledger). */
async function ledgerUrl() {
	const saved = (await chrome.storage.local.get("ledgerUrl")).ledgerUrl;
	if (saved) return saved.replace(/\/+$/, "");
	try {
		return String((await (await fetch(chrome.runtime.getURL("defaults.json"))).json()).ledgerUrl || "").replace(/\/+$/, "");
	} catch {
		return "";
	}
}

/** Whether the address is known and the browser lets the extension reach it. */
async function ready() {
	const u = await ledgerUrl();
	if (!u) return false;
	try {
		return await chrome.permissions.contains({ origins: [`${new URL(u).origin}/*`] });
	} catch {
		return false;
	}
}

// Setting up here, without a trip to the options page: the address (filled in already in a copy
// downloaded from Ledger) and the browser's permission for it. The picked file stays.
async function showSetup() {
	$("setup-url").value ||= await ledgerUrl();
	$("setup").classList.remove("hidden");
	$("send").disabled = true;
}
$("setup").onsubmit = (e) => {
	e.preventDefault();
	let url;
	try {
		let s = $("setup-url").value.trim();
		if (!s) throw new Error("empty");
		if (!/^https?:\/\//i.test(s)) s = "http://" + s;
		const u = new URL(s);
		url = u.origin + u.pathname.replace(/\/+$/, "");
	} catch {
		return show("That isn't a web address.", "err");
	}
	// Saved first: a toolbar popup can close when the browser's permission question opens, and the
	// request must come straight from this click.
	chrome.storage.local.set({ ledgerUrl: url });
	chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] }).then(async (granted) => {
		if (!granted) return show("Without that permission the extension can't reach Ledger.", "err");
		$("setup").classList.add("hidden");
		$("send").disabled = false;
		show("");
		autosort = null;
		accounts = [];
		await checkAutosort();
		if (!$("statement-opts").classList.contains("hidden")) loadAccounts();
	}, (err) => show(String(err?.message || err), "err"));
};
async function openLedger(path = "/") {
	const u = await ledgerUrl();
	if (!u) return chrome.runtime.openOptionsPage();
	chrome.tabs.create({ url: u + path });
}

function base64Of(bytes) {
	let bin = "";
	for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return btoa(bin);
}

/** Whether the Auto sort module is installed; hides its options when it isn't. */
async function checkAutosort() {
	if (autosort !== null) return autosort;
	try {
		await loadOrgs(); // the accounts of the organization the file goes to
		const { data } = await send({ type: "accounts", org: chosenOrg() });
		accounts = data.filter((a) => (a.type === "asset" || a.type === "liability") && a.kind !== "clearing"); // never a clearing account
		autosort = true;
	} catch (err) {
		if (err.code === "setup") showSetup();
		if (err.code !== "no-autosort") return null; // not logged in etc.: decide later
		autosort = false;
	}
	document.querySelectorAll("option.autosort").forEach((o) => (o.hidden = o.disabled = !autosort));
	if (!autosort && $("dest").selectedOptions[0]?.classList.contains("autosort")) {
		$("dest").value = "inbox";
		$("dest").onchange();
	}
	return autosort;
}

// The organization the file goes to: shown when this login can use more than one. It starts at the one
// chosen in the extension's options and can be changed for this file.
let orgsLoaded = false;
let orgsLoading = null;
const chosenOrg = () => Number($("org").value) || 0;
const loadOrgs = () => (orgsLoading ??= fetchOrgs());
async function fetchOrgs() {
	try {
		const { current, list, saved } = await send({ type: "orgs" });
		orgsLoaded = true;
		if (list.length < 2) return;
		$("org").replaceChildren(
			new Option(`Where Ledger is now${current ? ` (${current.name})` : ""}`, "0"),
			...list.map((o) => Object.assign(new Option(o.role === "viewer" ? `${o.name} (view only)` : o.name, String(o.id)), { disabled: o.role === "viewer" })),
		);
		$("org").value = list.some((o) => o.id === saved && o.role !== "viewer") ? String(saved) : "0";
		$("org-row").classList.remove("hidden");
	} catch {
		// not set up or not logged in yet: the rest of the window says so; try again next time
		orgsLoading = null;
	}
}
$("org").onchange = () => {
	// Another organization has other accounts.
	accounts = [];
	if (!$("statement-opts").classList.contains("hidden")) loadAccounts();
};

async function loadAccounts() {
	if (accounts.length) return fillAccounts();
	try {
		// Auto sort's list when it's installed, else Ledger's own accounts.
		const org = chosenOrg();
		const { data } = await send({ type: autosort === false ? "ledger-accounts" : "accounts", org }).catch((err) => {
			if (err.code !== "no-autosort") throw err;
			return send({ type: "ledger-accounts", org });
		});
		accounts = data.filter((a) => (a.type === "asset" || a.type === "liability") && a.kind !== "clearing"); // never a clearing account
		await fillAccounts();
	} catch (err) {
		$("account").replaceChildren(new Option(err.code === "setup" ? "Allow access below first" : "Couldn't load accounts", ""));
		problem(err);
	}
}

async function fillAccounts() {
	{
		const sel = $("account");
		const last = (await chrome.storage.local.get("lastAccount")).lastAccount || "";
		sel.replaceChildren(new Option("Choose…", ""), ...accounts.map((a) => new Option(`${a.code} · ${a.name} (${a.type}, ${a.currency})`, a.code)));
		sel.value = accounts.some((a) => a.code === last) ? last : "";
	}
}

function problem(err) {
	const parts = [err.message];
	if (err.code === "setup") {
		showSetup();
		return show("One step before sending: let the extension reach your Ledger.", "muted");
	}
	if (err.code === "login") parts.push(" ", link("Open Ledger to log in", () => openLedger("/login")));
	else if (/options/i.test(err.message)) parts.push(" ", link("Options", () => chrome.runtime.openOptionsPage()));
	show(parts, "err");
}

const describe = (f) => `${f.name} · ${f.size < 1048576 ? `${(f.size / 1024).toFixed(f.size < 10240 ? 1 : 0)} KB` : `${(f.size / 1048576).toFixed(1)} MB`}${f.from ? ` · from ${new URL(f.from).host}` : ""}`;
const kindOf = (f) => (BILL_RE.test(f.name) || /pdf|rfc822/.test(f.type || "") ? "bill" : STATEMENT_RE.test(f.name) ? "statement" : "other");

/** Shows only the choices that fit the file (all of them while its kind isn't known yet). */
function fitChoices(f, unknown = false) {
	// Documents takes any file; a statement to review must be one the parsers read; the journal import CSV files only.
	document.querySelectorAll("option.doc").forEach((o) => (o.hidden = o.disabled = false));
	document.querySelectorAll("option.parsed").forEach((o) => (o.hidden = o.disabled = !unknown && !STATEMENT_RE.test(f.name)));
	document.querySelectorAll("option.billish").forEach((o) => (o.hidden = o.disabled = !unknown && !(BILL_RE.test(f.name) || isDoc(f) || /rfc822/.test(f.type || ""))));
	document.querySelectorAll("option.csv").forEach((o) => (o.hidden = o.disabled = !unknown && !/\.csv$/i.test(f.name)));
}

/** The form, with the inbox chosen unless you last sent this kind of file somewhere else. */
async function showForm(f, unknown = false) {
	$("form").classList.remove("hidden");
	fitChoices(f, unknown);
	const { lastDest = {} } = await chrome.storage.local.get("lastDest");
	$("dest").value = lastDest[kindOf(f)] || "inbox";
	if ($("dest").selectedOptions[0]?.disabled || $("dest").selectedIndex < 0) $("dest").value = "inbox";
	$("dest").onchange();
	checkAutosort();
	loadOrgs();
}

async function pick(f) {
	file = f;
	$("picked").classList.remove("hidden");
	$("picked").textContent = describe(f);
	show("");
	await showForm(f);
}

// A file still downloading (after "Send to Ledger…" on a link): the form is there already, so the
// fields can be chosen meanwhile, and Send pressed early sends as soon as the file has arrived.
let waiting = false;
function arrived(f) {
	waiting = false;
	file = { ...f, held: true }; // the extension holds the file itself
	$("picked").textContent = describe(f);
	if (sending) return; // Send was pressed already: the extension is on it
	fitChoices(f);
	if ($("dest").selectedOptions[0]?.disabled) {
		// What was chosen while waiting doesn't fit what the file turned out to be.
		$("dest").value = "inbox";
		$("dest").onchange();
		show(`${f.name} can't be sent that way; choose again.`, "err");
	}
}

async function readFile(f) {
	const bytes = new Uint8Array(await f.arrayBuffer());
	pick({ name: f.name, type: f.type, base64: base64Of(bytes), size: bytes.length });
}

$("file").onchange = () => $("file").files[0] && readFile($("file").files[0]);
const drop = $("drop");
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add("over"); };
drop.ondragleave = () => drop.classList.remove("over");
drop.ondrop = (e) => {
	e.preventDefault();
	drop.classList.remove("over");
	const f = e.dataTransfer.files[0];
	if (f) readFile(f);
};

$("dest").onchange = () => {
	const d = $("dest").value;
	$("statement-opts").classList.toggle("hidden", d !== "statement" && d !== "doc-statement");
	$("csv-opts").classList.toggle("hidden", d !== "statement"); // signs and date order are for CSV statements
	if (d === "statement" || d === "doc-statement") loadAccounts();
};
$("account").onchange = () => {
	const a = accounts.find((x) => x.code === $("account").value);
	// Card exports often list purchases as positive amounts.
	$("flip").checked = a?.type === "liability" && /\.csv$/i.test(file?.name ?? "");
};

$("form").onsubmit = async (e) => {
	e.preventDefault();
	if (!file && !waiting) return;
	const dest = $("dest").value;
	if (dest.endsWith("statement") && !$("account").value) return show("Choose the bank or card account the statement is for.", "err");
	const job = { dest, account: dest.endsWith("statement") ? $("account").value : "", flip: $("flip").checked, dateOrder: $("date-order").value, ...(orgsLoaded ? { org: chosenOrg() } : {}) };
	$("send").disabled = true;
	sending = true;
	// The extension does the sending, not this window: it can be closed, and a notification says how it went.
	show(waiting ? "Got it. It's sent as soon as the download finishes; you can close this window and carry on. A notification will say when it's done." : "Sending… You can close this window; a notification will say when it's done.", "muted");
	try {
		// A file from a menu click is already with the extension; one dropped here is handed over.
		const r = await send({ type: "send", job, ...(file && !file.held ? { file } : {}) });
		show([`${r.text} `, link(r.linkText || "Open Ledger", () => openLedger(r.path))], r.fallback ? "err" : "ok");
		send({ type: "last-result" }).catch(() => {}); // seen here: clear the toolbar badge
	} catch (err) {
		problem(err);
	} finally {
		sending = false;
		$("send").disabled = false;
	}
};

// How far the upload is (larger files go in pieces).
let sending = false;
chrome.runtime.onMessage.addListener((msg) => {
	if (msg?.type === "progress" && sending && msg.total > 1 && msg.done < msg.total) show(`Sending… ${Math.round((msg.done / msg.total) * 100)}%. You can close this window.`, "muted");
});

// A PDF (or other file) the browser is showing in this tab: fetched in that tab, with the site's login.
$("send-tab").onclick = async (e) => {
	e.preventDefault();
	show("Getting the file from this tab…", "muted");
	try {
		pick(await send({ type: "tab-file" }));
	} catch (err) {
		problem(err);
	}
};

$("open-ledger").onclick = (e) => { e.preventDefault(); openLedger(); };
$("options").onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

(async () => {
	if (!(await ready())) {
		showSetup();
		show("One step before sending: let the extension reach your Ledger. You can pick the file meanwhile.", "muted");
	}
	// Opened right after "Send to Ledger…" on a link or PDF: the file is still being downloaded.
	const q = new URLSearchParams(location.search);
	if (q.has("pending")) {
		$("send-tab").parentElement.classList.add("hidden"); // this window has no tab of its own to read
		$("drop").classList.add("hidden");
		const started = Date.now();
		const from = q.get("from") ? ` from ${q.get("from")}` : "";
		const name = q.get("name") || "";
		const tick = () => ($("picked").textContent = `Downloading ${name || "the file"}${from}… ${Math.round((Date.now() - started) / 1000)} s. Choose where it goes meanwhile.`);
		$("picked").classList.remove("hidden");
		tick();
		const timer = setInterval(tick, 1000);
		// The form now, from the link's name (every choice when the name doesn't say what it is).
		waiting = true;
		showForm({ name, type: "" }, !/\.[a-z0-9]{2,5}$/i.test(name));
		const failed = (say) => {
			waiting = false;
			if (sending) return; // the Send in progress reports it
			$("form").classList.add("hidden");
			$("picked").classList.add("hidden");
			$("send").disabled = false;
			say();
		};
		try {
			const pending = await send({ type: "pending" });
			clearInterval(timer);
			if (pending.error) failed(() => show(pending.error, "err"));
			else arrived(pending);
		} catch (err) {
			clearInterval(timer);
			failed(() => problem(err));
		}
		$("drop").classList.remove("hidden");
	} else if (await ready()) {
		// How the last send went, if it finished while no window was open.
		send({ type: "last-result" }).then((r) => {
			if (r && Date.now() - r.at < 10 * 60_000 && !$("msg").textContent) show([`${r.ok ? "" : "Not sent: "}${r.name}: ${r.text} `, ...(r.path ? [link(r.linkText || "Open Ledger", () => openLedger(r.path))] : [])], r.ok && !r.fallback ? "ok" : "err");
		}).catch(() => {});
		send({ type: "warm-up" }).catch(() => {}); // a Ledger tab, ready by the time Send is pressed
	}
})();
