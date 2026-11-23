// The Inbox tab (what the Import module's page was): files from the browser extension, email, the
// scanner, a phone and uploads, each one a document in Ledger. From here a person makes a file a
// statement, a bill or a receipt (in this module, directly), files it in Ledger's Documents as
// what it is, hands it to another module, saves it to Ledger's CSV files, or has the AI read its
// transactions (Extract data: checked and approved before anything is kept).
//
// Loaded before the page's own script; it uses that script's helpers when it runs (api, $, el,
// toast, fail, newAccount, accounts, loadAccounts, bankAccountOptions, withNewAccount, showTab,
// openStatement, openBill). Everything goes into the page with textContent, never as HTML.
"use strict";
const Inbox = (() => {
	/** Ledger's own API (not the module's): JSON, or a form for file uploads. */
	const callLedger = (url, opts = {}) =>
		fetch(url, { ...opts, headers: opts.body instanceof FormData ? {} : { "Content-Type": "application/json", ...(opts.headers || {}) } }).then(async (r) => {
			if (!r.ok) {
				const e = (await r.json().catch(() => ({}))).error;
				throw new Error(e?.details?.map((d) => (d.field ? `${d.field}: ${d.message}` : d.message)).join("; ") || e?.message || r.statusText);
			}
			return r.status === 204 ? null : r.json();
		});
	const size = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB` : `${(b / 1048576).toFixed(1)} MB`);
	const STATEMENT_RE = /\.(csv|tsv|ofx|qfx|qbo|txt)$/i;
	const BILL_RE = /\.(pdf|eml|png|jpe?g|webp|gif)$/i;
	const IMAGE_RE = /\.(jpe?g|png|gif|webp)$/i;
	const TEXT_RE = /\.(txt|text|ofx|qfx|qbo|html?|xml|json|tsv|eml|md|prn)$/i;
	const goLedger = (path) => (window.top.location.href = path); // the page is shown in a frame inside Ledger

	/** Opens a link to something in this module without leaving the page; anything else in Ledger. */
	function follow(link) {
		const m = /^\/apps\/[a-z0-9-]+\?(statement|bill|file)=(\d+)$/.exec(link || "");
		if (m && link.startsWith(`/apps/${moduleId}?`)) {
			if (m[1] === "statement") { showTab("review"); return openStatement(Number(m[2])); }
			if (m[1] === "bill") return openBill(Number(m[2]));
			$("in-filter").value = "all";
			openId = Number(m[2]);
			return load().then(() => document.getElementById(`file-${openId}`)?.scrollIntoView({ block: "center" })).catch(fail);
		}
		goLedger(link);
	}

	// ------------------------------------------------------------- other modules that take files (ctx.files)
	let targets = null; // [{ id, name, accepts }]
	const FILE_KIND_LABEL = { statement: "statement", bill: "bill", receipt: "receipt", transaction: "transaction list", customer: "customer list", vendor: "vendor list", entity: "customer and vendor list" };
	const KIND_FITS = {
		statement: /\.(csv|ofx|qfx|qbo|pdf|txt)$/i,
		transaction: /\.(csv|tsv|json|xml|ofx|qfx|qbo)$/i,
		bill: /\.(pdf|eml|png|jpe?g|webp|heic|gif)$/i,
		receipt: /\.(pdf|eml|png|jpe?g|webp|heic|gif)$/i,
		customer: /\.(csv|tsv)$/i,
		vendor: /\.(csv|tsv)$/i,
		entity: /\.(csv|tsv)$/i,
	};
	async function checkTargets() {
		if (targets !== null) return targets;
		try { targets = (await api("/targets")).data; } catch { targets = []; }
		return targets;
	}
	/** [value, label] choices for handing this file to another module. */
	function moduleOptions(f) {
		const out = [];
		for (const t of targets || []) {
			const fit = t.accepts.filter((k) => KIND_FITS[k]?.test(f.name));
			// Customer and vendor lists only fit list files (CSV); everything else falls back to what the module takes.
			for (const k of fit.length ? fit : t.accepts.filter((k) => !["customer", "vendor", "entity"].includes(k))) out.push([`mod:${t.id}:${k}`, `${t.name}: ${FILE_KIND_LABEL[k] || k}`]);
		}
		return out;
	}

	// ------------------------------------------------------------- AI extraction (Settings → LLM API)
	let ai = null; // { configured, allowed, reads_pdf, reads_images }
	/** "pdf", "image" or "text" when the AI could read transactions out of the file (it isn't a CSV already), else null. */
	function extractable(f) {
		const type = (f.content_type || "").toLowerCase();
		if (/\.csv$/i.test(f.name) || type.startsWith("text/csv")) return null;
		if (/\.pdf$/i.test(f.name) || type.startsWith("application/pdf")) return "pdf";
		if (IMAGE_RE.test(f.name) || /^image\/(jpeg|png|gif|webp)/.test(type)) return "image";
		if (TEXT_RE.test(f.name) || /^(text\/|application\/(json|xml)|message\/rfc822)/.test(type)) return "text";
		return null;
	}
	async function checkAi() {
		if (ai !== null) return ai;
		try { ai = await api("/ai"); } catch { ai = { configured: false, allowed: false, reads_pdf: false, reads_images: false }; }
		return ai;
	}
	/** Whether transactions were read out of the file already (Ledger keeps them with the document). */
	const hasTransactions = (f) => !!f.document?.extracted?.keys?.includes("transactions");

	// ------------------------------------------------------------- inbox
	let files = [];
	let openId = null;
	let me = null; // { role, root, module, name }
	let moduleId = "categorizer";
	let loaded = false;

	async function load() {
		const r = await api(`/inbox?status=${$("in-filter").value}`);
		files = r.data;
		const c = r.counts;
		$("in-counts").textContent = `${c.new || 0} in the inbox · ${c.sent || 0} sent · ${c.archived || 0} archived`;
		setCount(c.new || 0);
		$("in-empty").classList.toggle("hidden", files.length > 0);
		$("in-files").classList.toggle("hidden", files.length === 0);
		await Promise.all([checkAi(), checkTargets(), loadMail(), loadAdoption(), accounts.length ? null : loadAccounts(), api("/me").then((x) => { me = x; moduleId = x.module || moduleId; }, () => (me ??= { role: "viewer" }))]);
		$("in-root-mark").classList.toggle("hidden", !me?.root);
		loaded = true;
		render();
	}
	function setCount(n) {
		$("inbox-count").textContent = String(n);
		$("inbox-count").classList.toggle("hidden", !n);
	}
	/** The number on the Inbox tab, without loading the tab. */
	const loadCount = () => api("/inbox?status=new").then((r) => setCount(r.counts.new || 0)).catch(() => {});

	const TAG_CLASS = { posted: "good", paid: "good", overdue: "bad", billed: "plain", extracted: "plain" };
	const tagPills = (tags) => (tags || []).map((t) => el("span", { class: `pill ${TAG_CLASS[t.tag] || "plain"}`, style: "margin-right:4px", title: t.note || `Ledger's tag on this file: ${t.tag}` }, t.tag === "extracted" ? "data read" : t.tag));

	function render() {
		$("in-files").tBodies[0].replaceChildren(
			...files.map((f) =>
				el("tr", { class: openId === f.id ? "selected" : "", id: `file-${f.id}` },
					el("td", { class: "wide" },
						el("div", { class: "fname" }, f.name),
						f.note ? el("div", { class: "muted small" }, f.note) : null,
						f.account_code ? el("div", { class: "muted small" }, "Account chosen on the phone: ", el("strong", {}, typeof accountLabel === "function" ? accountLabel(f.account_code) : f.account_code)) : null,
						f.document && !f.missing ? el("div", { class: "muted small" },
							`In Ledger's Documents${f.document.kind !== "other" ? ` as ${f.document.kind === "invoice" ? "an invoice" : `a ${f.document.kind}`}` : ""}${f.document.account_code ? ` for ${f.document.account_code}${f.document.account_name ? ` · ${f.document.account_name}` : ""}` : ""}${f.document.reconciled ? ", reconciled" : ""} `,
							...tagPills(f.document.tags)) : null,
						f.status === "sent" ? el("div", { class: "small" }, f.statement_id || f.bill_id ? "Became " : "Sent to ", f.sent_link ? el("a", { href: "#", onclick: (e) => { e.preventDefault(); follow(f.sent_link); } }, f.sent_to) : f.sent_to, f.sent_by ? ` by ${f.sent_by}` : "") : null,
						f.handoff ? el("div", { class: `small ${f.handoff.status === "rejected" ? "bad" : "muted"}` }, HANDOFF[f.handoff.status] || f.handoff.status, f.handoff.result ? `: ${f.handoff.result}` : "") : null,
						actions(f),
						f.pending_extraction && reviewId !== f.pending_extraction ? el("div", { class: "small review-note" }, "The AI read data from this file. ", el("a", { href: "#", onclick: (e) => { e.preventDefault(); openReview(f.pending_extraction); } }, "Check and approve it")) : null,
						reviewId && review && review.file_id === f.id ? reviewPanel() : null,
						deletingId === f.id ? deletePanel(f) : null,
						openId === f.id && !(review && review.file_id === f.id) ? forwardPanel(f) : null,
					),
					el("td", { class: "num" }, size(Number(f.size_bytes))),
					el("td", { class: "small" }, fromCell(f)),
					el("td", { class: "small" }, new Date(f.received_at).toLocaleString(), el("div", { class: "muted" }, f.received_by)),
					el("td", {}, el("span", { class: `pill ${f.status === "new" ? "warn" : f.status === "sent" ? "good" : "plain"}` }, f.status === "new" ? "In inbox" : f.status === "sent" ? "Sent" : "Archived")),
				),
			),
		);
	}

	function fromCell(f) {
		if (f.source_url) {
			let host = f.source_url;
			try { host = new URL(f.source_url).host; } catch {} // not an address after all: shown as it is
			return el("span", { title: f.source_url }, host);
		}
		const what = { email: "email", scanner: "scanner", camera: "phone camera", upload: "uploaded", app: "phone app" }[f.origin];
		if (!what) return el("span", { class: "muted" }, "dropped file");
		return el("span", { title: f.origin_detail || what }, what, f.origin_detail ? el("div", { class: "muted" }, f.origin_detail) : null);
	}

	// ------------------------------------------------------------- deleting an email file teaches the email check
	/**
	 * Deletes an inbox file for good. Its document in Ledger's Documents goes with it; one the Import
	 * module filed isn't the module's to remove, so the page removes it as the person asking.
	 */
	async function removeFile(f, learn = false) {
		const r = await api(`/inbox/${f.id}${learn ? "?learn=1" : ""}`, { method: "DELETE" });
		if (r?.delete_document != null) {
			const res = await fetch(`/api/v1/documents/${encodeURIComponent(r.delete_document)}`, { method: "DELETE", headers: { "Content-Type": "application/json" } });
			if (!res.ok && res.status !== 404) toast(`${f.name} is gone from the inbox, but its file is still under Documents (${res.status}); delete it there.`);
		}
		return r;
	}

	let deletingId = null;
	function deletePanel(f) {
		const del = async (learn) => {
			try {
				const r = await removeFile(f, learn);
				deletingId = null;
				toast(r?.learned ? `Deleted. Email import will skip files like ${f.name} from ${f.origin_detail || "this sender"}.` : `Deleted ${f.name}.`);
				await load();
			} catch (e) { fail(e); }
		};
		return el("div", { class: "panel forward small" },
			el("div", {}, `Delete ${f.name}?`),
			el("div", { class: "muted", style: "margin-top:0.2rem" }, `It came from email${f.origin_detail ? ` (${f.origin_detail})` : ""}. "Delete and learn" teaches the email check that files like this aren't wanted, so later ones from this sender are skipped. Use "Just delete" for a duplicate or a one-off.`),
			el("div", { class: "actions" },
				el("button", { class: "btn danger", onclick: () => del(true) }, "Delete and learn"),
				el("button", { class: "btn", onclick: () => del(false) }, "Just delete"),
				el("button", { class: "btn", onclick: () => { deletingId = null; render(); } }, "Cancel")),
		);
	}

	const HANDOFF = { new: "Waiting for the module", accepted: "Being processed", done: "Done", rejected: "Rejected" };

	function actions(f) {
		const b = (text, fn, cls = "btn") => el("button", { class: cls, onclick: fn }, text);
		const drop = () => removeFile(f).then(load, fail);
		if (f.missing) {
			// Removed on Ledger's Documents page, or after a restore from a dump file, which brings back only the tables.
			return el("div", {},
				el("div", { class: "small bad" }, "The file itself is missing (removed on Ledger's Documents page, or a restore from a dump file, which brings back only the list). Delete it here, or restore a full backup."),
				el("div", { class: "actions" }, b("Delete", () => confirm(`Delete ${f.name} from the list?`) && drop(), "btn danger")));
		}
		const viewer = me?.role === "viewer";
		return el("div", { class: "actions" },
			viewer ? null : b(f.status === "sent" ? "Send again…" : "Send…", () => { openId = openId === f.id ? null : f.id; render(); }, f.status === "new" ? "btn primary" : "btn"),
			viewable(f) ? b("Open", () => window.open(f.url, "_blank", "noopener")) : null,
			isEml(f) ? b("View email", () => MailView.open({ file: f.id })) : null,
			b("Download", () => download(f)),
			hasTransactions(f) && !/\.csv$/i.test(f.name) ? b("CSV of its transactions", () => downloadCsv(f).catch(fail)) : null,
			viewer ? null : f.status === "archived" ? b("Back to inbox", () => patch(f, { status: "new" })) : b("Archive", () => patch(f, { status: "archived" })),
			me?.root ? b("Root: delete", () => confirm(`Root mode: delete ${f.name} from the inbox? It can be put back from Ledger's Root log; its document stays.`) && drop(), "btn root") : null,
			me?.root || viewer ? null : b("Delete", () => {
				if (!f.learnable) return confirm(`Delete ${f.name}?`) && drop();
				deletingId = deletingId === f.id ? null : f.id;
				render();
			}, "btn danger"),
		);
	}

	// ------------------------------------------------------------- looking at a file (and its email) before sending it on
	const isEml = (f) => /^message\/rfc822\b/i.test(f.content_type || "") || /\.eml$/i.test(f.name);
	const hasEmail = (f) => isEml(f) || !!f.mail_uid;
	const previews = new Map(); // file id → its preview, kept across re-renders so a PDF isn't loaded again
	function previewOf(f) {
		if (!viewable(f)) return null;
		const key = `${f.id} ${f.url}`;
		if (previews.has(key)) return previews.get(key);
		const image = /^image\//.test(f.content_type || "") || IMAGE_RE.test(f.name);
		const det = el("details", { open: true },
			el("summary", {}, "Preview"),
			image ? el("img", { src: f.url, alt: f.name, loading: "lazy" }) : el("iframe", { src: f.url, title: `Preview of ${f.name}`, loading: "lazy" }));
		previews.set(key, det);
		return det;
	}
	/** The top of the Send panel: the document itself, and the email it is or came from. */
	function lookPanel(f) {
		const preview = previewOf(f);
		const email = hasEmail(f)
			? el("div", { class: "row" },
				el("button", { class: "btn", onclick: () => MailView.open({ file: f.id }) }, isEml(f) ? "View the email" : "View the email it came from"),
				el("span", { class: "muted" }, isEml(f) ? "Read it before sending it on." : `From ${f.origin_detail || "email"}: read it before sending this file on.`))
			: null;
		if (!preview && !email) return null;
		return el("div", { class: "look" }, preview, email);
	}

	function forwardPanel(f) {
		const box = el("div", { class: "panel forward small" });
		const look = lookPanel(f);
		if (look) box.append(look);
		const read = hasTransactions(f);
		const opts = [];
		// In this module, directly: a statement (its lines to review and post), a bill or a receipt.
		if (STATEMENT_RE.test(f.name) || read) opts.push(["statement", read && !STATEMENT_RE.test(f.name) ? "Statement: review and post the transactions read from it" : "Statement: review and post its transactions"]);
		const billish = BILL_RE.test(f.name) || /^(application\/pdf|image\/|message\/rfc822)/.test(f.content_type || "");
		if (billish) {
			const pair = [["bill", "Bill: track it until it is paid"], ["receipt", "Receipt: already paid, matched to its payment"]];
			// A photographed receipt is most likely a receipt.
			if (f.origin === "camera" || f.origin === "app") pair.reverse();
			opts.push(...pair);
			// A supplier's statement of account isn't a bill: it is reconciled against the vendor's account in Ledger.
			opts.push(["vendor_statement", "Vendor statement: a supplier's statement of account, to reconcile"]);
		}
		opts.push(...moduleOptions(f));
		if (/\.csv$/i.test(f.name) || read) opts.push(["ledger-file", read && !/\.csv$/i.test(f.name) ? "Ledger's CSV files: a CSV of its transactions (journal import)" : "Ledger's CSV files (journal import)"]);
		// Every file is in Ledger's Documents: say what it is there, where Reconcile and modules pick it up.
		for (const k of ["receipt", "statement", "invoice"]) opts.push([`doc:${k}`, `Ledger's Documents: file it as ${k === "invoice" ? "an invoice or bill" : `a ${k}`}`]);
		const kind = extractable(f);
		let aiHint = null;
		if (kind && ai) {
			const can = kind === "text" ? ai.configured : kind === "image" ? ai.reads_images : ai.reads_pdf || ai.reads_images;
			if (!ai.configured && !ai.reads_images) aiHint = "To have the AI read its transactions, an admin can set up an LLM connection under Settings → LLM API.";
			else if (!ai.allowed) aiHint = `To have the AI read its transactions, an admin can allow ${moduleName} under Settings → LLM API.`;
			else if (!can) aiHint = kind === "text" ? "There's no LLM connection for text under Settings → LLM API, so the AI can't read its transactions here." : "There's no LLM connection for images and documents under Settings → LLM API, so the AI can't read its transactions here.";
			else opts.push(["extract", read ? "Read its transactions again with the AI" : "Extract data: its transactions, read by the AI"]);
		}
		const dest = el("select", {}, ...opts.map(([v, t]) => el("option", { value: v }, t)));
		const account = el("select", {});
		bankAccountOptions(account, "Choose the bank or card account…");
		withNewAccount(account, { type: "asset", currency: "CAD" }, (a) => { if (a.type !== "asset" && a.type !== "liability") toast(`${a.code} · ${a.name} was created, but statements need a bank or card account (asset or liability).`, true); pickFlip(); });
		const flipLabel = el("label", { class: "inline" });
		const flip = el("input", { type: "checkbox" });
		flipLabel.append(flip, "Purchases show as positive amounts (flip signs)");
		const dateOrder = el("select", { title: "How dates like 03/04/2026 are read" }, el("option", { value: "auto" }, "Dates: detect"), el("option", { value: "mdy" }, "Month/Day/Year"), el("option", { value: "dmy" }, "Day/Month/Year"));
		const stmt = el("div", { class: "row", style: "margin-top:0.4rem" }, account, dateOrder, flipLabel);
		const pickFlip = () => (flip.checked = accounts.find((a) => a.code === account.value)?.type === "liability" && /\.csv$/i.test(f.name));
		account.addEventListener("change", pickFlip);
		const instructions = el("input", { type: "text", maxlength: "1000", placeholder: "Optional hints, e.g. “only the chequing account”", style: "flex:1;min-width:12rem" });
		const ext = el("div", { style: "margin-top:0.4rem" },
			el("div", { class: "row" }, instructions),
			el("div", { class: "muted", style: "margin-top:0.3rem" }, "You'll check what the AI read, and correct it, before anything is kept. When you approve, the transactions are saved with the file in Ledger's Documents, and you can stage them as a statement straight away."),
		);
		const hint = el("div", { class: "muted", style: "margin-top:0.4rem" });
		const HINTS = {
			statement: read && !STATEMENT_RE.test(f.name) ? "Its transactions were read before and are kept with the file: they are staged as they are, nothing is read again." : "Its lines are staged on the Statements tab. Nothing is posted until you review them and press Post.",
			bill: read || f.document?.extracted ? "What was read from it before is used. It lands on the Bills tab as Needs review." : "The AI reads the vendor, amount and dates. It lands on the Bills tab as Needs review: you approve it.",
			vendor_statement: "The AI reads the vendor, the date, the balance and the statement's lines. It lands on the Statements tab, marked as a vendor statement, where you check it and press Reconcile to compare it with the vendor's account in Ledger. No bill is made and nothing is posted.",
			receipt: read || f.document?.extracted ? "What was read from it before is used. It lands on the Receipts tab as Needs review." : "The AI reads the vendor, amount and date. It lands on the Receipts tab as Needs review: you approve it.",
		};
		const sync = () => {
			const v = dest.value;
			const forStatement = v === "statement" || /^mod:[^:]+:statement$/.test(v) || v === "doc:statement";
			stmt.classList.toggle("hidden", !forStatement);
			flipLabel.classList.toggle("hidden", v !== "statement");
			dateOrder.classList.toggle("hidden", v !== "statement" || !STATEMENT_RE.test(f.name));
			ext.classList.toggle("hidden", v !== "extract");
			hint.textContent = HINTS[v] || "";
			go.textContent = v === "extract" ? (read ? "Read again" : "Extract") : v === "statement" ? "Stage the statement" : v === "bill" || v === "receipt" || v === "vendor_statement" ? "Read it" : "Send";
		};
		dest.onchange = sync;
		const go = el("button", { class: "btn primary", onclick: async () => {
			go.disabled = true;
			const label = go.textContent;
			if (dest.value === "extract" || dest.value === "bill" || dest.value === "receipt" || dest.value === "vendor_statement") go.textContent = "Reading… (up to a few minutes)";
			try {
				if (dest.value === "extract") await extract(f, instructions.value, read);
				else if (dest.value.startsWith("mod:")) await handoff(f, dest.value, account.value);
				else if (dest.value.startsWith("doc:")) await fileAs(f, dest.value.slice(4), account.value);
				else await forward(f, dest.value, { account: account.value, flip: flip.checked, dateOrder: dateOrder.value });
			} catch (e) { fail(e); } finally { go.disabled = false; go.textContent = label; }
		} }, "Send");
		sync();
		box.append(el("div", { class: "row" }, el("label", { class: "inline" }, el("span", { style: "white-space:nowrap" }, "Make it"), dest)), stmt, ext, hint, el("div", { style: "margin-top:0.5rem" }, go));
		if (aiHint) box.append(el("div", { class: "muted", style: "margin-top:0.4rem" }, aiHint));
		return box;
	}

	/** Date,Description,Amount[,Balance] with quoting, and text cells guarded against spreadsheet formulas. */
	function toCsv(rows) {
		const withBalance = rows.some((t) => t.balance !== "");
		const cell = (s) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
		const text = (s) => cell(s !== "" && "=+-@\t\r".includes(s[0]) ? "'" + s : s);
		const lines = [withBalance ? "Date,Description,Amount,Balance" : "Date,Description,Amount"];
		for (const t of rows) lines.push([t.date, text(t.description), t.amount, ...(withBalance ? [t.balance] : [])].join(","));
		return lines.join("\r\n") + "\r\n";
	}
	const csvName = (name) => `${name.replace(/\.[^.]*$/, "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+|[-.]+$/g, "").slice(0, 100) || "file"}-extracted.csv`;
	/** The transactions read out of a file, as a CSV file (made here, in the browser: nothing new is stored). */
	async function csvOf(f) {
		const t = await api(`/inbox/${f.id}/transactions`);
		if (!t.rows.length) throw new Error("No transactions were read from this file.");
		return new File([toCsv(t.rows)], csvName(f.name), { type: "text/csv" });
	}
	async function downloadCsv(f) {
		const file = await csvOf(f);
		const url = URL.createObjectURL(file);
		el("a", { href: url, download: file.name }).click();
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
	}

	/**
	 * Something like this file is already here: show it and let the person decide. Resolves to
	 * { action: "add" } (add it anyway), { action: "same", id } (it's that one: add nothing),
	 * { action: "open", id } or null (cancelled).
	 */
	function askSimilar(sim) {
		return new Promise((resolve) => {
			const dlg = el("dialog", { class: "similar-dialog" });
			const done = (v) => { dlg.close(); dlg.remove(); resolve(v); };
			dlg.addEventListener("cancel", (e) => { e.preventDefault(); done(null); });
			const amount = (c, cur) => (c == null ? "—" : `${money(c)}${cur ? ` ${cur}` : ""}`);
			const parts = [];
			if (sim.kind === "bill") {
				const x = sim.reading;
				const what = x.kind === "receipt" ? "receipt" : "bill";
				const anySame = sim.matches.some((m) => m.same);
				parts.push(
					el("h2", { style: "margin-top:0" }, anySame ? `This ${what} looks like one that's already here` : `A similar ${what} is already here`),
					el("p", { class: "small" }, "This file: ", el("strong", {}, x.vendor || "(no vendor read)"), x.invoice_number ? ` · ${x.invoice_number}` : "", ` · ${x.bill_date || x.due_date || "no date"} · ${amount(x.amount_cents, x.currency)}`),
					el("p", { class: "small muted" }, "Already here:"),
					el("div", { class: "table-wrap" }, el("table", { class: "stack" }, el("tbody", {}, ...sim.matches.map((m) => {
						const b = m.bill;
						const label = b.kind === "receipt" ? "Receipt" : "Bill";
						return el("tr", {},
							el("td", {}, el("span", { class: `pill ${m.same ? "bad" : "warn"}` }, m.same ? "Same?" : "Similar")),
							el("td", { class: "wide" }, `${label} #${b.id}: `, el("strong", {}, b.vendor || "(unknown)"), b.invoice_number ? ` · ${b.invoice_number}` : "", el("div", { class: "small muted" }, `${b.bill_date || b.due_date || "no date"} · ${b.status === "new" ? "needs review" : b.status}`)),
							el("td", { class: "num nowrap" }, amount(b.amount_cents, b.currency)),
							el("td", { class: "nowrap" },
								el("button", { class: "btn", type: "button", onclick: () => done({ action: "open", id: b.id }) }, "Open"), " ",
								el("button", { class: "btn", type: "button", title: `Add nothing: this file is that ${label.toLowerCase()}`, onclick: () => done({ action: "same", id: b.id }) }, "It's this one")),
						);
					})))),
					el("div", { class: "row", style: "margin-top:0.75rem" },
						el("button", { class: "btn primary", type: "button", onclick: () => done({ action: "add" }) }, `Add it as a new ${what}`),
						el("button", { class: "btn", type: "button", onclick: () => done(null) }, "Cancel")),
					el("p", { class: "small muted" }, "What was read is kept: adding it doesn't ask the AI again."),
				);
			} else {
				const allSame = sim.same === sim.total && sim.statements.length === 1;
				parts.push(
					el("h2", { style: "margin-top:0" }, `${sim.count} of ${sim.total} transaction${sim.total === 1 ? "" : "s"} ${sim.count === 1 ? "is" : "are"} already here`),
					el("p", { class: "small" }, sim.same ? `${sim.same} ${sim.same === 1 ? "was" : "were"} uploaded before and will be skipped. ` : "", sim.similar ? `${sim.similar} ${sim.similar === 1 ? "has" : "have"} the same date and amount as a line already here (it would be added; check Duplicates afterwards).` : ""),
					el("p", { class: "small muted" }, "On: ", ...sim.statements.flatMap((st, i) => [i ? ", " : "", el("a", { href: "#", onclick: (e) => { e.preventDefault(); done({ action: "open", id: Number(st.id) }); } }, st.filename), ` (${st.n})`])),
					el("div", { class: "table-wrap" }, el("table", { class: "stack" },
						el("thead", {}, el("tr", {}, el("th", {}, "In this file"), el("th", {}, "Already here"), el("th", {}, ""))),
						el("tbody", {}, ...sim.examples.map((x) => el("tr", {},
							el("td", { class: "wide" }, `${x.incoming.date} · ${amount(x.incoming.amount_cents)}`, el("div", { class: "small" }, x.incoming.description)),
							el("td", { class: "wide" }, `${x.existing.date} · ${amount(x.existing.amount_cents)} · ${x.existing.status === "new" ? "not posted" : x.existing.status}`, el("div", { class: "small" }, x.existing.description), el("div", { class: "small muted" }, x.existing.filename)),
							el("td", {}, el("span", { class: `pill ${x.same ? "bad" : "warn"}` }, x.same ? "Same" : "Similar"))))))),
					sim.count > sim.examples.length ? el("p", { class: "small muted" }, `and ${sim.count - sim.examples.length} more.`) : "",
					el("div", { class: "row", style: "margin-top:0.75rem" },
						allSame ? el("button", { class: "btn primary", type: "button", title: "Add nothing: this file is that statement", onclick: () => done({ action: "same", id: Number(sim.statements[0].id) }) }, "It's the same statement") : "",
						sim.same < sim.total ? el("button", { class: allSame ? "btn" : "btn primary", type: "button", onclick: () => done({ action: "add" }) }, sim.same ? "Stage it (lines uploaded before are skipped)" : "Stage it anyway") : "",
						el("button", { class: "btn", type: "button", onclick: () => done(null) }, "Cancel")),
				);
			}
			dlg.append(...parts);
			document.body.append(dlg);
			dlg.showModal();
		});
	}

	async function forward(f, dest, { account, flip, dateOrder }) {
		if (dest === "statement") {
			if (!account) throw new Error("Choose the bank or card account the statement is for.");
			const body = { account_code: account, flip_signs: flip, date_order: dateOrder };
			let r = await api(`/inbox/${f.id}/statement`, { method: "POST", body: JSON.stringify({ ...body, check_similar: true }) });
			if (r.similar) {
				const choice = await askSimilar(r.similar);
				if (!choice) return;
				if (choice.action === "open") { showTab("review"); return openStatement(choice.id); }
				if (choice.action === "same") {
					await api(`/inbox/${f.id}/same-as`, { method: "POST", body: JSON.stringify({ statement_id: choice.id }) });
					openId = null;
					toast("Nothing added: marked as the statement that's already here.");
					loadCount();
					return load();
				}
				r = await api(`/inbox/${f.id}/statement`, { method: "POST", body: JSON.stringify(body) });
			}
			openId = null;
			const s = r.statement;
			toast(`${s.transactions} transactions staged${s.duplicates ? `, ${s.duplicates} already uploaded before were skipped` : ""}${s.from_extraction ? " (from what was read before)" : ""}.` + (s.warnings.length ? `\n${s.warnings.slice(0, 3).join("\n")}` : ""));
			loadCount();
			showTab("review");
			return openStatement(s.id);
		}
		if (dest === "bill" || dest === "receipt" || dest === "vendor_statement") {
			let r = await api(`/inbox/${f.id}/bill`, { method: "POST", body: JSON.stringify({ kind: dest, check_similar: true }) });
			if (r.similar) {
				const choice = await askSimilar(r.similar);
				if (!choice) return;
				if (choice.action === "open") return openBill(choice.id);
				if (choice.action === "same") {
					await api(`/inbox/${f.id}/same-as`, { method: "POST", body: JSON.stringify({ bill_id: choice.id }) });
					openId = null;
					toast(`Nothing added: marked as the ${dest} that's already here.`);
					loadCount();
					return load();
				}
				r = await api(`/inbox/${f.id}/bill`, { method: "POST", body: JSON.stringify({ kind: dest, confirm: true }) });
			}
			openId = null;
			// A supplier's statement of account (read as one, or said to be): no bill is made.
			if (r.bill.kind === "vendor_statement") {
				toast(dest === "vendor_statement" ? "Kept as a vendor statement, on the Statements tab. Check it, then press Reconcile." : "This is a vendor's statement of account, not a bill: it is on the Statements tab. Check it, then press Reconcile.");
				loadCount();
				return VendorStatements.open(r.bill.id);
			}
			toast(r.bill.read === "extracted" ? "Made from what was read before; the AI wasn't asked again. Check it, then approve." : "Read. Check it, then approve.");
			loadCount();
			return openBill(r.bill.id);
		}
		// Ledger's CSV files: the file itself, or a CSV of the transactions read out of it.
		const csv = /\.csv$/i.test(f.name) ? new File([await (await fetch(f.url)).blob()], f.name, { type: "text/csv" }) : await csvOf(f);
		const fd = new FormData();
		fd.append("file", csv, csv.name);
		await callLedger("/api/v1/files", { method: "POST", body: fd });
		await api(`/inbox/${f.id}/sent`, { method: "POST", body: JSON.stringify({ to: "Ledger's CSV files", link: "/files" }) });
		openId = null;
		toast("Sent: Ledger's CSV files.");
		await load();
	}

	async function fileAs(f, kind, account) {
		const r = await api(`/inbox/${f.id}/file-as`, { method: "POST", body: JSON.stringify({ kind, ...(kind === "statement" && account ? { account_code: account } : {}) }) });
		openId = null;
		toast(`Filed in ${r.sent_to}${kind === "statement" && account ? ` for account ${account}` : ""}.`);
		await load();
	}

	async function handoff(f, value, account) {
		const [, to, kind] = value.split(":");
		const r = await api(`/inbox/${f.id}/handoff`, { method: "POST", body: JSON.stringify({ to, kind, ...(kind === "statement" && account ? { account_code: account } : {}) }) });
		openId = null;
		toast(`Sent: ${r.sent_to}.`);
		await load();
	}

	async function extract(f, instructions, again) {
		const body = { ...(instructions.trim() ? { instructions: instructions.trim() } : {}), ...(again ? { reread: true } : {}) };
		const r = await api(`/inbox/${f.id}/extract`, { method: "POST", body: JSON.stringify(body) });
		openId = null;
		review = r;
		reviewId = r.id;
		toast(`The AI read ${r.rows.length} transaction${r.rows.length === 1 ? "" : "s"}. Check them, then approve.`);
		await load();
	}

	// ------------------------------------------------------------- reviewing what the AI read (nothing is kept until approved)
	let reviewId = null; // the extraction being reviewed
	let review = null; // { id, file_id, rows, currency, ... }, rows edited in place
	async function openReview(id) {
		try {
			review = await api(`/extractions/${id}`);
			reviewId = id;
			openId = null;
			render();
			document.getElementById(`file-${review.file_id}`)?.scrollIntoView({ block: "start" });
		} catch (e) { fail(e); }
	}
	const closeReview = () => { review = null; reviewId = null; };

	function reviewPanel() {
		const r = review;
		const input = (row, key, attrs) => el("input", { ...attrs, value: row[key], "aria-label": key, oninput: (e) => (row[key] = e.target.value) });
		const body = el("tbody");
		const draw = () => body.replaceChildren(...r.rows.map((row, i) => el("tr", {},
			el("td", {}, input(row, "date", { type: "text", size: "10", placeholder: "YYYY-MM-DD", class: "cell-date" })),
			el("td", { class: "wide" }, input(row, "description", { type: "text", class: "cell-desc", placeholder: "Description" })),
			el("td", { class: "num" }, input(row, "amount", { type: "text", inputmode: "decimal", size: "9", class: "cell-num", placeholder: "Amount" })),
			el("td", { class: "num" }, input(row, "balance", { type: "text", inputmode: "decimal", size: "9", class: "cell-num", placeholder: "Balance" })),
			el("td", {}, el("button", { class: "btn small-btn", title: "Remove this row", "aria-label": "Remove row", onclick: () => { r.rows.splice(i, 1); draw(); } }, "×")),
		)));
		draw();
		const approve = el("button", { class: "btn primary", onclick: async () => {
			approve.disabled = true;
			try {
				const out = await api(`/extractions/${r.id}/approve`, { method: "POST", body: JSON.stringify({ rows: r.rows.map(({ date, description, amount, balance }) => ({ date, description, amount, balance: balance ?? "" })) }) });
				closeReview();
				toast(`Approved: ${out.transactions} transaction${out.transactions === 1 ? "" : "s"} saved with ${out.name}. Choose its account to stage them as a statement.`);
				$("in-filter").value = out.status === "new" ? "new" : "all";
				openId = out.id; // its Send panel, with Statement on top
				await load();
				document.getElementById(`file-${out.id}`)?.scrollIntoView({ block: "center" });
			} catch (e) { fail(e); approve.disabled = false; }
		} }, "Approve");
		const reject = el("button", { class: "btn danger", onclick: async () => {
			try {
				await api(`/extractions/${r.id}/reject`, { method: "POST", body: "{}" });
				closeReview();
				toast("Rejected. Nothing was kept.");
				await load();
			} catch (e) { fail(e); }
		} }, "Reject");
		return el("div", { class: "panel forward small" },
			el("div", {}, el("strong", {}, "Check what the AI read"), ` · ${r.rows.length} transactions${r.currency ? ` in ${r.currency}` : ""}`),
			el("div", { class: "muted", style: "margin:0.2rem 0 0.4rem" }, "Correct anything wrong, remove rows that aren't transactions, then approve. Amounts: negative is money out. Nothing is kept until you approve; then the transactions are saved with the file in Ledger's Documents, for every module."),
			el("div", { class: "review-wrap" }, el("table", { class: "review" },
				el("thead", {}, el("tr", {}, el("th", {}, "Date"), el("th", {}, "Description"), el("th", { class: "num" }, "Amount"), el("th", { class: "num" }, "Balance"), el("th", {}))),
				body)),
			el("div", { class: "actions" },
				el("button", { class: "btn", onclick: () => { r.rows.push({ date: "", description: "", amount: "", balance: "" }); draw(); } }, "Add a row"),
				el("span", { class: "spacer" }),
				reject,
				el("button", { class: "btn", onclick: () => { closeReview(); render(); } }, "Later"),
				approve),
		);
	}

	// Files open and download straight from Ledger's Documents. What browsers show in a tab (CSV is
	// left out: browsers usually download it anyway).
	const VIEWABLE = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain)/;
	const viewable = (f) => f.url && (VIEWABLE.test(f.content_type || "") || /\.(pdf|png|jpe?g|gif|webp|txt)$/i.test(f.name)) && !/\.csv$/i.test(f.name);
	function download(f) {
		if (!f.url) return toast("The file itself is missing.", true);
		el("a", { href: `${f.url}?download=1`, download: f.name }).click();
	}

	const patch = (f, body) => api(`/inbox/${f.id}`, { method: "PATCH", body: JSON.stringify(body) }).then(load, fail);

	const b64 = (bytes) => { let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
	/** Uploads bytes to the inbox in pieces, as the extension and the phone app do → the file (a document in Ledger). */
	async function uploadBytes(name, type, bytes, origin = "upload", extra = {}) {
		const { id, chunk_size } = await api("/inbox", { method: "POST", body: JSON.stringify({ name, content_type: type, size: bytes.length, origin, ...extra }) });
		for (let i = 0, k = 0; i < bytes.length; i += chunk_size, k++) {
			await api(`/inbox/${id}/chunks/${k}`, { method: "PUT", body: JSON.stringify({ data: b64(bytes.subarray(i, i + chunk_size)) }) });
		}
		return api(`/inbox/${id}/complete`, { method: "POST", body: "{}" });
	}
	/** A file's name as the inbox takes it: no folders or control characters, at most 255 characters. */
	const safeName = (name) => String(name || "").replace(/[\u0000-\u001f/\\]/g, "-").trim().slice(-255) || "file";

	// ------------------------------------------------------------- the extension, zipped in the browser
	const EXT_FILES = ["manifest.json", "background.js", "popup.html", "popup.js", "options.html", "options.js", "style.css", "README.md", "defaults.json", "icons/icon-48.png", "icons/icon-128.png"];
	const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
	const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
	/** A ZIP of [{ name, data: Uint8Array }] with stored (uncompressed) entries. */
	function zip(entries) {
		const enc = new TextEncoder();
		const parts = [];
		const central = [];
		let offset = 0;
		for (const { name, data } of entries) {
			const n = enc.encode(name);
			const crc = crc32(data);
			const local = new DataView(new ArrayBuffer(30));
			local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(8, 0, true);
			local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, n.length, true);
			parts.push(new Uint8Array(local.buffer), n, data);
			const cen = new DataView(new ArrayBuffer(46));
			cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true);
			cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, data.length, true); cen.setUint16(28, n.length, true); cen.setUint32(42, offset, true);
			central.push(new Uint8Array(cen.buffer), n);
			offset += 30 + n.length + data.length;
		}
		const total = central.reduce((s, p) => s + p.length, 0);
		const end = new DataView(new ArrayBuffer(22));
		end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true); end.setUint32(12, total, true); end.setUint32(16, offset, true);
		return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: "application/zip" });
	}
	async function downloadExtension() {
		$("in-ext-msg").textContent = "Preparing…";
		try {
			const entries = await Promise.all(EXT_FILES.map(async (f) => {
				const r = await fetch(`extension/${f}`);
				if (!r.ok) throw new Error(`extension/${f}: ${r.status}`);
				// This Ledger's address goes in, so the extension knows where to send without being told.
				if (f === "defaults.json") return { name: `send-to-ledger/${f}`, data: new TextEncoder().encode(JSON.stringify({ ledgerUrl: location.origin }, null, 2) + "\n") };
				return { name: `send-to-ledger/${f}`, data: new Uint8Array(await r.arrayBuffer()) };
			}));
			const url = URL.createObjectURL(zip(entries));
			el("a", { href: url, download: "send-to-ledger.zip" }).click();
			setTimeout(() => URL.revokeObjectURL(url), 10_000);
			$("in-ext-msg").textContent = "Downloaded send-to-ledger.zip.";
		} catch (e) { $("in-ext-msg").textContent = ""; fail(e); }
	}

	// ------------------------------------------------------------- What the email check learned, and the training file
	async function toggleTraining(force) {
		const box = $("in-training");
		if (!force && !box.classList.contains("hidden")) return box.classList.add("hidden");
		box.classList.remove("hidden");
		box.replaceChildren(el("span", { class: "muted" }, "Loading…"));
		let t, sk;
		try { [t, sk] = await Promise.all([api("/training"), api("/mail/skipped")]); } catch (e) { box.replaceChildren(); return fail(e); }
		const forget = async (body, what) => {
			if (!confirm(`Forget ${what}?`)) return;
			try { const r = await api("/training/forget", { method: "POST", body: JSON.stringify(body) }); toast(`Forgot ${r.forgotten} example${r.forgotten === 1 ? "" : "s"}.`); toggleTraining(true); } catch (e) { fail(e); }
		};
		const save = async () => {
			try {
				const file = await api("/training/file");
				const url = URL.createObjectURL(new Blob([JSON.stringify(file, null, 1)], { type: "application/json" }));
				el("a", { href: url, download: `email-training-${new Date().toISOString().slice(0, 10)}.json` }).click();
				setTimeout(() => URL.revokeObjectURL(url), 10_000);
			} catch (e) { fail(e); }
		};
		const loader = el("input", { type: "file", accept: "application/json,.json", class: "visually-hidden", onchange: async (e) => {
			const file = e.target.files[0];
			e.target.value = "";
			if (!file) return;
			try {
				const r = await api("/training/file", { method: "POST", body: await file.text() });
				toast(`Loaded ${r.added} example${r.added === 1 ? "" : "s"}${r.skipped ? ` (${r.skipped} already known)` : ""}.`);
				toggleTraining(true);
			} catch (err) { fail(err); }
		} });
		const importAnyway = async (row, btn) => {
			btn.disabled = true;
			try {
				const r = await api("/mail/skipped/import", { method: "POST", body: JSON.stringify({ folder: row.folder, uid: row.uid }) });
				toast(r.files ? `Imported ${r.files} file${r.files === 1 ? "" : "s"}; files like ${r.files === 1 ? "it" : "them"} count as wanted now.` : "Its files are already in the inbox.");
				$("in-filter").value = "new";
				await load();
				toggleTraining(true);
			} catch (e) { fail(e); btn.disabled = false; }
		};
		const total = t.deleted + t.kept;
		box.replaceChildren(...[
			el("div", { class: "row" }, el("strong", {}, "What the email check learned"), el("span", { class: "spacer" }), el("button", { class: "btn small-btn", "aria-label": "Close", onclick: () => box.classList.add("hidden") }, "×")),
			el("div", { class: "muted", style: "margin:0.2rem 0 0.5rem" }, total
				? `From ${t.deleted} file${t.deleted === 1 ? "" : "s"} you deleted with "Delete and learn" and ${t.kept} you sent on. Later emails with files like the deleted ones, from the same sender, are skipped (listed below, so you can import them anyway).`
				: 'Nothing yet. When you delete a file that came from email, choose "Delete and learn" and later files like it from that sender are skipped. Files you send on count as wanted.'),
			t.senders.length ? el("table", { class: "review" },
				el("thead", {}, el("tr", {}, el("th", {}, "Sender"), el("th", { class: "num" }, "Deleted"), el("th", { class: "num" }, "Kept"), el("th", {}))),
				el("tbody", {}, ...t.senders.map((r) => el("tr", {},
					el("td", { class: "wide" }, r.sender), el("td", { class: "num" }, String(r.deleted)), el("td", { class: "num" }, String(r.kept)),
					el("td", {}, el("button", { class: "btn small-btn", onclick: () => forget({ sender: r.sender }, `what was learned about ${r.sender}`) }, "Forget")))))) : null,
			sk.data.length ? el("div", { style: "margin-top:0.6rem" }, el("strong", {}, "Skipped emails"),
				...sk.data.map((row) => {
					const btn = el("button", { class: "btn small-btn" }, "Import anyway");
					btn.onclick = () => importAnyway(row, btn);
					const view = el("button", { class: "btn small-btn", onclick: () => MailView.open({ id: row.uid, folder: row.folder, onDone: afterMailView(() => toggleTraining(true)) }) }, "View");
					return el("div", { class: "row", style: "margin-top:0.3rem;align-items:flex-start" },
						el("div", { style: "flex:1;min-width:12rem" }, el("div", {}, row.subject || "(no subject)", el("span", { class: "muted" }, ` · ${row.mail_from}`)), el("div", { class: "muted" }, row.reason)),
						view, btn);
				})) : null,
			el("div", { class: "actions", style: "margin-top:0.6rem" },
				el("button", { class: "btn", onclick: save }, "Download the training file"),
				el("label", { class: "btn" }, "Load a training file", loader),
				total ? el("button", { class: "btn danger", onclick: () => forget({ all: true }, "everything the email check learned") }, "Forget everything") : null),
		].filter(Boolean));
	}

	// ------------------------------------------------------------- Email (Settings → the module → Email)
	const MAILBOX = { imap: "IMAP mailbox", gmail: "Gmail" };
	async function loadMail() {
		let m;
		try { m = await api("/mail"); } catch { return; }
		const box = $("in-mail");
		if (m.setting === "off") return box.classList.add("hidden");
		box.classList.remove("hidden");
		const st = m.state || {};
		const ago = (iso) => { const min = Math.round((Date.now() - Date.parse(iso)) / 60000); return min < 1 ? "just now" : min < 60 ? `${min} min ago` : min < 1440 ? `${Math.round(min / 60)} h ago` : new Date(iso).toLocaleDateString(); };
		const r = st.result || {};
		const got = (r.files || 0) + (r.emails_saved || 0);
		const line = m.missing
			? el("span", { class: "muted" }, `Email: ${m.missing}.`)
			: st.error
				? el("span", { class: "bad" }, `Email check failed ${ago(st.last_check_at)}: ${st.error}`)
				: el("span", { class: "muted" }, st.last_check_at ? `Email (${MAILBOX[m.mailbox] || "mailbox"}) checked ${ago(st.last_check_at)}${got ? ` · ${got} new file${got === 1 ? "" : "s"}` : ""}${m.interval ? `, every ${m.interval} min` : ""}.` : `Email (${MAILBOX[m.mailbox] || "mailbox"}) not checked yet.`);
		const btn = el("button", { class: "btn", onclick: async () => {
			btn.disabled = true;
			btn.textContent = "Checking…";
			try {
				const res = await api("/mail/check", { method: "POST", body: "{}" });
				if (res.error) throw new Error(res.error);
				const n = (res.files || 0) + (res.emails_saved || 0);
				toast(res.skipped ? `Email: ${res.skipped}.` : n ? `${n} new file${n === 1 ? "" : "s"} from email.` : `No new bills in email (${res.looked_at} looked at).`);
				$("in-filter").value = "new";
				await load();
			} catch (e) { fail(e); await loadMail(); }
		} }, "Check email now");
		const learnedLink = el("a", { href: "#", onclick: (e) => { e.preventDefault(); toggleTraining(); } }, "What it learned");
		box.replaceChildren(...[line, m.missing || me?.role === "viewer" ? null : btn, learnedLink].filter(Boolean));
	}

	/** After the email viewer imported an email: say so, and show the inbox's new files. */
	const afterMailView = (then = () => {}) => async (r) => {
		if (r.imported) {
			const { files: n, duplicates } = r.imported;
			toast(n ? `Imported ${n} file${n === 1 ? "" : "s"}.` : duplicates ? "Already in the inbox." : "Nothing imported.");
			$("in-filter").value = "new";
			await load().catch(fail);
		}
		then();
	};

	// ------------------------------------------------------------- The hand-over from the Import module
	// Import is part of this module since 0.17.0. Its inbox, email log and settings are taken over
	// only when an admin presses the button here: it moves a person's data between modules.
	async function loadAdoption() {
		const box = $("in-adopt");
		let a;
		try { a = await api("/adoption"); } catch { return box.classList.add("hidden"); }
		if (!a.pending) return box.classList.add("hidden");
		const parts = [];
		if (a.ready) parts.push(`${a.ready} file${a.ready === 1 ? "" : "s"} of its inbox`);
		if (a.extractions) parts.push(`${a.extractions} thing${a.extractions === 1 ? "" : "s"} the AI read`);
		if (a.mail_seen) parts.push(`its log of ${a.mail_seen} email${a.mail_seen === 1 ? "" : "s"} already looked at`);
		if (a.training) parts.push(`${a.training} example${a.training === 1 ? "" : "s"} its email check learned from`);
		if (a.has_settings && !a.adopted) parts.push("its settings");
		const take = el("button", { class: "btn primary", onclick: async () => {
			if (!confirm(`Take over the Import module's data in this organization? Its inbox entries, email log and settings are copied into ${moduleName}; the files stay where they are, in Ledger's Documents. Nothing is deleted from Import, and it is safe to do again.`)) return;
			take.disabled = true;
			try {
				const r = (await api("/adoption", { method: "POST", body: JSON.stringify({ confirm: true }) })).adopted;
				toast(`Taken over: ${r.files} file${r.files === 1 ? "" : "s"}, ${r.mail_seen} email${r.mail_seen === 1 ? "" : "s"} in the log, ${r.mail_training} learned example${r.mail_training === 1 ? "" : "s"}${r.settings.length ? `, ${r.settings.length} setting${r.settings.length === 1 ? "" : "s"}` : ""}.${r.waiting ? `\n${r.waiting} file${r.waiting === 1 ? " isn't" : "s aren't"} in Documents yet: update the Import module first, then press this again.` : ""}`);
				$("in-filter").value = "new";
				await load();
			} catch (e) { fail(e); take.disabled = false; }
		} }, "Take it over");
		const skip = el("button", { class: "btn", onclick: async () => {
			if (!confirm("Leave the Import module's data where it is? This notice goes away; nothing is deleted.")) return;
			try { await api("/adoption/dismiss", { method: "POST", body: JSON.stringify({ dismissed: true }) }); await load(); } catch (e) { fail(e); }
		} }, "Don't take it over");
		box.replaceChildren(...[
			el("div", {}, el("strong", {}, "The Import module is part of this module now. "), parts.length ? `Waiting to be taken over: ${parts.join(", ")}.` : "Its data waits to be taken over."),
			a.waiting ? el("div", { class: "bad", style: "margin-top:0.3rem" }, `${a.waiting} of its files ${a.waiting === 1 ? "isn't" : "aren't"} in Ledger's Documents yet${a.ready ? " and won't come along" : ""}: update the Import module first (Settings → Modules), which moves them there.`) : null,
			a.hold ? el("div", { class: "muted", style: "margin-top:0.3rem" }, "Until then email isn't read here, so nothing is imported twice.") : null,
			a.error ? el("div", { class: "bad", style: "margin-top:0.3rem" }, `Import's data couldn't be read: ${a.error}`) : null,
			a.admin ? el("div", { class: "actions" }, take, skip) : el("div", { class: "muted", style: "margin-top:0.3rem" }, "An admin can take it over here."),
		].filter(Boolean));
		box.classList.remove("hidden");
	}

	/** Wires the tab's fixed controls; called once by the page. */
	function init() {
		$("in-filter").onchange = () => { openId = null; load().catch(fail); };
		$("in-get-ext").onclick = () => $("in-ext").classList.toggle("hidden");
		$("in-ext-url").textContent = location.origin;
		$("in-dl-ext").onclick = downloadExtension;
	}

	/** Shows one file with its Send panel open (after a scan, an upload, or a link from Ledger's search). */
	async function show(id, { filter = "new" } = {}) {
		$("in-filter").value = filter;
		openId = Number(id);
		noteHash("#/inbox");
		showTab("inbox");
		setTimeout(() => document.getElementById(`file-${openId}`)?.scrollIntoView({ block: "start" }), 400);
	}

	return { init, load, loadCount, show, uploadBytes, safeName, follow, isLoaded: () => loaded };
})();
