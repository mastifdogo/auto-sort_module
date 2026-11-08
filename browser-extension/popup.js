// Send to Ledger: the popup (also opened as a window after "Send to Ledger…" on a link).
const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => {
	if (!r?.ok) throw Object.assign(new Error(r?.error || "no answer from the extension"), { code: r?.code });
	return r.data;
});
const STATEMENT_RE = /\.(csv|ofx|qfx|qbo|txt)$/i;
const BILL_RE = /\.(pdf|eml)$/i;
const MAX_STATEMENT = 1_000_000; // characters Ledger accepts in one request
const MAX_BILL = 700_000; // bytes (base64 grows it by a third)

let file = null; // { name, type, base64, size }
let accounts = [];

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

async function ledgerUrl() {
	return (await chrome.storage.local.get("ledgerUrl")).ledgerUrl?.replace(/\/+$/, "") || "";
}
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
const textOf = (f) => new TextDecoder().decode(Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0)));

async function loadAccounts() {
	if (accounts.length) return;
	try {
		const { data } = await send({ type: "accounts" });
		accounts = data.filter((a) => a.type === "asset" || a.type === "liability");
		const sel = $("account");
		const last = (await chrome.storage.local.get("lastAccount")).lastAccount || "";
		sel.replaceChildren(new Option("Choose…", ""), ...accounts.map((a) => new Option(`${a.code} · ${a.name} (${a.type}, ${a.currency})`, a.code)));
		sel.value = accounts.some((a) => a.code === last) ? last : "";
	} catch (err) {
		$("account").replaceChildren(new Option("Couldn't load accounts", ""));
		problem(err);
	}
}

function problem(err) {
	const parts = [err.message];
	if (err.code === "login") parts.push(" ", link("Open Ledger to log in", () => openLedger("/login")));
	else if (/options/i.test(err.message)) parts.push(" ", link("Options", () => chrome.runtime.openOptionsPage()));
	show(parts, "err");
}

function pick(f) {
	file = f;
	$("picked").classList.remove("hidden");
	$("picked").textContent = `${f.name} · ${(f.size / 1024).toFixed(f.size < 10240 ? 1 : 0)} KB`;
	$("form").classList.remove("hidden");
	$("dest").value = BILL_RE.test(f.name) || /pdf|rfc822/.test(f.type) ? "bill" : "statement";
	$("dest").onchange();
	show("");
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
	$("statement-opts").classList.toggle("hidden", d !== "statement");
	if (d === "statement") loadAccounts();
};
$("account").onchange = () => {
	const a = accounts.find((x) => x.code === $("account").value);
	// Card exports often list purchases as positive amounts.
	$("flip").checked = a?.type === "liability" && /\.csv$/i.test(file?.name ?? "");
};

$("form").onsubmit = async (e) => {
	e.preventDefault();
	if (!file) return;
	const dest = $("dest").value;
	$("send").disabled = true;
	show("Sending…", "muted");
	try {
		if (dest === "statement") {
			if (!STATEMENT_RE.test(file.name)) throw new Error("Statements must be CSV, OFX, QFX or QBO files.");
			const code = $("account").value;
			if (!code) throw new Error("Choose the bank or card account the statement is for.");
			const content = textOf(file);
			if (content.length > MAX_STATEMENT) throw new Error("The statement is too large for one upload; download a shorter period.");
			const r = await send({ type: "statement", body: { filename: file.name, content, account_code: code, flip_signs: $("flip").checked, date_order: $("date-order").value } });
			await chrome.storage.local.set({ lastAccount: code });
			show([`${r.transactions} transactions staged${r.duplicates ? ` (${r.duplicates} already uploaded were skipped)` : ""}. `, link("Review them in Ledger", () => openLedger(`/apps/categorizer?statement=${r.id}`))], "ok");
		} else if (dest === "bill") {
			if (file.size > MAX_BILL) throw new Error("Bills can be up to 700 KB here.");
			const r = await send({ type: "bill", body: { filename: file.name, content_base64: file.base64 } });
			show([`Bill read: ${r.vendor || "unknown vendor"}${r.amount_cents != null ? `, ${(r.amount_cents / 100).toFixed(2)} ${r.currency}` : ""}. `, link("Review it in Ledger", () => openLedger(`/apps/categorizer?bill=${r.id}`))], "ok");
		} else {
			if (!/\.csv$/i.test(file.name)) throw new Error("Ledger's journal import takes CSV files.");
			await send({ type: "ledger-file", filename: file.name, base64: file.base64 });
			show(["Saved to Ledger's CSV files. ", link("Open Files in Ledger", () => openLedger("/files"))], "ok");
		}
	} catch (err) {
		problem(err);
	} finally {
		$("send").disabled = false;
	}
};

$("open-ledger").onclick = (e) => { e.preventDefault(); openLedger(); };
$("options").onclick = (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); };

(async () => {
	if (!(await ledgerUrl())) {
		show(["Set your Ledger address first. ", link("Open options", () => chrome.runtime.openOptionsPage())], "err");
	}
	// Opened after "Send to Ledger…" on a link: the file is waiting.
	if (new URLSearchParams(location.search).has("pending")) {
		const { pending } = await chrome.storage.session.get("pending");
		await chrome.storage.session.remove("pending");
		if (pending?.error) show(pending.error, "err");
		else if (pending) pick(pending);
	}
})();
