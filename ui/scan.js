// The Scan tab: a network scanner (through the Ledger server), a phone's camera (photos become
// the pages of one PDF, made here in the browser), and plain uploads. Whatever comes of it goes to
// the inbox (ui/inbox.js), filed in Ledger's Documents.
//
// Loaded before the page's own script; it uses that script's helpers when it runs (api, $, el,
// toast, fail, showTab) and Inbox.uploadBytes. The phone's camera is reached through a file input
// with capture: it works inside Ledger's frame without camera permissions.
"use strict";
const Scan = (() => {
	const MOBILE = matchMedia("(pointer: coarse)").matches || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
	let pages = []; // [{ jpeg: Uint8Array, w, h, url }]

	/** A photo on a canvas, upright as the camera held it, at most 3000 px on its long side (for finding and straightening the receipt). */
	async function loadPhoto(file) {
		let img;
		try {
			img = await createImageBitmap(file, { imageOrientation: "from-image" });
		} catch {
			img = await new Promise((resolve, reject) => {
				const i = new Image();
				i.onload = () => resolve(i);
				i.onerror = () => reject(new Error(`${file.name || "This photo"} can't be read here; take it again or choose a JPEG or PNG.`));
				i.src = URL.createObjectURL(file);
			});
		}
		const w0 = img.width, h0 = img.height;
		const k = Math.min(1, 3000 / Math.max(w0, h0));
		const w = Math.max(1, Math.round(w0 * k)), h = Math.max(1, Math.round(h0 * k));
		const canvas = document.createElement("canvas");
		canvas.width = w;
		canvas.height = h;
		const g = canvas.getContext("2d", { willReadFrequently: true });
		g.fillStyle = "#fff"; // transparent PNGs on white
		g.fillRect(0, 0, w, h);
		g.drawImage(img, 0, 0, w, h);
		img.close?.();
		return canvas;
	}

	/** A page: the canvas as a JPEG at most 2000 px on its long side. */
	async function canvasToPage(src) {
		const k = Math.min(1, 2000 / Math.max(src.width, src.height));
		let canvas = src;
		if (k < 1) {
			canvas = document.createElement("canvas");
			canvas.width = Math.max(1, Math.round(src.width * k));
			canvas.height = Math.max(1, Math.round(src.height * k));
			canvas.getContext("2d").drawImage(src, 0, 0, canvas.width, canvas.height);
		}
		const w = canvas.width, h = canvas.height;
		const blob = await new Promise((r) => canvas.toBlob(r, "image/jpeg", 0.82));
		if (!blob) throw new Error("Couldn't prepare the photo.");
		return { jpeg: new Uint8Array(await blob.arrayBuffer()), w, h, url: URL.createObjectURL(blob) };
	}

	/** A PDF with one JPEG per page, each page A4 wide. */
	function jpegsToPdf(list) {
		const enc = new TextEncoder();
		const parts = [];
		const offsets = [];
		let len = 0;
		const push = (x) => { const b = typeof x === "string" ? enc.encode(x) : x; parts.push(b); len += b.length; };
		const obj = (n, ...body) => { offsets[n] = len; push(`${n} 0 obj\n`); body.forEach(push); push("\nendobj\n"); };
		push("%PDF-1.4\n");
		push(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])); // binary marker
		const kids = list.map((_, i) => `${3 + i * 3} 0 R`).join(" ");
		obj(1, "<< /Type /Catalog /Pages 2 0 R >>");
		obj(2, `<< /Type /Pages /Kids [${kids}] /Count ${list.length} >>`);
		list.forEach((p, i) => {
			const n = 3 + i * 3;
			const pw = 595.28, ph = +((p.h * pw) / p.w).toFixed(2);
			const draw = `q ${pw} 0 0 ${ph} 0 0 cm /Im0 Do Q`;
			obj(n, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] /Resources << /XObject << /Im0 ${n + 2} 0 R >> >> /Contents ${n + 1} 0 R >>`);
			obj(n + 1, `<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`);
			obj(n + 2, `<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`, p.jpeg, "\nendstream");
		});
		const count = 3 + list.length * 3;
		const xref = len;
		push(`xref\n0 ${count}\n0000000000 65535 f \n`);
		for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, "0")} 00000 n \n`);
		push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
		const out = new Uint8Array(len);
		let at = 0;
		for (const b of parts) { out.set(b, at); at += b.length; }
		return out;
	}

	function defaultScanName() {
		const d = new Date();
		const p2 = (n) => String(n).padStart(2, "0");
		return `Receipt ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.pdf`;
	}

	function drawPages() {
		$("scan-pages").replaceChildren(...pages.map((p, i) => el("div", { class: "scan-page" },
			el("img", { src: p.url, alt: `Page ${i + 1}` }),
			el("div", { class: "cap" }, `Page ${i + 1}`, el("button", { class: "btn small-btn", "aria-label": `Remove page ${i + 1}`, onclick: () => { URL.revokeObjectURL(p.url); pages.splice(i, 1); drawPages(); } }, "×")),
		)));
		$("scan-save").classList.toggle("hidden", pages.length === 0);
		$("scan-camera").parentElement.firstChild.textContent = pages.length ? "Add a page" : "Take a photo";
		if (pages.length && !$("scan-name").value) $("scan-name").value = defaultScanName();
	}

	async function addPhotos(input) {
		const files = [...input.files];
		input.value = ""; // the same photo can be chosen again
		if (!files.length) return;
		document.querySelector("#camera-box .scan-actions").classList.add("hidden");
		$("scan-save").classList.add("hidden");
		try {
			for (const f of files) {
				$("scan-busy").classList.remove("hidden");
				const photo = await loadPhoto(f);
				await new Promise((r) => setTimeout(r, 0)); // let "Preparing…" show
				const found = window.Receipt ? Receipt.detect(photo) : { corners: [[0, 0], [photo.width, 0], [photo.width, photo.height], [0, photo.height]], found: false };
				$("scan-busy").classList.add("hidden");
				const page = await editPhoto(photo, found);
				if (page) { pages.push(await canvasToPage(page)); drawPages(); }
			}
		} catch (e) { fail(e); } finally {
			$("scan-busy").classList.add("hidden");
			$("crop").classList.add("hidden");
			document.querySelector("#camera-box .scan-actions").classList.remove("hidden");
			drawPages();
		}
	}

	/**
	 * Shows the photo with the receipt's corners (found, or the whole photo) to drag into place.
	 * Resolves with the page's canvas (straightened, maybe cleaned up), or null when discarded.
	 */
	function editPhoto(photo, found) {
		const box = $("crop"), cv = $("crop-canvas");
		const corners = found.corners.map((p) => p.slice());
		$("crop-msg").replaceChildren(found.found
			? el("span", {}, el("strong", {}, "Receipt found. "), "Drag the corners onto the receipt's corners if they're off, then Use this.")
			: el("span", {}, el("strong", {}, "Couldn't find the receipt's edges. "), "Drag the four corners onto the receipt's corners (a dark background helps), or use the whole photo."));
		$("crop-clean").checked = found.found;
		box.classList.remove("hidden");
		const dpr = window.devicePixelRatio || 1;
		let scale = 1;
		const draw = () => {
			const maxW = box.clientWidth - 2, maxH = Math.max(240, window.innerHeight * 0.62);
			scale = Math.min(maxW / photo.width, maxH / photo.height);
			const w = Math.round(photo.width * scale), h = Math.round(photo.height * scale);
			cv.style.width = `${w}px`;
			cv.style.height = `${h}px`;
			cv.width = Math.round(w * dpr);
			cv.height = Math.round(h * dpr);
			const g = cv.getContext("2d");
			g.setTransform(dpr * scale, 0, 0, dpr * scale, 0, 0);
			g.drawImage(photo, 0, 0);
			const lw = 3 / scale, r = 13 / scale;
			// Dim what's outside the receipt.
			g.save();
			g.beginPath();
			g.rect(0, 0, photo.width, photo.height);
			corners.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
			g.closePath();
			g.fillStyle = "rgba(0,0,0,0.45)";
			g.fill("evenodd");
			g.restore();
			g.beginPath();
			corners.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
			g.closePath();
			g.lineWidth = lw;
			g.strokeStyle = "#4c8dff";
			g.stroke();
			for (const [x, y] of corners) {
				g.beginPath();
				g.arc(x, y, r, 0, Math.PI * 2);
				g.fillStyle = "rgba(255,255,255,0.9)";
				g.fill();
				g.lineWidth = lw;
				g.stroke();
			}
		};
		let drag = -1;
		const at = (e) => { const b = cv.getBoundingClientRect(); return [(e.clientX - b.left) / scale, (e.clientY - b.top) / scale]; };
		cv.onpointerdown = (e) => {
			const p = at(e);
			let best = -1, bestD = 44 / scale;
			corners.forEach((c, i) => { const d = Math.hypot(c[0] - p[0], c[1] - p[1]); if (d < bestD) { bestD = d; best = i; } });
			if (best < 0) return;
			drag = best;
			cv.setPointerCapture(e.pointerId);
			e.preventDefault();
		};
		cv.onpointermove = (e) => {
			if (drag < 0) return;
			const [x, y] = at(e);
			corners[drag] = [Math.min(photo.width, Math.max(0, x)), Math.min(photo.height, Math.max(0, y))];
			draw();
		};
		cv.onpointerup = cv.onpointercancel = () => (drag = -1);
		const onResize = () => draw();
		addEventListener("resize", onResize);
		draw();
		box.scrollIntoView({ block: "nearest" });
		return new Promise((resolve) => {
			const done = (canvas) => {
				removeEventListener("resize", onResize);
				box.classList.add("hidden");
				resolve(canvas);
			};
			$("crop-skip").onclick = () => done(null);
			$("crop-whole").onclick = () => done($("crop-clean").checked ? Receipt.cleanUp(photo) : photo);
			$("crop-use").onclick = () => {
				const out = Receipt.warp(photo, corners, 2000);
				done($("crop-clean").checked ? Receipt.cleanUp(out) : out);
			};
		});
	}
	// ------------------------------------------------------------- Network scanner (eSCL / AirScan, through the Ledger server)
	let scanner = null;
	const SOURCE_LABEL = { Platen: "Glass", Feeder: "Document feeder" };
	async function loadScanner() {
		try { scanner = await api("/scanner"); } catch (e) { scanner = { configured: false, error: e.message }; }
		drawScanner();
	}
	function drawScanner() {
		const box = $("scanner");
		const s = scanner;
		$("bridge").open = !s.configured && !!s.admin;
		if (!s.configured) {
			box.replaceChildren(...[
				el("div", {}, "No scanner is set up. A scanner or printer with AirScan (eSCL) on your network works: most HP, Canon, Epson, Brother and Xerox models from the last ten years."),
				s.admin ? setupScanner() : el("div", { class: "muted", style: "margin-top:0.4rem" }, "An admin can set one up here."),
			].filter(Boolean));
			return;
		}
		if (!s.reachable) {
			box.replaceChildren(...[
				el("div", { class: "bad" }, `The scanner at ${s.url} isn't answering: ${s.error}`),
				el("div", { class: "row", style: "margin-top:0.4rem" }, el("button", { class: "btn", onclick: loadScanner }, "Try again"), s.admin ? el("button", { class: "btn", onclick: () => { box.append(setupScanner()); } }, "Change scanner") : null),
			].filter(Boolean));
			return;
		}
		const source = el("select", {}, ...s.sources.map((x) => el("option", { value: x.id }, SOURCE_LABEL[x.id] || x.id)));
		if (s.adf === "ScannerAdfLoaded" && s.sources.some((x) => x.id === "Feeder")) source.value = "Feeder";
		const color = el("select", {}, el("option", { value: "color" }, "Colour"), el("option", { value: "gray" }, "Grey"));
		const res = el("select", {});
		const duplex = el("input", { type: "checkbox" });
		const duplexLabel = el("label", { class: "inline" }, duplex, "Both sides");
		const name = el("input", { type: "text", maxlength: "255", placeholder: "File name (optional)", style: "flex:1;min-width:10rem" });
		const syncSource = () => {
			const src = s.sources.find((x) => x.id === source.value);
			const list = src.resolutions.length ? src.resolutions.filter((r) => r <= 600) : [150, 300];
			res.replaceChildren(...list.map((r) => el("option", { value: String(r) }, `${r} dpi`)));
			res.value = String(list.reduce((b, r) => (Math.abs(r - 300) < Math.abs(b - 300) ? r : b), list[0]));
			duplexLabel.classList.toggle("hidden", !src.duplex);
			color.querySelector('[value="gray"]').disabled = src.colorModes.length > 0 && !src.colorModes.includes("Grayscale8");
		};
		source.onchange = syncSource;
		syncSource();
		const msg = el("span", { class: "muted" });
		const go = el("button", { class: "btn primary big", onclick: async () => {
			go.disabled = true;
			msg.textContent = "Starting…";
			try {
				let job = await api("/scans", { method: "POST", body: JSON.stringify({ source: source.value, color: color.value, resolution: Number(res.value), duplex: !duplexLabel.classList.contains("hidden") && duplex.checked, ...(name.value.trim() ? { name: name.value.trim() } : {}) }) });
				while (job.status === "scanning") {
					msg.textContent = job.pages ? `Scanning… ${job.pages} page${job.pages === 1 ? "" : "s"}` : "Scanning…";
					await new Promise((r) => setTimeout(r, 1500));
					job = await api(`/scans/${job.id}`);
				}
				if (job.status === "error") throw new Error(job.error);
				msg.textContent = "";
				name.value = "";
				toast(`Scanned: ${job.file_name}${job.pages > 1 ? ` (${job.pages} pages)` : ""}.`);
				if (job.file_id) Inbox.show(job.file_id); // its Send panel: a bill, a receipt, Extract data, another module
				else showTab("inbox");
			} catch (e) { msg.textContent = ""; fail(e); } finally { go.disabled = false; }
		} }, "Scan");
		box.replaceChildren(...[
			el("div", {}, el("strong", {}, s.name), el("span", { class: "muted" }, ` · ${s.state === "Idle" || !s.state ? "ready" : s.state.toLowerCase()}${s.adf === "ScannerAdfLoaded" ? " · paper in the feeder" : ""}`)),
			el("div", { class: "row", style: "margin-top:0.5rem" }, source, color, res, duplexLabel),
			el("div", { class: "row", style: "margin-top:0.5rem" }, name),
			el("div", { class: "row", style: "margin-top:0.6rem" }, go, msg, el("span", { class: "spacer" }), s.admin ? el("button", { class: "btn", onclick: (e) => { e.target.replaceWith(setupScanner()); } }, "Change scanner") : null),
		].filter(Boolean));
	}
	/** For admins: find scanners on the network, or type an address. */
	function setupScanner() {
		const list = el("div", { class: "found" });
		const addr = el("input", { type: "text", placeholder: "or its address, e.g. 192.168.1.40", style: "flex:1;min-width:10rem" });
		const use = async (url) => {
			try {
				scanner = await api("/scanner", { method: "POST", body: JSON.stringify({ url }) });
				toast(url ? `Using ${scanner.name}.` : "Scanner removed.");
				drawScanner();
			} catch (e) { fail(e); }
		};
		const find = el("button", { class: "btn primary", onclick: async () => {
			find.disabled = true;
			list.replaceChildren(el("span", { class: "muted" }, "Looking on the network…"));
			try {
				const { data } = await api("/scanner/find", { method: "POST", body: "{}" });
				list.replaceChildren(...(data.length ? data.map((d) => el("div", { class: "row", style: "margin-top:0.3rem" }, el("span", {}, d.name, el("span", { class: "muted" }, ` · ${d.url}`)), el("span", { class: "spacer" }), el("button", { class: "btn", onclick: () => use(d.url) }, "Use"))) : [el("span", { class: "muted" }, "None found. The Ledger server must be on the same network as the scanner (a container may need host networking). Type its address instead: it's on the scanner's screen or network settings page.")]));
			} catch (e) { list.replaceChildren(); fail(e); } finally { find.disabled = false; }
		} }, "Find scanners");
		return el("div", { style: "margin-top:0.6rem" },
			el("div", { class: "row" }, find, addr, el("button", { class: "btn", onclick: () => use(addr.value) }, "Use this address"), scanner?.configured ? el("button", { class: "btn danger", onclick: () => use("") }, "Remove") : null),
			list,
		);
	}

	/** Wires the tab's fixed controls; called once by the page. */
	function init() {
		$("scan-camera").onchange = (e) => addPhotos(e.target);
		$("scan-pick").onchange = (e) => addPhotos(e.target);
		api("/app").then((a) => { $("app-apk").href = a.apk_url; }).catch(() => {});
		try { $("app-server").textContent = (window.top.location || location).origin; } catch { $("app-server").textContent = location.origin; }
		$("scan-clear").onclick = () => { pages.forEach((p) => URL.revokeObjectURL(p.url)); pages = []; $("scan-name").value = ""; $("scan-note").value = ""; drawPages(); };
		$("scan-upload").onclick = async () => {
			const btn = $("scan-upload");
			let name = $("scan-name").value.trim().replace(/[\u0000-\u001f/\\]/g, "-") || defaultScanName();
			if (!/\.pdf$/i.test(name)) name += ".pdf";
			btn.disabled = true;
			btn.textContent = "Saving…";
			try {
				const pdf = jpegsToPdf(pages);
				const extra = $("scan-note").value.trim();
				const note = `Scanned with a phone camera (${pages.length} page${pages.length === 1 ? "" : "s"})${extra ? `: ${extra}` : ""}`.slice(0, 1000);
				const f = await Inbox.uploadBytes(name.slice(-255), "application/pdf", pdf, "camera", { note });
				$("scan-clear").onclick();
				toast(`Saved ${f.name} to the inbox.${f.duplicate_of ? " (The same file arrived before.)" : ""}`);
				Inbox.show(f.id); // its Send panel: a receipt, a bill, another module
			} catch (e) { fail(e); } finally { btn.disabled = false; btn.textContent = "Save to inbox"; }
		};
		if (MOBILE) {
			$("camera-box").classList.remove("hidden");
			$("in-get-ext").classList.add("hidden"); // the extension is for desktop browsers
		}
		// ------------------------------------------------------------- Upload files
		$("upload-files").onchange = async (e) => {
			const list = [...e.target.files];
			e.target.value = "";
			let last = null;
			for (const [i, file] of list.entries()) {
				$("upload-msg").textContent = `Uploading ${file.name} (${i + 1} of ${list.length})…`;
				try {
					last = await Inbox.uploadBytes(Inbox.safeName(file.name), file.type, new Uint8Array(await file.arrayBuffer()));
				} catch (err) { fail(new Error(`${file.name}: ${err.message}`)); }
			}
			$("upload-msg").textContent = last ? `Uploaded ${list.length === 1 ? last.name : `${list.length} files`} to the inbox.` : "";
			if (last && list.length === 1) Inbox.show(last.id);
			else if (last) showTab("inbox");
		};
	}


	return { init, load: () => { if (scanner === null) loadScanner(); } };
})();
