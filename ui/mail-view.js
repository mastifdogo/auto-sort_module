// Looking at an email before importing it: who sent it, its text, its
// attachments (each can be opened without importing it), then Import what's
// ticked. Used by the Inbox page: the emails the check skipped, and the
// email behind an inbox file in its Send panel.
//
//   MailView.open({ id, folder, onDone(result) })
//     result: { imported: { files, duplicates } }
//   MailView.open({ file })   the email behind inbox file `file` (an .eml, or the
//     email a file came from), read only: to look at it before sending the file on
//
// Everything from the email goes in with textContent; the HTML of an HTML
// email is never rendered (the server turns it into text), so nothing in it
// runs or loads.
"use strict";
(function () {
	const API = "/api/v1/m/categorizer";
	const VIEWABLE = /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain)/;
	const OPENABLE = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain"];

	async function api(path, opts = {}) {
		const r = await fetch(API + path, { credentials: "same-origin", ...opts, headers: { "Content-Type": "application/json" } });
		const body = await r.json().catch(() => ({}));
		if (!r.ok) throw new Error(body?.error?.message || body?.message || (typeof body?.error === "string" ? body.error : "") || `HTTP ${r.status}`);
		return body;
	}
	const el = (tag, attrs = {}, ...kids) => {
		const n = document.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) {
			if (k === "class") n.className = v;
			else if (k.startsWith("on")) n[k] = v;
			else if (v !== false && v != null) n.setAttribute(k, v === true ? "" : v);
		}
		n.append(...kids.filter((k) => k != null && k !== false));
		return n;
	};
	const size = (b) => (b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(b < 10240 ? 1 : 0)} KB` : `${(b / 1048576).toFixed(1)} MB`);

	const CSS = `
	dialog.mv { width: min(46rem, calc(100vw - 1rem)); max-height: calc(100vh - 1rem); padding: 0; border: 1px solid var(--border, #dde1e6); border-radius: 8px;
		background: var(--bg, #fff); color: var(--text, #1d232b); font: 14px/1.45 system-ui, sans-serif; }
	dialog.mv::backdrop { background: rgb(0 0 0 / 0.45); }
	.mv-body { display: flex; flex-direction: column; gap: 0.6rem; padding: 0.8rem 0.9rem; max-height: calc(100vh - 1rem); box-sizing: border-box; }
	.mv-head { display: flex; gap: 0.5rem; align-items: flex-start; }
	.mv-head h3 { flex: 1; margin: 0; font-size: 1rem; overflow-wrap: anywhere; }
	.mv-meta { color: var(--muted, #5d6875); font-size: 13px; overflow-wrap: anywhere; }
	.mv-text { margin: 0; padding: 0.6rem 0.7rem; min-height: 4rem; max-height: 40vh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere;
		background: var(--panel, #f6f8fa); border: 1px solid var(--border, #dde1e6); border-radius: 6px; font: 13px/1.45 system-ui, sans-serif; }
	.mv-atts { display: flex; flex-direction: column; gap: 0.3rem; }
	.mv-att { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
	.mv-att label { flex: 1; min-width: 10rem; display: flex; gap: 0.4rem; align-items: center; overflow-wrap: anywhere; color: inherit; font-size: 14px; }
	.mv-muted { color: var(--muted, #5d6875); font-size: 13px; }
	.mv-bad { color: var(--bad, #cf222e); font-size: 13px; }
	.mv-foot { display: flex; gap: 0.5rem; flex-wrap: wrap; justify-content: flex-end; }
	.mv button { padding: 0.35rem 0.75rem; border: 1px solid var(--border, #dde1e6); border-radius: 6px; background: var(--bg, #fff); color: var(--text, #1d232b); font: inherit; cursor: pointer; }
	.mv button.mv-small { padding: 0.1rem 0.5rem; font-size: 13px; }
	.mv button.mv-primary { background: var(--accent, #1f6feb); border-color: var(--accent, #1f6feb); color: #fff; }
	.mv button:disabled { opacity: 0.5; cursor: default; }`;

	function ensureStyle() {
		if (document.getElementById("mv-style")) return;
		document.head.append(el("style", { id: "mv-style" }, CSS));
	}

	/** Opens an attachment in a new tab (PDF, pictures, text) or downloads it, without importing it. */
	async function openAttachment(email, a, btn, setError) {
		btn.disabled = true;
		// Opened before the request, so the browser doesn't treat it as an unasked pop-up.
		const viewable = VIEWABLE.test(a.content_type) || /\.(pdf|png|jpe?g|gif|webp|txt)$/i.test(a.filename);
		const tab = viewable ? window.open("", "_blank") : null;
		try {
			const c = email.file_id != null
				? await api(`/inbox/${email.file_id}/email/attachment?${new URLSearchParams({ attachment: a.attachment_id })}`)
				: await api(`/mail/message/attachment?${new URLSearchParams({ id: email.id, attachment: a.attachment_id, folder: email.folder })}`);
			const bytes = Uint8Array.from(atob(c.data), (ch) => ch.charCodeAt(0));
			// The server says what the bytes are (never what the sender claimed). Only those types open in
			// a tab; anything else, an HTML file above all, is downloaded and never shown from Ledger's address.
			const shown = OPENABLE.includes(c.content_type);
			const url = URL.createObjectURL(new Blob([bytes], { type: shown ? c.content_type : "application/octet-stream" }));
			if (tab && shown) tab.location.href = url;
			else {
				tab?.close();
				el("a", { href: url, download: c.name }).click();
			}
			setTimeout(() => URL.revokeObjectURL(url), 60_000);
		} catch (e) {
			tab?.close();
			setError(e.message);
		} finally {
			btn.disabled = false;
		}
	}

	async function open({ id, folder = "", file = null, onDone = () => {} }) {
		const readOnly = file != null;
		ensureStyle();
		const box = el("div", { class: "mv-body" }, el("span", { class: "mv-muted" }, "Opening the email…"));
		const dlg = el("dialog", { class: "mv", "aria-label": "Email" }, box);
		dlg.addEventListener("close", () => dlg.remove());
		document.body.append(dlg);
		dlg.showModal();
		const close = () => dlg.close();
		const closeBtn = () => el("button", { type: "button", class: "mv-small", "aria-label": "Close", onclick: close }, "\u00d7");

		let email;
		try {
			if (readOnly) email = await api(`/inbox/${encodeURIComponent(file)}/email`);
			else {
				const qs = new URLSearchParams({ id });
				if (folder) qs.set("folder", folder);
				email = await api(`/mail/message?${qs}`);
			}
		} catch (e) {
			box.replaceChildren(el("div", { class: "mv-head" }, el("h3", {}, "Can't open the email"), closeBtn()), el("p", { class: "mv-bad" }, e.message));
			return;
		}

		const error = el("p", { class: "mv-bad", hidden: true });
		const setError = (msg) => { error.textContent = msg; error.hidden = !msg; };
		const checks = [];
		const rows = email.attachments.map((a) => {
			const cb = readOnly ? null : el("input", { type: "checkbox", checked: a.suggested && !a.too_large, disabled: a.too_large });
			if (cb) checks.push([cb, a.attachment_id]);
			const view = el("button", { type: "button", class: "mv-small", disabled: a.too_large });
			view.textContent = VIEWABLE.test(a.content_type) || /\.(pdf|png|jpe?g|gif|webp|txt)$/i.test(a.filename) ? "View" : "Download";
			view.onclick = () => openAttachment(email, a, view, setError);
			return el("div", { class: "mv-att" },
				el("label", {}, cb, el("span", {}, a.filename), el("span", { class: "mv-muted" }, `${size(a.size_bytes)}${a.too_large ? (readOnly ? " · too large to open here" : " · too large to import") : ""}`)),
				view);
		});
		const emlBox = el("input", { type: "checkbox", checked: !email.attachments.some((a) => a.suggested && !a.too_large) });
		const seen = readOnly ? null : email.seen;
		const status = readOnly ? (email.source === "file" ? "This .eml file, as it will be sent on." : "The email this file came from (from the mailbox).") : seen?.outcome === "files" ? `Already imported (${seen.files} file${seen.files === 1 ? "" : "s"}); files already in the inbox aren't added twice.`
			: seen?.reason ? `The check skipped: ${seen.reason}` : "";

		const importBtn = el("button", { type: "button", class: "mv-primary" }, "Import");
		const update = () => {
			const n = checks.filter(([cb]) => cb.checked).length + (emlBox.checked ? 1 : 0);
			importBtn.disabled = n === 0;
			importBtn.textContent = n === 0 ? "Import" : `Import ${n} file${n === 1 ? "" : "s"}`;
		};
		for (const [cb] of checks) cb.onchange = update;
		emlBox.onchange = update;
		update();

		importBtn.onclick = async () => {
			importBtn.disabled = true;
			setError("");
			try {
				const r = await api("/mail/message/import", { method: "POST", body: JSON.stringify({
					id: email.id, folder: email.folder,
					attachments: checks.filter(([cb]) => cb.checked).map(([, aid]) => aid),
					email: emlBox.checked,
				}) });
				close();
				onDone({ imported: r });
			} catch (e) { setError(e.message); update(); }
		};

		const when = email.date ? new Date(email.date).toLocaleString() : "";
		box.replaceChildren(...[
			el("div", { class: "mv-head" }, el("h3", {}, email.subject || "(no subject)"), closeBtn()),
			el("div", { class: "mv-meta" },
				el("div", {}, `From ${email.from || "an unknown sender"}`),
				email.to ? el("div", {}, `To ${email.to}${email.cc ? `, cc ${email.cc}` : ""}`) : null,
				when ? el("div", {}, when) : null),
			status ? el("div", { class: "mv-muted" }, status) : null,
			el("pre", { class: "mv-text" }, email.text || "(This email has no text.)"),
			email.text_cut ? el("div", { class: "mv-muted" }, "The text is long; only its start is shown.") : null,
			el("div", { class: "mv-atts" },
				el("strong", {}, readOnly ? "Attachments" : "Import"),
				...rows,
				readOnly ? null : el("div", { class: "mv-att" }, el("label", {}, emlBox, el("span", {}, "The email itself (.eml)"))),
				email.attachments.length ? null : el("span", { class: "mv-muted" }, "No attachments.")),
			error,
			el("div", { class: "mv-foot" }, el("button", { type: "button", onclick: close }, "Close"), readOnly ? null : importBtn),
		].filter(Boolean));
	}

	window.MailView = { open };
})();
