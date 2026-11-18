// Network scanner (lib/escl.mjs): a scanner or printer with AirScan / eSCL on the local network,
// set up by an admin, used by everyone. Scans run in the background (a feeder of pages takes a
// while); the page polls GET /scans/:id. A scan becomes one PDF, filed in Ledger's Documents and
// listed in the inbox.

import { randomUUID } from "node:crypto";
import { capabilities, findScanners, normalizeScannerUrl, scan, ScannerError, status as scannerStatus } from "./escl.mjs";
import { jpegsToPdf } from "./pdf.mjs";

const NAME_RE = /^[^\u0000-\u001f/\\]{1,255}$/;

/** h: { q, T, bad, saveFile(name, type, data, opts), options(), syncNotice() } */
export function registerScanner(ctx, h) {
	const { bad, saveFile, options, syncNotice } = h;

	const scannerUrl = async () => String((await ctx.settings.get()).scanner_url ?? "").trim();

	// GET /scanner: the scanner set up for this organization, what it can do, and whether it's ready.
	ctx.route("GET", "/scanner", async (req) => {
		const admin = req.user.role === "admin";
		const raw = await scannerUrl();
		if (!raw) return { configured: false, admin };
		try {
			const url = normalizeScannerUrl(raw);
			const [caps, st] = await Promise.all([capabilities(url), scannerStatus(url).catch(() => null)]);
			return { configured: true, admin, reachable: true, url, name: caps.name, sources: caps.sources, state: st?.state ?? "", adf: st?.adf ?? "" };
		} catch (err) {
			if (!(err instanceof ScannerError)) throw err;
			return { configured: true, admin, reachable: false, url: raw, error: err.message };
		}
	});

	// POST /scanner/find (admins): eSCL scanners announcing themselves on the server's network.
	ctx.route("POST", "/scanner/find", async (req) => {
		if (req.user.role !== "admin") throw new ctx.HttpError(403, "only an admin can set up the scanner");
		return { data: await findScanners() };
	});

	// POST /scanner {url} (admins): use this scanner ("" forgets it). It must answer as an eSCL scanner.
	ctx.route("POST", "/scanner", async (req) => {
		if (req.user.role !== "admin") throw new ctx.HttpError(403, "only an admin can set up the scanner");
		const raw = req.body?.url;
		if (typeof raw !== "string" || raw.length > 300) throw bad("url must be the scanner's address");
		if (raw.trim() === "") {
			await ctx.settings.set({ scanner_url: "" });
			return { configured: false, admin: true };
		}
		let url;
		let caps;
		try {
			url = normalizeScannerUrl(raw);
			caps = await capabilities(url);
		} catch (err) {
			if (err instanceof ScannerError) throw bad(err.message);
			throw err;
		}
		await ctx.settings.set({ scanner_url: url });
		ctx.log.info("scanner set up", { url, name: caps.name, by: req.user.username });
		return { configured: true, admin: true, reachable: true, url, name: caps.name, sources: caps.sources };
	});

	const scans = new Map(); // id -> job (in memory: a scan lasts minutes, not across restarts)
	const publicScan = (j) => ({ id: j.id, status: j.status, pages: j.pages, file_id: j.file_id, file_name: j.file_name, error: j.error, started_at: j.started_at });

	// POST /scans {source?: "Platen"|"Feeder", color?: "color"|"gray", resolution?, duplex?, name?} → 202 {id, status}
	ctx.route("POST", "/scans", async (req) => {
		const b = req.body ?? {};
		if (b.source !== undefined && !["Platen", "Feeder"].includes(b.source)) throw bad('source must be "Platen" (the glass) or "Feeder"');
		if (b.color !== undefined && !["color", "gray"].includes(b.color)) throw bad('color must be "color" or "gray"');
		if (b.resolution !== undefined && !(Number.isInteger(b.resolution) && b.resolution >= 75 && b.resolution <= 1200)) throw bad("resolution must be 75 to 1200 dpi");
		if (b.duplex !== undefined && typeof b.duplex !== "boolean") throw bad("duplex must be true or false");
		let name = b.name === undefined || b.name === "" ? "" : typeof b.name === "string" ? b.name.trim() : null;
		if (name === null || (name && !NAME_RE.test(name))) throw bad("name must be a file name of 1-255 characters");
		const raw = await scannerUrl();
		if (!raw) throw new ctx.HttpError(409, "no scanner is set up; an admin can choose one on the Scan tab");
		const org = (await ctx.orgs.current()).id;
		const running = [...scans.values()].find((j) => j.status === "scanning" && j.url === raw);
		if (running) throw new ctx.HttpError(409, `the scanner is busy with ${running.by}'s scan`);
		for (const [k, j] of scans) if (j.status !== "scanning" && Date.now() - j.started > 3600_000) scans.delete(k);
		const job = { id: randomUUID(), org, url: raw, status: "scanning", pages: 0, file_id: null, file_name: null, error: null, by: req.user.username, started: Date.now(), started_at: new Date().toISOString() };
		scans.set(job.id, job);
		// Not awaited: runs on in the background, in this request's organization.
		(async () => {
			try {
				const url = normalizeScannerUrl(raw);
				const caps = await capabilities(url);
				const r = await scan(url, caps, { source: b.source, color: b.color, resolution: b.resolution ?? 300, duplex: b.duplex, onPage: (n) => (job.pages = n) });
				const jpegs = r.pages.filter((p) => p.type === "image/jpeg").map((p) => p.data);
				const isPdf = r.pages[0].data.subarray(0, 5).toString("latin1") === "%PDF-";
				if (jpegs.length !== r.pages.length && !isPdf) throw new ScannerError(`the scanner sent ${r.pages[0].type} pages, which can't be made into a PDF here`);
				const data = isPdf ? r.pages[0].data : jpegsToPdf(jpegs);
				const { maxBytes } = await options();
				if (data.length > maxBytes) throw new ScannerError(`the scan is ${(data.length / 1048576).toFixed(1)} MB, more than the ${maxBytes / 1048576} MB allowed under Settings → ${ctx.name}; scan at a lower resolution or in grey`);
				const d = new Date();
				const p2 = (n) => String(n).padStart(2, "0");
				let fileName = name || `Scan ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.pdf`;
				if (!/\.pdf$/i.test(fileName) && data.subarray(0, 5).toString("latin1") === "%PDF-") fileName = `${fileName}.pdf`.slice(-255);
				const n = r.pages.length;
				job.file_id = await saveFile(fileName, "application/pdf", data, {
					origin: "scanner",
					detail: caps.name,
					note: `Scanned on ${caps.name}${r.source === "Feeder" ? " (feeder)" : ""}${jpegs.length ? `, ${n} page${n === 1 ? "" : "s"}` : ""}, ${r.resolution} dpi`,
					by: job.by,
					user: req.user,
				});
				job.file_name = fileName;
				job.pages = jpegs.length || job.pages;
				job.status = "done";
				await syncNotice();
			} catch (err) {
				job.status = "error";
				job.error = err instanceof ScannerError ? err.message : `the scan failed: ${String(err?.message || err)}`;
				ctx.log.warn("scan failed", { err: job.error, by: job.by });
			}
		})();
		return ctx.response(202, publicScan(job));
	});

	ctx.route("GET", "/scans/:id", async (req) => {
		const j = scans.get(req.params.id);
		if (!j || j.org !== (await ctx.orgs.current()).id) throw new ctx.HttpError(404, "no such scan");
		return publicScan(j);
	});
}
