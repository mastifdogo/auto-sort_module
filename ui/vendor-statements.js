// Vendors' statements of account on the Statements tab (0.32.0; in 0.31.0 they had a tab of their
// own). A vendor statement is a supplier's list of their invoices, our payments and credit notes,
// with the balance they say is owed. It is not a bill and nothing is posted for it. It is listed
// with the bank, card and loan statements (GET /statements carries both kinds); opening one shows
// its details and lines where a bank statement shows its rows, to check and correct; Reconcile
// opens Ledger's own Reconcile page for the vendor's account with this statement beside it. Whether
// that reconciliation is in progress or finished is read from Ledger each time.
//
// Loaded before the page's own script; it uses that script's helpers when it runs (api, $, el,
// toast, fail, money, role, showTab, closeDetail, loadStatements, openBill, shrinkImage, Inbox).
// Everything goes into the page with textContent.
"use strict";
const VendorStatements = (() => {
	let current = null; // { statement, lines, reconcile }: the one that is open
	let rows = []; // the lines being edited: { date, description, amount }
	let dirtyLines = false;
	const viewer = () => role === "viewer";
	const goLedger = (path) => (window.top.location.href = path); // the page is shown in a frame inside Ledger
	const day = (v) => String(v ?? "").slice(0, 10);
	const dec = (cents) => (cents == null ? "" : (Number(cents) / 100).toFixed(2));
	const signed = (cents) => `${Number(cents) < 0 ? "−" : ""}${money(Math.abs(Number(cents)))}`;
	const started = (rec) => rec?.state === "open" || rec?.state === "finished";
	const openLabel = (rec) => (rec?.state === "finished" ? "Open the reconciliation" : "Continue in Ledger");

	/** The pill for what Ledger says about a statement's reconciliation. */
	function statePill(rec) {
		if (!rec || rec.state === "unavailable") return el("span", { class: "pill plain", title: "Reconciling needs Ledger 0.34.0 or later" }, "Kept");
		if (rec.state === "finished") return el("span", { class: "pill good" }, `Reconciled${rec.finished_at ? ` on ${day(rec.finished_at)}` : ""}`);
		if (rec.state === "open") return el("span", { class: "pill warn" }, "In progress");
		if (rec.state === "unknown") return el("span", { class: "pill plain", title: rec.error || "" }, "Not known");
		return el("span", { class: "pill plain" }, "Not started");
	}
	/** A link to the reconciliation, a page of Ledger itself (outside this frame). */
	const recLink = (rec, text) => el("a", { href: rec.href, target: "_top", onclick: (e) => { e.preventDefault(); goLedger(rec.href); } }, text);
	const owed = (s) => (s.closing_balance_cents == null ? null : Number(s.closing_balance_cents) < 0 ? `${money(-Number(s.closing_balance_cents))} ${s.currency} owed to you` : `${money(s.closing_balance_cents)} ${s.currency} owed`);

	// ---------------------------------------------------------------- in the list of statements

	/** What the list says under it when this Ledger can't reconcile a vendor statement. */
	function listed(list, reconcile) {
		const show = list.length > 0 && reconcile && !reconcile.available;
		$("vs-older").textContent = show ? reconcile.reason : "";
		$("vs-older").classList.toggle("hidden", !show);
	}

	/** A vendor statement's row among the statements: the vendor where a bank statement has its account, what is owed, and its reconciliation. */
	function listRow(s, reconcile) {
		const rec = s.reconciliation;
		const can = reconcile?.available;
		let action = null;
		if (started(rec) && rec.href) {
			action = el("button", { class: "btn small-btn", type: "button", title: "Ledger's Reconcile page for this statement", onclick: (e) => { e.stopPropagation(); goLedger(rec.href); } }, openLabel(rec));
		} else if (can && !viewer() && rec?.state === "none") {
			action = el("button", { class: "btn small-btn", type: "button", title: "Opens Ledger's Reconcile page for this vendor's own account, with this statement and its lines. Nothing is posted.", onclick: (e) => { e.stopPropagation(); reconcileListed(s, e.currentTarget); } }, "Reconcile");
		}
		const dates = s.period_start && s.statement_date ? `${s.period_start} – ${s.statement_date}` : s.statement_date || "—";
		return el("tr", { class: "clickable", "data-vendor-statement": s.id, onclick: () => open(s.id).catch(fail) },
			el("td", { class: "wide" }, s.document_name || s.mail_subject || "Statement of account",
				el("span", { class: "pill plain", style: "margin-left:6px", title: "A supplier's statement of account: reconciled against the vendor's account in Ledger, never posted" }, "Vendor statement"),
				s.error ? el("span", { class: "err", title: s.error }, " !") : null),
			el("td", {}, s.vendor ? el("span", {}, s.vendor, el("span", { class: "muted" }, " (vendor)")) : el("span", { class: "muted" }, "choose the vendor")),
			el("td", {}, dates),
			el("td", {}, statePill(rec), action ? " " : null, action),
			el("td", { class: "num" }, owed(s) ?? "—"),
			el("td", { class: "num muted" }, new Date(s.created_at).toLocaleDateString()),
		);
	}

	/** Reconcile pressed in the list: straight to Ledger; when something is missing, the statement opens and says what. */
	async function reconcileListed(s, button) {
		button.disabled = true;
		try {
			const r = await api(`/vendor-statements/${s.id}/reconcile`, { method: "POST", body: "{}" });
			if (r.already_open) return alreadyOpen(r);
			goLedger(r.href);
		} catch (e) {
			await open(s.id).catch(() => {});
			fail(e);
		} finally { button.disabled = false; }
	}

	/** One is in progress for this vendor already: say so and link to it; nothing new was started. */
	function alreadyOpen(r) {
		if (current?.statement.id === r.statement.id) { current = r; render(); }
		toast(r.message);
		if (confirm(`${r.message}\n\nOpen it in Ledger now?`)) goLedger(r.href);
		else if (!current) loadStatements().catch(() => {});
	}

	// ---------------------------------------------------------------- one statement, opened

	async function open(id) {
		const r = await api(`/vendor-statements/${id}`);
		if (activeTab !== "review") showTab("review");
		closeDetail(); // a bank statement that was open, and its polling
		current = r;
		rows = r.lines.map((l) => ({ date: l.date, description: l.description, amount: dec(l.amount_cents) }));
		dirtyLines = false;
		render();
		$("list-view").classList.add("hidden");
		$("vs-view").classList.remove("hidden");
	}

	/** The opened statement is put away (the page's closeDetail shows the list again). */
	function hide() {
		current = null;
		$("vs-view").classList.add("hidden");
		$("vs-doc").replaceChildren();
	}

	function renderLines() {
		const ro = viewer();
		const body = $("vs-lines").tBodies[0];
		const input = (row, key, attrs) => {
			const i = el("input", { ...attrs, value: row[key] ?? "", disabled: ro });
			i.oninput = () => { row[key] = i.value; dirtyLines = true; totals(); };
			return i;
		};
		body.replaceChildren(...rows.map((row, n) =>
			el("tr", {},
				el("td", {}, input(row, "date", { type: "date", class: "cell-date", "aria-label": "Date" })),
				el("td", { class: "wide" }, input(row, "description", { class: "cell-desc", maxlength: 300, placeholder: "Invoice, credit note or payment, with its number", "aria-label": "Description" })),
				el("td", {}, input(row, "amount", { class: "cell-num", inputmode: "decimal", placeholder: "0.00", "aria-label": "Amount" })),
				el("td", {}, ro ? "" : el("button", { class: "btn small-btn", type: "button", title: "Remove this line", onclick: () => { rows.splice(n, 1); dirtyLines = true; renderLines(); } }, "✕")),
			)));
		if (rows.length === 0) body.replaceChildren(el("tr", {}, el("td", { colspan: 4, class: "muted" }, ro ? "No lines." : "No lines yet: add the statement's lines, or reconcile with none and tick the vendor's bills and payments in Ledger.")));
		totals();
	}

	const cents = (v) => { const n = Number(String(v ?? "").replace(/[$,\s]/g, "")); return Number.isFinite(n) ? Math.round(n * 100) : 0; };

	/** Invoices, payments and whether the opening balance plus the lines gives the balance owed. */
	function totals() {
		let up = 0, down = 0;
		for (const r of rows) { const c = cents(r.amount); if (c > 0) up += c; else down += c; }
		const parts = [`Invoices and charges ${money(up)}`, `payments and credits ${signed(down)}`];
		const opening = $("vs-opening").value.trim(), closing = $("vs-closing").value.trim();
		if (opening !== "" && closing !== "" && rows.length > 0) {
			const diff = cents(opening) + up + down - cents(closing);
			parts.push(diff === 0 ? "the lines add up to the balance" : `the lines don't add up to the balance: ${signed(diff)} apart (check the lines, or go on and see in Ledger)`);
		}
		$("vs-totals").textContent = `${parts.join(" · ")}.`;
	}

	function render() {
		const s = current.statement;
		const rec = s.reconciliation;
		const ro = viewer();
		$("vs-title").textContent = `${s.document_name || "Statement of account"} → ${s.vendor || "vendor not chosen"}`;
		$("vs-status").replaceChildren(el("span", { class: "pill plain", style: "margin-right:6px", title: "A supplier's statement of account: reconciled against the vendor's account in Ledger, never posted" }, "Vendor statement"), statePill(rec));
		const summary = s.summary && !/[.!?]$/.test(s.summary) ? `${s.summary}.` : s.summary;
		$("vs-info").textContent = [
			`${rows.length} line${rows.length === 1 ? "" : "s"}${s.statement_date ? `, dated ${s.statement_date}` : ""}${owed(s) ? ` · ${owed(s)}` : ""}`,
			summary,
			s.read_by === "ai" ? `Read by the AI${s.confidence != null ? ` with ${Math.round(s.confidence * 100)}% confidence` : ""}; check it against the statement.` : "",
			s.was_kind ? `It was a ${s.was_kind} here before a person said it is a vendor statement.` : "",
		].filter(Boolean).join(" · ");
		$("vs-error").textContent = s.error || "";
		$("vs-vendor").value = s.vendor;
		$("vs-currency").value = s.currency;
		$("vs-date").value = s.statement_date || "";
		$("vs-from").value = s.period_start || "";
		$("vs-opening").value = dec(s.opening_balance_cents);
		$("vs-closing").value = dec(s.closing_balance_cents);
		for (const id of ["vs-vendor", "vs-currency", "vs-date", "vs-from", "vs-opening", "vs-closing"]) $(id).disabled = ro;
		api("/vendors").then((r) => $("vs-vendors").replaceChildren(...r.data.map((v) => el("option", { value: v.name })))).catch(() => {});
		renderLines();

		// Its reconciliation in Ledger: read from Ledger just now, nothing is copied here.
		const kids = [];
		const can = current.reconcile.available;
		if (!can) kids.push(el("p", { class: "review-note", style: "margin:0" }, current.reconcile.reason));
		else if (rec.state === "finished") {
			kids.push(el("p", { style: "margin:0" }, `Reconciled on ${day(rec.finished_at)}${rec.finished_by ? ` by ${rec.finished_by}` : ""}: `, recLink(rec, "open the reconciliation in Ledger"), "."));
		} else if (rec.state === "open") {
			kids.push(el("p", { style: "margin:0" }, "It is being reconciled in Ledger", rec.started_by ? ` (started by ${rec.started_by})` : "", ": ", recLink(rec, "continue there"), ". A person finishes it on Ledger's Reconcile page. What you change here now stays here: Ledger has the statement as it was when Reconcile was pressed."));
			if (rec.matched != null) kids.push(el("p", { class: "muted", style: "margin:0.4rem 0 0" }, `${rec.matched} line${rec.matched === 1 ? "" : "s"} of the statement matched the books and ${rec.matched === 1 ? "is" : "are"} ticked${rec.not_on_statement ? `; ${rec.not_on_statement} line${rec.not_on_statement === 1 ? "" : "s"} in the vendor's account ${rec.not_on_statement === 1 ? "isn't" : "aren't"} ticked` : ""}${rec.difference_cents != null ? `; ${Number(rec.difference_cents) === 0 ? "nothing is left to explain" : `${signed(rec.difference_cents)} ${s.currency} left to explain`}` : ""}.`));
			if (rec.unmatched?.length) {
				kids.push(el("p", { style: "margin:0.6rem 0 0.1rem" }, el("strong", {}, "On the statement, not in the books")),
					el("p", { class: "muted", style: "margin:0 0 0.3rem" }, "These lines have no bill or payment in the vendor's account in Ledger: a missing bill to find and enter, or a payment not recorded."),
					el("div", { class: "table-wrap" }, el("table", { class: "stack", id: "vs-unmatched" }, el("tbody", {}, ...rec.unmatched.map((l) =>
						el("tr", {}, el("td", { class: "nowrap" }, l.date), el("td", { class: "wide" }, l.description || "—"), el("td", { class: "num" }, `${signed(l.amount_cents)} ${s.currency}`)))))));
			} else if (rec.unmatched) kids.push(el("p", { class: "muted", style: "margin:0.4rem 0 0" }, "Every line of the statement has a line in the books."));
		} else if (rec.state === "unknown") {
			kids.push(el("p", { class: "review-note", style: "margin:0" }, `Ledger couldn't say whether this statement is being reconciled${rec.error ? `: ${rec.error}` : "."}`));
		} else {
			kids.push(el("p", { class: "muted", style: "margin:0" }, "Not reconciled yet. Check the vendor, the date, the balance owed and the lines below, then press ", el("strong", {}, "Reconcile"), ": Ledger's Reconcile page opens for this vendor's own account, with the statement beside the vendor's bills and payments. The ones that match are ticked, and you see which statement lines the books don't have and which book lines the statement doesn't. Nothing is posted."));
		}
		if (can && rec.other_open) kids.push(el("p", { class: "review-note", style: "margin:0.4rem 0 0" }, `A reconciliation of this vendor is already in progress${rec.other_open.statement_date ? ` (statement of ${rec.other_open.statement_date})` : ""}: `, recLink(rec.other_open, "open it in Ledger"), ". Finish or delete it there before reconciling this one."));
		$("vs-rec").replaceChildren(...kids);

		const begun = started(rec);
		for (const id of ["vs-save", "vs-add-line", "vs-flip", "vs-delete"]) $(id).classList.toggle("hidden", ro);
		$("vs-start").classList.toggle("hidden", ro || !can || begun);
		$("vs-start").disabled = !!rec.other_open;
		$("vs-open").classList.toggle("hidden", !begun);
		$("vs-open").textContent = openLabel(rec);
		$("vs-bill").classList.toggle("hidden", ro || begun);
		$("vs-receipt").classList.toggle("hidden", ro || begun);

		$("vs-source").textContent = [s.source === "email" ? `Email from ${s.mail_from || "?"}${s.mail_subject ? `: "${s.mail_subject}"` : ""}` : s.source === "module" ? `Sent by ${String(s.mail_from || "").replace(/^module:/, "") || "another module"}` : "Uploaded", s.document_name || ""].filter(Boolean).join(" · ");
		const doc = $("vs-doc");
		doc.replaceChildren();
		$("vs-show-doc").classList.toggle("hidden", !s.document_url);
		$("vs-show-doc").onclick = () => {
			if (doc.firstChild) return doc.replaceChildren();
			doc.replaceChildren(/\.(png|jpe?g|gif|webp)$/i.test(s.document_name || "") ? el("img", { src: s.document_url, alt: "The statement", style: "max-width:100%" }) : el("iframe", { class: "pdf", src: s.document_url, title: "The statement" }));
		};
	}

	/** What the form says that differs from what is kept. */
	function changed() {
		const s = current.statement;
		const out = {};
		const put = (k, now, was) => { if ((now ?? "") !== (was ?? "")) out[k] = now; };
		put("vendor", $("vs-vendor").value.trim(), s.vendor);
		put("currency", $("vs-currency").value, s.currency);
		put("statement_date", $("vs-date").value, s.statement_date || "");
		put("period_start", $("vs-from").value, s.period_start || "");
		const amount = (id, was) => { const v = $(id).value.trim(); return v !== "" && was != null && Number(v.replace(/[$,\s]/g, "")) === Number(was) / 100 ? dec(was) : v; };
		put("opening_balance", amount("vs-opening", s.opening_balance_cents), dec(s.opening_balance_cents));
		put("closing_balance", amount("vs-closing", s.closing_balance_cents), dec(s.closing_balance_cents));
		return out;
	}
	const unsaved = () => !!current && !viewer() && (dirtyLines || Object.keys(changed()).length > 0);

	/** Saves the details and the lines when they changed. → true when everything is saved. */
	async function save({ quiet = false } = {}) {
		const id = current.statement.id;
		const f = changed();
		try {
			if (Object.keys(f).length > 0) await api(`/vendor-statements/${id}`, { method: "PATCH", body: JSON.stringify(f) });
			if (dirtyLines) {
				const lines = rows.filter((r) => r.date || r.description.trim() || String(r.amount).trim());
				await api(`/vendor-statements/${id}/lines`, { method: "PUT", body: JSON.stringify({ lines }) });
			}
			if (Object.keys(f).length === 0 && !dirtyLines) { if (!quiet) toast("Nothing changed."); return true; }
			await open(id);
			if (!quiet) toast("Saved.");
			return true;
		} catch (e) { fail(e); return false; }
	}

	/** Reconcile on the opened statement: what is on the page is saved first, so Ledger gets the statement as the person sees it. */
	async function start() {
		if (!(await save({ quiet: true }))) return;
		$("vs-start").disabled = true;
		try {
			const r = await api(`/vendor-statements/${current.statement.id}/reconcile`, { method: "POST", body: "{}" });
			if (r.already_open) return alreadyOpen(r);
			goLedger(r.href);
		} catch (e) { fail(e); } finally { if (current) $("vs-start").disabled = !!current.statement.reconciliation?.other_open; }
	}

	async function toBill(kind) {
		if (!confirm(`This is a ${kind}, not a vendor's statement of account? It goes to the ${kind === "receipt" ? "Receipts" : "Bills"} tab${current.statement.was_kind ? " as it was" : " as Needs review"}.`)) return;
		try {
			const b = await api(`/vendor-statements/${current.statement.id}/bill`, { method: "POST", body: JSON.stringify({ kind }) });
			closeDetail();
			toast(`It is a ${kind} again.`);
			openBill(b.id);
		} catch (e) { fail(e); }
	}

	// ---------------------------------------------------------------- how something becomes one

	/** "This is a vendor statement" on a bill or receipt: the server says why not when it has posted something. */
	async function fromBill(billId) {
		if (!confirm("This is a vendor's statement of account (their list of invoices and payments with the balance owed), not a bill?\n\nNo bill is kept for it and nothing is posted: it goes to the Statements tab, where you check its lines and reconcile it against the vendor's account in Ledger.")) return false;
		try {
			await api(`/bills/${billId}/vendor-statement`, { method: "POST", body: "{}" });
			toast("It is a vendor statement now, on the Statements tab. Check its date, balance and lines, then press Reconcile.");
			await open(billId);
			return true;
		} catch (e) { fail(e); return false; }
	}

	/**
	 * "This is a vendor's statement…" on a statement staged for a bank or card account: the person
	 * chooses the vendor; the server refuses, with the reason, once something of it is posted, merged
	 * or linked. Errors show inside the dialog (the toast is behind it).
	 */
	function fromStatement(st) {
		const vendor = el("input", { list: "vsd-vendors", maxlength: 200, placeholder: "Pick one of Ledger's vendors, or type a new one", style: "width:100%", "aria-label": "Vendor" });
		const list = el("datalist", { id: "vsd-vendors" });
		api("/vendors").then((r) => list.replaceChildren(...r.data.map((v) => el("option", { value: v.name })))).catch(() => {});
		const err = el("p", { class: "err" });
		const go = el("button", { class: "btn primary", type: "button" }, "Make it a vendor's statement");
		const dlg = el("dialog", { class: "similar-dialog" },
			el("h2", { style: "margin-top:0" }, "This is a vendor's statement"),
			el("p", { class: "small" }, `${st.filename} is a supplier's statement of account (their invoices, your payments and the balance they say you owe), not a statement of ${st.account_code ? accountLabel(st.account_code) : "a bank or card account"}?`),
			el("p", { class: "small muted" }, `Its ${st.total} line${st.total === 1 ? "" : "s"} leave${st.total === 1 ? "s" : ""} that account's transactions to post and become the vendor statement's lines, with its file. Nothing is posted. You check the date, the balance owed and the lines, then press Reconcile to compare it with the vendor's account in Ledger.`),
			el("label", {}, "Whose statement is it?", vendor),
			list,
			err,
			el("div", { class: "row", style: "margin-top:0.75rem" }, el("span", { class: "spacer" }), el("button", { class: "btn", type: "button", onclick: () => dlg.close() }, "Cancel"), go),
		);
		go.onclick = async () => {
			if (!vendor.value.trim()) { err.textContent = "Choose the vendor, or type its name."; return; }
			go.disabled = true;
			err.textContent = "";
			try {
				const r = await api(`/statements/${st.id}/vendor-statement`, { method: "POST", body: JSON.stringify({ vendor: vendor.value.trim() }) });
				dlg.close();
				toast("It is a vendor statement now. Check its date, balance and lines, then press Reconcile.");
				await open(r.statement.id);
			} catch (e) { err.textContent = e.message || String(e); } finally { go.disabled = false; }
		};
		vendor.oninput = () => (err.textContent = "");
		dlg.addEventListener("close", () => dlg.remove());
		document.body.append(dlg);
		dlg.showModal();
		vendor.focus();
	}

	/** "Upload a vendor's statement" on the Statements tab: through the inbox (filed in Documents), read, and kept as one. */
	async function upload(file) {
		let blob = file, name = file.name;
		// Phone photos are several MB; a smaller JPEG reads just as well.
		if (/^image\/(jpeg|png|webp)$/.test(file.type) && file.size > 500_000) {
			try { blob = await shrinkImage(file); name = name.replace(/\.[a-z0-9]+$/i, "") + ".jpg"; } catch { /* keep the original */ }
		}
		toast("Reading the vendor's statement…");
		try {
			const f = await Inbox.uploadBytes(Inbox.safeName(name), blob.type || file.type || "application/octet-stream", new Uint8Array(await blob.arrayBuffer()));
			const b = (await api(`/inbox/${f.id}/bill`, { method: "POST", body: JSON.stringify({ kind: "vendor_statement" }) })).bill;
			toast("Kept as a vendor statement. Check it, then press Reconcile.");
			await open(b.id);
		} catch (e) {
			fail(new Error(`${e.message}\nIf the file was received, it waits on the Inbox tab.`));
			Inbox.loadCount();
		}
	}

	function init() {
		$("vs-back").onclick = () => {
			if (unsaved() && !confirm("Leave without saving your changes to this vendor statement?")) return;
			closeDetail();
			loadStatements().catch(fail);
		};
		$("vs-save").onclick = () => save();
		$("vs-add-line").onclick = () => { rows.push({ date: rows.at(-1)?.date || $("vs-date").value || "", description: "", amount: "" }); dirtyLines = true; renderLines(); };
		$("vs-flip").onclick = () => {
			for (const r of rows) { const c = cents(r.amount); if (c !== 0) r.amount = dec(-c); }
			dirtyLines = true;
			renderLines();
		};
		$("vs-start").onclick = start;
		$("vs-open").onclick = () => current?.statement.reconciliation?.href && goLedger(current.statement.reconciliation.href);
		$("vs-bill").onclick = () => toBill("bill");
		$("vs-receipt").onclick = () => toBill("receipt");
		$("vs-delete").onclick = async () => {
			if (!confirm("Delete this vendor statement? Its lines here go with it. A reconciliation in Ledger stays as it is.")) return;
			try { await api(`/vendor-statements/${current.statement.id}`, { method: "DELETE" }); closeDetail(); await loadStatements(); toast("Deleted."); } catch (e) { fail(e); }
		};
		for (const id of ["vs-opening", "vs-closing"]) $(id).oninput = totals;
		$("vs-file").onchange = async () => {
			const file = $("vs-file").files[0];
			$("vs-file").value = "";
			if (file) await upload(file);
		};
	}

	return { init, listed, listRow, open, hide, fromBill, fromStatement };
})();
