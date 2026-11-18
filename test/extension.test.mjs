// The Send to Ledger extension's background script (ui/extension/background.js), loaded with a
// stand-in for the browser's extension API: how a downloaded file is named, and what the upload
// to the inbox sends as its name, and that a statement, a bill or a receipt goes through the inbox.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ui", "extension", "background.js");

function background() {
	const on = { addListener() {} };
	const chrome = {
		runtime: { onInstalled: on, onStartup: on, onMessage: on, sendMessage: async () => {}, getURL: (p) => p },
		contextMenus: { onClicked: on },
		notifications: { onClicked: on },
	};
	const context = vm.createContext({ chrome, URL, atob, btoa, setTimeout, clearTimeout });
	vm.runInContext(readFileSync(file, "utf8"), context, { filename: file });
	return context;
}

const response = (url, disposition) => ({
	ok: true,
	url,
	headers: { get: (h) => (h === "content-disposition" ? disposition : h === "content-type" ? "application/pdf" : null) },
	arrayBuffer: async () => new TextEncoder().encode("%PDF-1.4").buffer,
});

test("extension: a downloaded file's name, also when it isn't percent-encoded", async () => {
	const bg = background();
	const nameOf = async (url, disposition = null) => {
		bg.fetch = async () => response(url, disposition);
		const r = await bg.fetchLinkInPage(url);
		assert.equal(r.error, undefined, r.error);
		assert.equal(r.size, 8);
		return r.name;
	};
	assert.equal(await nameOf("https://bank.example/dl?id=1", 'attachment; filename="October statement.pdf"'), "October statement.pdf");
	assert.equal(await nameOf("https://bank.example/dl?id=1", "attachment; filename*=UTF-8''Relev%C3%A9%20octobre.pdf"), "Relevé octobre.pdf");
	assert.equal(await nameOf("https://bank.example/files/Relev%C3%A9.pdf"), "Relevé.pdf");
	assert.equal(await nameOf("https://bank.example/dl?id=1", 'attachment; filename="100% paid.pdf"'), "100% paid.pdf");
	assert.equal(await nameOf("https://bank.example/files/50%25%ZZoff.pdf"), "50%25%ZZoff.pdf");
});

test("extension: the upload gives the inbox a plain file name", async () => {
	const bg = background();
	const sent = [];
	bg.ledger = async (req) => (sent.push(req), req.method === "POST" && req.path.endsWith("/inbox") ? { id: 9, chunk_size: 524288 } : { id: 9 });
	const upload = async (name) => {
		sent.length = 0;
		await bg.uploadToInbox({ name, type: "application/pdf", base64: btoa("%PDF-1.4"), size: 8, from: "https://bank.example/a" });
		assert.deepEqual(sent.map((r) => `${r.method} ${r.path}`), ["POST /api/v1/m/categorizer/inbox", "PUT /api/v1/m/categorizer/inbox/9/chunks/0", "POST /api/v1/m/categorizer/inbox/9/complete"]);
		return sent[0].json.name;
	};
	assert.equal(await upload("statement.pdf"), "statement.pdf");
	assert.equal(await upload("2026/10\\statement.pdf"), "2026-10-statement.pdf");
	assert.equal(await upload("a\tb\u0000.pdf"), "a-b-.pdf");
	assert.equal((await upload(`${"x".repeat(300)}.pdf`)).length, 255);
	assert.equal(await upload(""), "download");
});

test("extension: a statement or a bill goes into the inbox first, then is made what it is there", async () => {
	const bg = background();
	const sent = [];
	bg.ledger = async (req) => {
		sent.push(`${req.method} ${req.path}`);
		if (req.path.endsWith("/inbox")) return { id: 9, chunk_size: 524288 };
		if (req.path.endsWith("/statement")) return { id: 9, statement: { id: 4, transactions: 12, duplicates: 1 } };
		if (req.path.endsWith("/bill")) {
			if (req.json.kind === "receipt") throw new Error("reading pictures needs an LLM connection for images");
			return { id: 9, bill: { id: 6, kind: "bill", vendor: "Hydro One", amount_cents: 8550, currency: "CAD" } };
		}
		return { id: 9 };
	};
	const file = (name) => ({ name, type: "", base64: btoa("x,y"), size: 3, from: "" });
	let r = await bg.deliver(file("oct.csv"), { dest: "statement", account: "1000", flip: false });
	assert.equal(r.path, "/apps/categorizer?statement=4");
	assert.match(r.text, /12 transactions staged \(1 already uploaded were skipped\)/);
	assert.equal(sent.at(-1), "POST /api/v1/m/categorizer/inbox/9/statement");
	r = await bg.deliver(file("hydro.pdf"), { dest: "bill" });
	assert.equal(r.path, "/apps/categorizer?bill=6");
	assert.match(r.text, /Bill read: Hydro One, 85\.50 CAD/);
	// When the next step fails the file isn't sent twice: it is in the inbox already.
	sent.length = 0;
	r = await bg.deliver(file("photo.jpg"), { dest: "receipt" });
	assert.equal(r.fallback, true);
	assert.equal(r.path, "/apps/categorizer?file=9");
	assert.equal(sent.filter((x) => x === "POST /api/v1/m/categorizer/inbox").length, 1);
	// A PDF can't be a statement to review without its data being read: it is kept for the inbox instead.
	await assert.rejects(bg.deliver(file("oct.pdf"), { dest: "statement", account: "1000" }), (e) => e.misfit === true);
	await assert.rejects(bg.deliver(file("oct.csv"), { dest: "statement" }), /Choose the bank or card account/);
});
