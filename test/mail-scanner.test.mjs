// The scanner client (lib/escl.mjs), the PDF maker (lib/pdf.mjs), the saved-email reader
// (lib/eml.mjs) and the email check (lib/mail.mjs), which the Import module brought along.
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";
import { capabilities, isLocalAddress, normalizeScannerUrl, parseDns, scan, ScannerError, status } from "../lib/escl.mjs";
import { emailCandidates, htmlToText, looksLikeBill, registerMail, sentByMe } from "../lib/mail.mjs";
import { decodeWords, parseEml } from "../lib/eml.mjs";
import { jpegInfo, jpegsToPdf } from "../lib/pdf.mjs";

const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAA8ACgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP//Z", "base64"); // 40 x 60, RGB

test("jpegInfo reads a JPEG's size; jpegsToPdf makes one page per JPEG", () => {
	assert.deepEqual(jpegInfo(JPEG), { width: 40, height: 60, components: 3 });
	assert.equal(jpegInfo(Buffer.from("%PDF-1.4")), null);
	const pdf = jpegsToPdf([JPEG, JPEG]).toString("latin1");
	assert.match(pdf, /^%PDF-1\.4/);
	assert.match(pdf, /\/Count 2/);
	assert.equal(pdf.match(/\/DCTDecode/g).length, 2);
	// every xref offset points at its object
	const xref = pdf.slice(pdf.lastIndexOf("xref"));
	const offsets = [...xref.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
	offsets.forEach((o, i) => assert.ok(pdf.startsWith(`${i + 1} 0 obj`, o), `object ${i + 1}`));
	assert.throws(() => jpegsToPdf([Buffer.from("nope")]), /isn't a JPEG/);
});

test("only scanners on the local network", () => {
	for (const ip of ["192.168.1.40", "10.0.0.5", "172.20.1.1", "169.254.3.4", "100.101.102.103", "127.0.0.1", "fd12::1", "fe80::1", "::1", "::ffff:192.168.0.2"]) assert.ok(isLocalAddress(ip), ip);
	for (const ip of ["8.8.8.8", "172.32.0.1", "1.1.1.1", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.ok(!isLocalAddress(ip), ip);
	// cloud hosts' metadata services are in the local ranges, and are not scanners
	for (const ip of ["169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254", "::ffff:169.254.169.254"]) assert.ok(!isLocalAddress(ip), ip);
	assert.equal(normalizeScannerUrl("192.168.1.40"), "http://192.168.1.40/eSCL");
	assert.equal(normalizeScannerUrl("https://scanner.local:443/eSCL/"), "https://scanner.local/eSCL");
	assert.equal(normalizeScannerUrl("http://10.0.0.9:8080/escl"), "http://10.0.0.9:8080/escl");
	assert.throws(() => normalizeScannerUrl("http://u:p@10.0.0.1"), ScannerError);
	assert.throws(() => normalizeScannerUrl(""), ScannerError);
});

test("a public address is refused before any request", async () => {
	await assert.rejects(capabilities("http://8.8.8.8/eSCL"), /isn't on your local network/);
	await assert.rejects(capabilities("http://169.254.169.254/latest"), /isn't on your local network/);
});

/** A fake eSCL scanner: glass and a feeder holding `sheets` pages. */
function fakeScanner({ sheets = 2, format = "image/jpeg" } = {}) {
	const log = [];
	let left = 0;
	let jobs = 0;
	const server = http.createServer((req, res) => {
		let body = "";
		req.on("data", (c) => (body += c));
		req.on("end", () => {
			log.push(`${req.method} ${req.url}`);
			if (req.url === "/eSCL/ScannerCapabilities") {
				res.setHeader("Content-Type", "text/xml");
				return res.end(`<?xml version="1.0"?><scan:ScannerCapabilities xmlns:scan="x" xmlns:pwg="y"><pwg:MakeAndModel>Acme Scan &amp; Print 9</pwg:MakeAndModel>
					<scan:Platen><scan:PlatenInputCaps><scan:MaxWidth>2550</scan:MaxWidth><scan:MaxHeight>3508</scan:MaxHeight>
					<scan:SettingProfiles><scan:SettingProfile><scan:ColorModes><scan:ColorMode>RGB24</scan:ColorMode><scan:ColorMode>Grayscale8</scan:ColorMode></scan:ColorModes>
					<scan:DocumentFormats><pwg:DocumentFormat>${format}</pwg:DocumentFormat></scan:DocumentFormats>
					<scan:SupportedResolutions><scan:DiscreteResolutions><scan:DiscreteResolution><scan:XResolution>150</scan:XResolution></scan:DiscreteResolution><scan:DiscreteResolution><scan:XResolution>300</scan:XResolution></scan:DiscreteResolution></scan:DiscreteResolutions></scan:SupportedResolutions>
					</scan:SettingProfile></scan:SettingProfiles></scan:PlatenInputCaps></scan:Platen>
					<scan:Adf><scan:AdfSimplexInputCaps><scan:MaxWidth>2550</scan:MaxWidth><scan:MaxHeight>4200</scan:MaxHeight><scan:ColorMode>RGB24</scan:ColorMode><pwg:DocumentFormat>${format}</pwg:DocumentFormat><scan:XResolution>200</scan:XResolution></scan:AdfSimplexInputCaps><scan:AdfDuplexInputCaps/></scan:Adf>
					</scan:ScannerCapabilities>`);
			}
			if (req.url === "/eSCL/ScannerStatus") return res.end("<scan:ScannerStatus><pwg:State>Idle</pwg:State><scan:AdfState>ScannerAdfLoaded</scan:AdfState></scan:ScannerStatus>");
			if (req.method === "POST" && req.url === "/eSCL/ScanJobs") {
				log.push(body);
				left = /<pwg:InputSource>Feeder/.test(body) ? sheets : 1;
				res.statusCode = 201;
				res.setHeader("Location", `/eSCL/ScanJobs/job${++jobs}`);
				return res.end();
			}
			if (/^\/eSCL\/ScanJobs\/job\d+\/NextDocument$/.test(req.url)) {
				if (left-- > 0) {
					res.setHeader("Content-Type", format);
					return res.end(format === "image/jpeg" ? JPEG : Buffer.from("%PDF-1.4 all pages"));
				}
				res.statusCode = 404;
				return res.end();
			}
			if (req.method === "DELETE") return res.end();
			res.statusCode = 404;
			res.end();
		});
	});
	return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ root: `http://127.0.0.1:${server.address().port}/eSCL`, log, close: () => server.close() })));
}

test("eSCL: capabilities, status, a glass scan and a feeder scan", async () => {
	const s = await fakeScanner({ sheets: 3 });
	try {
		const caps = await capabilities(s.root);
		assert.equal(caps.name, "Acme Scan & Print 9");
		assert.deepEqual(caps.sources.map((x) => x.id), ["Platen", "Feeder"]);
		assert.deepEqual(caps.sources[0].resolutions, [150, 300]);
		assert.deepEqual(caps.sources[0].colorModes, ["RGB24", "Grayscale8"]);
		assert.equal(caps.sources[1].duplex, true);
		assert.deepEqual(await status(s.root), { state: "Idle", adf: "ScannerAdfLoaded" });

		const glass = await scan(s.root, caps, { source: "Platen", color: "gray", resolution: 280 });
		assert.equal(glass.pages.length, 1);
		assert.equal(glass.resolution, 300);
		assert.match(s.log.find((l) => l.includes("ScanSettings")), /Grayscale8[\s\S]*<scan:XResolution>300/);

		let seen = 0;
		const feeder = await scan(s.root, caps, { source: "Feeder", duplex: true, onPage: (n) => (seen = n) });
		assert.equal(feeder.pages.length, 3);
		assert.equal(seen, 3);
		assert.ok(feeder.pages.every((p) => p.type === "image/jpeg"));
		assert.match(s.log.filter((l) => l.includes("ScanSettings")).at(-1), /<scan:Duplex>true/);
		await new Promise((r) => setTimeout(r, 100)); // the job is cleaned up without waiting
		assert.ok(s.log.includes("DELETE /eSCL/ScanJobs/job2"));
	} finally {
		s.close();
	}
});

test("eSCL: a scanner offering only PDF gives one PDF for the whole feeder", async () => {
	const s = await fakeScanner({ sheets: 4, format: "application/pdf" });
	try {
		const r = await scan(s.root, await capabilities(s.root), { source: "Feeder" });
		assert.equal(r.pages.length, 1);
		assert.equal(r.pages[0].type, "application/pdf");
	} finally {
		s.close();
	}
});

test("eSCL: something that isn't a scanner", async () => {
	const server = http.createServer((req, res) => res.end("<html>router</html>"));
	await new Promise((r) => server.listen(0, "127.0.0.1", r));
	try {
		await assert.rejects(capabilities(`http://127.0.0.1:${server.address().port}/eSCL`), /doesn't answer as an eSCL/);
	} finally {
		server.close();
	}
});

test("mDNS answers: PTR, SRV, TXT and A records", () => {
	const name = (n) => Buffer.concat([...n.split(".").map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
	const rr = (n, type, data) => { const h = Buffer.alloc(10); h.writeUInt16BE(type, 0); h.writeUInt16BE(1, 2); h.writeUInt32BE(120, 4); h.writeUInt16BE(data.length, 8); return Buffer.concat([name(n), h, data]); };
	const srv = Buffer.concat([Buffer.from([0, 0, 0, 0, 0x01, 0xbb]), name("acme.local")]);
	const txt = Buffer.concat(["rs=eSCL", "ty=Acme 9"].map((t) => Buffer.concat([Buffer.from([t.length]), Buffer.from(t)])));
	const header = Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 3]);
	const msg = Buffer.concat([header, rr("_uscans._tcp.local", 12, name("Acme._uscans._tcp.local")), rr("Acme._uscans._tcp.local", 33, srv), rr("Acme._uscans._tcp.local", 16, txt), rr("acme.local", 1, Buffer.from([192, 168, 1, 40]))]);
	const recs = parseDns(msg);
	assert.deepEqual(recs.map((r) => r.type), [12, 33, 16, 1]);
	assert.equal(recs[0].data, "Acme._uscans._tcp.local");
	assert.deepEqual(recs[1].data, { port: 443, target: "acme.local" });
	assert.deepEqual(recs[2].data, { rs: "eSCL", ty: "Acme 9" });
	assert.equal(recs[3].data, "192.168.1.40");
});

test("email: attachments worth importing, keyword filter, own mail", () => {
	const atts = [
		{ attachmentId: "a1", filename: "logo.png", mimeType: "image/png", size: 500 },
		{ attachmentId: "a2", filename: "", mimeType: "image/jpeg", size: 31_000 },
		{ attachmentId: "a3", filename: "a/b.csv", mimeType: "text/csv", size: 12 },
		{ attachmentId: "a4", filename: "huge.pdf", mimeType: "application/pdf", size: 200 },
		{ attachmentId: "a5", filename: "invite.ics", mimeType: "text/calendar", size: 900 },
	];
	assert.deepEqual(emailCandidates(atts, 100).map((d) => d.name), ["a-b.csv"]);
	assert.deepEqual(emailCandidates(atts, 1 << 20).map((d) => [d.attachmentId, d.name]), [["a2", "photo.jpg"], ["a3", "a-b.csv"], ["a4", "huge.pdf"]]);
	const email = { subject: "Your Rogers bill", from: "Rogers <billing@rogers.com>", text: "Amount due: $85.50", attachments: atts };
	assert.ok(looksLikeBill(email, ["amount due"]));
	assert.ok(!looksLikeBill(email, ["mortgage"]));
	assert.ok(looksLikeBill(email, []));
	assert.ok(sentByMe({ from: "me@x.com", to: "them@y.com" }, "me@x.com"));
	assert.ok(!sentByMe({ from: "me@x.com", to: "me@x.com" }, "me@x.com"));
	assert.equal(htmlToText("<html><head><style>p{}</style></head><body><p>Amount due: <b>$85.50</b></p></body></html>"), "Amount due: $85.50");
});

/** registerMail against a stand-in ctx: a mailbox of messages, Ledger's tables as arrays. */
function fakeLedger(messages, { status = { connected: true, kind: "imap", account: "me@example.com", canRead: true, canSend: false }, settings = {}, hold = async () => "", known = () => false } = {}) {
	const routes = new Map();
	const seen = [];
	const training = [];
	const saved = [];
	let state = {};
	const calls = [];
	const ctx = {
		id: "categorizer", name: "Auto sort",
		route: (method, path, fn) => routes.set(`${method} ${path}`, fn),
		HttpError: class extends Error { constructor(status, message) { super(message); this.status = status; } },
		settings: { get: async () => ({ mail_source: "imap", mail_keywords: "bill, invoice", mail_lookback_days: 30, ...settings }) }, // "imap": a choice from an older version
		orgs: { current: async () => ({ id: 1 }), forEach: async () => {} },
		dashboard: { remove: async (key) => calls.push(`remove ${key}`), notify: async (n) => calls.push(`notify ${n.body}`), todo: async (t) => calls.push(`todo ${t.title}`) },
		log: { info() {}, warn() {}, error() {} },
		mail: {
			status: async () => status,
			search: async (query) => {
				calls.push(`search ${JSON.stringify(query)}`);
				const list = [...messages.values()].filter((m) => (!query.before || m.date.slice(0, 10) < query.before) && (!query.since || m.date.slice(0, 10) >= query.since)).sort((a, b) => b.date.localeCompare(a.date));
				return { messages: list.slice(0, query.max).map(({ id, date, from, to, subject }) => ({ id, date, from, to, subject, snippet: "" })) };
			},
			message: async (id) => {
				const m = messages.get(id);
				if (!m) throw Object.assign(new Error("gone"), { status: 404 });
				return { ...m, attachments: (m.attachments ?? []).map(({ data, ...a }) => ({ ...a, size: data.length })) };
			},
			attachment: async (id, attachmentId) => (calls.push(`attachment ${id} ${attachmentId}`), messages.get(id).attachments.find((a) => a.attachmentId === attachmentId).data),
			raw: async (id) => Buffer.from(`Subject: ${messages.get(id).subject}\r\n\r\nbody`),
		},
	};
	const q = async (sql, params = []) => {
		if (/SELECT uid FROM/.test(sql)) return { rows: seen.filter((r) => r.folder === params[0] && params[1].includes(r.uid)).map((r) => ({ uid: r.uid })) };
		if (/SELECT label, features/.test(sql)) return { rows: training };
		if (/INSERT INTO mail_seen/.test(sql)) {
			const upsert = /DO UPDATE/.test(sql);
			const row = { folder: params[0], uid: params[1], outcome: params[2], files: params[3], reason: upsert ? "" : params[6], subject: params[4], mail_from: params[5] };
			const old = seen.find((r) => r.folder === row.folder && r.uid === row.uid);
			if (!old) seen.push(row);
			else if (upsert) Object.assign(old, { outcome: row.outcome, files: old.files + row.files, reason: "" });
			return { rows: [] };
		}
		if (/SELECT (outcome, )?(files, )?reason FROM mail_seen/.test(sql)) return { rows: seen.filter((r) => r.folder === params[0] && r.uid === params[1]) };
		if (/SELECT id FROM inbox_files WHERE sha256/.test(sql)) return { rows: saved.filter((f) => f.sha === params[0]).map((f, i) => ({ id: i + 1 })) };
		if (/INSERT INTO module_state/.test(sql)) return void (state = { ...state, ...JSON.parse(params[0]) }) ?? { rows: [] };
		if (/SELECT value FROM module_state/.test(sql)) return { rows: [{ value: state }] };
		throw new Error(`unexpected SQL: ${sql}`);
	};
	const h = {
		q, T: (t) => t, maxBytes: async () => 25 << 20, syncNotice: async () => {}, learnKept: async (ids) => calls.push(`learnKept ${ids}`),
		hold,
		// skipKnown: a file that is a bill's or a statement's document already isn't added again (null).
		saveFile: async (name, type, data, opts) => (opts.skipKnown && known(data) ? null : (saved.push({ name, type, bytes: data.length, data, sha: createHash("sha256").update(data).digest("hex"), ...opts }), saved.length)),
		getFile: async (id) => {
			const f = saved[Number(id) - 1];
			if (!f) throw new ctx.HttpError(404, "no such file");
			return { id: Number(id), name: f.name, content_type: f.type, size_bytes: f.bytes, origin: f.origin ?? "", mail_folder: f.mail?.folder ?? "", mail_uid: f.mail?.uid ?? "" };
		},
		fileBytes: async (f) => saved[f.id - 1].data,
	};
	const { checkMail } = registerMail(ctx, h);
	return { checkMail, routes, ctx, seen, training, saved, calls, user: { username: "pat" }, state: () => state };
}

const pdf = (n) => Buffer.from(`%PDF-1.4 ${n} ${"x".repeat(100)}`);
const msg = (id, date, from, subject, attachments = [], text = "") => [id, { id, date: `${date}T10:00:00.000Z`, from, to: "me@example.com", cc: "", subject, text, html: "", attachments }];

test("email check through Ledger's mailbox: files, .eml, filters, each message once", async () => {
	const today = new Date().toISOString().slice(0, 10);
	const box = new Map([
		msg("7.1", today, "Hydro One <bills@hydroone.com>", "Your October bill", [{ attachmentId: "p1", filename: "invoice-1001.pdf", mimeType: "application/octet-stream", data: pdf(1) }, { attachmentId: "p2", filename: "logo.png", mimeType: "image/png", data: Buffer.alloc(300) }]),
		msg("7.2", today, "City <water@city.example>", "Water invoice ready", [], "Amount due 40.00"),
		msg("7.3", today, "Shop <news@shop.example>", "Weekend sale", [{ attachmentId: "p3", filename: "flyer.pdf", mimeType: "application/pdf", data: pdf(3) }]),
		msg("7.4", today, "Me <me@example.com>", "Fwd: bill for you", [{ attachmentId: "p4", filename: "x.pdf", mimeType: "application/pdf", data: pdf(4) }]),
	]);
	box.get("7.4").to = "client@else.example";
	const L = fakeLedger(box);
	const r = await L.checkMail({ trigger: "manual", by: "pat", user: L.user });
	assert.deepEqual({ looked_at: r.looked_at, files: r.files, emails_saved: r.emails_saved, filtered: r.filtered, sent: r.sent }, { looked_at: 4, files: 1, emails_saved: 1, filtered: 1, sent: 1 });
	assert.deepEqual(L.saved.map((s) => [s.name, s.type, s.origin, s.detail]), [["invoice-1001.pdf", "application/pdf", "email", "Hydro One"], ["Water invoice ready.eml", "message/rfc822", "email", "City"]]);
	assert.equal(L.saved[0].user, L.user, "the person who pressed Check is passed on (documents are filed in their name)");
	assert.ok(L.seen.every((s) => s.folder === "imap:me@example.com"));
	assert.ok(!L.calls.some((c) => c.includes("p2") || c.includes("p3")), "logos and filtered emails' attachments aren't downloaded");
	assert.equal(L.state().error, null);
	// again: nothing twice
	const again = await L.checkMail();
	assert.equal(again.looked_at, 0);
	assert.equal(L.saved.length, 2);
});

test("email check: what was learned skips before downloading; import anyway", async () => {
	const today = new Date().toISOString().slice(0, 10);
	const box = new Map([msg("9.1", today, "Hydro One <bills@hydroone.com>", "Your November bill", [{ attachmentId: "t1", filename: "terms-and-conditions.pdf", mimeType: "application/pdf", data: pdf(9) }, { attachmentId: "i1", filename: "invoice-1102.pdf", mimeType: "application/pdf", data: pdf(8) }])]);
	const L = fakeLedger(box);
	const { features } = await import("../lib/learn.mjs");
	L.training.push({ label: -1, features: features({ from: "Hydro One <bills@hydroone.com>", subject: "Your October bill" }, { name: "terms-and-conditions.pdf" }) });
	const r = await L.checkMail();
	assert.equal(r.files, 1);
	assert.equal(r.files_skipped, 1);
	assert.deepEqual(L.saved.map((s) => s.name), ["invoice-1102.pdf"]);
	assert.ok(!L.calls.includes("attachment 9.1 t1"), "the skipped attachment wasn't downloaded");
	assert.match(L.seen[0].reason, /terms-and-conditions\.pdf: looks like 1 file you deleted/);
	const out = await L.routes.get("POST /mail/skipped/import")({ body: { folder: "imap:me@example.com", uid: "9.1" }, user: L.user });
	assert.equal(out.files, 1, "the invoice is in the inbox already; only the skipped file comes in");
	await assert.rejects(L.routes.get("POST /mail/skipped/import")({ body: { folder: "gmail:other@example.com", uid: "9.1" }, user: L.user }), /no such skipped email/);
});

test("email check: more than 100 messages are walked back by date; no mailbox says where to set one up", async () => {
	const box = new Map();
	for (let i = 0; i < 230; i++) {
		const d = new Date(Date.now() - (i % 23) * 86_400_000).toISOString().slice(0, 10);
		const [id, m] = msg(`5.${i}`, d, "Shop <news@shop.example>", `Newsletter ${i}`);
		box.set(id, m);
	}
	const L = fakeLedger(box);
	const r = await L.checkMail();
	assert.equal(r.looked_at + r.remaining, 230, "every message in the window is found");
	assert.ok(L.calls.filter((c) => c.startsWith("search")).length >= 3);
	const none = fakeLedger(new Map(), { status: { connected: false, kind: null, account: null, canRead: false, canSend: false } });
	const e = await none.checkMail();
	assert.match(e.error, /no mailbox is connected.*Settings → Mail/);
	const mail = await none.routes.get("GET /mail")({});
	assert.match(mail.missing, /Settings → Mail/);
});

test("email date range: imports those days only, in the background, without duplicates", async () => {
	const box = new Map([
		msg("8.1", "2026-03-02", "Hydro One <bills@hydroone.com>", "Your March bill", [{ attachmentId: "a", filename: "march.pdf", mimeType: "application/pdf", data: pdf(31) }]),
		msg("8.2", "2026-03-15", "Bell <bills@bell.ca>", "Your bill", [{ attachmentId: "b", filename: "bell.pdf", mimeType: "application/pdf", data: pdf(32) }]),
		// the same PDF sent again in another email: one inbox file
		msg("8.3", "2026-03-20", "Bell <bills@bell.ca>", "Reminder: your bill", [{ attachmentId: "c", filename: "bell-copy.pdf", mimeType: "application/pdf", data: pdf(32) }]),
		msg("8.4", "2026-03-31", "Gas <bills@gas.example>", "Your bill", [{ attachmentId: "d", filename: "gas.pdf", mimeType: "application/pdf", data: pdf(34) }]),
		msg("8.5", "2026-04-01", "Gas <bills@gas.example>", "Your April bill", [{ attachmentId: "e", filename: "april.pdf", mimeType: "application/pdf", data: pdf(35) }]),
		msg("8.6", "2026-02-28", "Gas <bills@gas.example>", "Your Feb bill", [{ attachmentId: "f", filename: "feb.pdf", mimeType: "application/pdf", data: pdf(36) }]),
	]);
	const L = fakeLedger(box);
	const post = L.routes.get("POST /mail/range");
	const get = L.routes.get("GET /mail/range");
	L.ctx.response = (status, body) => ({ status, body });
	const wait = async () => { for (let i = 0; i < 50 && (await get({})).job?.status === "running"; i++) await new Promise((r) => setTimeout(r, 5)); return (await get({})).job; };

	await assert.rejects(post({ body: { from: "2026-03-31", to: "2026-03-01" }, user: L.user }), (e) => e.status === 422);
	await assert.rejects(post({ body: { from: "2026-02-30", to: "2026-03-01" }, user: L.user }), (e) => e.status === 422);
	await assert.rejects(post({ body: {}, user: L.user }), (e) => e.status === 422);

	const started = await post({ body: { from: "2026-03-01", to: "2026-03-31" }, user: L.user });
	assert.equal(started.status, 202);
	const job = await wait();
	assert.equal(job.status, "done");
	assert.deepEqual(L.saved.map((s) => s.name), ["march.pdf", "bell.pdf", "gas.pdf"], "only March (both ends included), the repeated PDF once");
	assert.equal(job.result.duplicates, 1);
	assert.equal(job.result.files, 3);
	assert.equal(L.seen.find((s) => s.uid === "8.3").outcome, "duplicate");

	// a wider range again: what's been looked at is left out
	await post({ body: { from: "2026-02-01", to: "2026-04-30" }, user: L.user });
	const again = await wait();
	assert.equal(again.result.already_seen, 4);
	assert.deepEqual(L.saved.slice(3).map((s) => s.name).sort(), ["april.pdf", "feb.pdf"]);
});

test("viewing an email before importing it by hand: attachments open without importing, then import what's ticked", async () => {
	const today = new Date().toISOString().slice(0, 10);
	const box = new Map([
		msg("6.1", today, "Hydro One <bills@hydroone.com>", "Your October bill", [{ attachmentId: "h1", filename: "invoice.pdf", mimeType: "application/octet-stream", data: pdf(61) }, { attachmentId: "h2", filename: "terms.docx", mimeType: "application/msword", data: Buffer.from("terms") }]),
		msg("6.2", today, "City <water@city.example>", "Water invoice ready", [], ""),
	]);
	box.get("6.2").html = "<p>Amount&nbsp;due:<br><b>$40.00</b></p><script>x()</script><p>Thanks &amp; bye</p>";
	const L = fakeLedger(box, { settings: { mail_review: true } });
	const r = await L.checkMail();
	assert.equal(r.files, 1, "an old 'look before importing' setting does nothing any more");
	assert.equal(r.waiting, undefined);
	assert.equal(L.routes.get("GET /mail/waiting"), undefined);
	assert.equal(L.routes.get("POST /mail/message/dismiss"), undefined);
	const folder = L.seen[0].folder;
	const query = (o) => new URLSearchParams(o);

	const v = await L.routes.get("GET /mail/message")({ query: query({ id: "6.1", folder }) });
	assert.equal(v.subject, "Your October bill");
	assert.deepEqual(v.attachments.map((a) => [a.filename, a.suggested]), [["invoice.pdf", true], ["terms.docx", false]]);
	assert.equal(v.seen.outcome, "files");
	const html = await L.routes.get("GET /mail/message")({ query: query({ id: "6.2" }) });
	assert.equal(html.text, "Amount due:\n$40.00\nThanks & bye", "HTML mail is shown as readable text, scripts left out");
	await assert.rejects(L.routes.get("GET /mail/message")({ query: query({ id: "6.1", folder: "gmail:other@example.com" }) }), (e) => e.status === 409);
	await assert.rejects(L.routes.get("GET /mail/message")({ query: query({ id: "nope" }) }), (e) => e.status === 404);
	await assert.rejects(L.routes.get("GET /mail/message")({ query: query({}) }), (e) => e.status === 422);

	const before = L.saved.length;
	const a = await L.routes.get("GET /mail/message/attachment")({ query: query({ id: "6.1", attachment: "h2", folder }) });
	assert.equal(Buffer.from(a.data, "base64").toString(), "terms");
	assert.equal(L.saved.length, before, "opening an attachment imports nothing");
	await assert.rejects(L.routes.get("GET /mail/message/attachment")({ query: query({ id: "6.1", attachment: "zz" }) }), (e) => e.status === 404);

	const imp = L.routes.get("POST /mail/message/import");
	await assert.rejects(imp({ body: { id: "6.1", attachments: [], email: false }, user: L.user }), (e) => e.status === 422);
	await assert.rejects(imp({ body: { id: "6.1", attachments: ["zz"] }, user: L.user }), (e) => e.status === 422);
	const got = await imp({ body: { id: "6.1", folder, attachments: ["h1", "h2"] }, user: L.user });
	assert.deepEqual({ files: got.files, duplicates: got.duplicates }, { files: 1, duplicates: 1 }, "the invoice was in the inbox already; the terms come in");
	assert.equal(L.saved.at(-1).name, "terms.docx");
	assert.equal(L.saved.at(-1).mail.uid, "6.1");
});

const EML = [
	"From: =?UTF-8?B?SHlkcm8gUXXDqWJlYw==?= <bills@hq.example>",
	"To: me@example.com",
	"Subject: =?utf-8?Q?Votre_facture_d=C3=A9c?= =?utf-8?Q?embre?=",
	"Date: Tue, 10 Nov 2026 10:00:00 +0000",
	"MIME-Version: 1.0",
	'Content-Type: multipart/mixed; boundary="b1"',
	"",
	"--b1",
	'Content-Type: multipart/alternative; boundary="b2"',
	"",
	"--b2",
	"Content-Type: text/plain; charset=utf-8",
	"Content-Transfer-Encoding: quoted-printable",
	"",
	"Montant d=C3=BB : 85,50 $=",
	"",
	"Merci",
	"--b2",
	"Content-Type: text/html; charset=utf-8",
	"",
	"<p>Montant</p>",
	"--b2--",
	"--b1",
	"Content-Type: application/pdf",
	"Content-Disposition: attachment; filename*=UTF-8''facture%20d%C3%A9c.pdf",
	"Content-Transfer-Encoding: base64",
	"",
	Buffer.from("%PDF-1.4 hello").toString("base64"),
	"--b1--",
	"",
].join("\r\n");

test("eml: headers, the text part, attachments with encoded names", () => {
	assert.equal(decodeWords("=?ISO-8859-1?Q?caf=E9?= ok"), "café ok");
	const e = parseEml(Buffer.from(EML, "latin1"));
	assert.equal(e.from, "Hydro Québec <bills@hq.example>");
	assert.equal(e.subject, "Votre facture décembre");
	assert.equal(e.date, "2026-11-10T10:00:00.000Z");
	assert.equal(e.text.trim(), "Montant dû : 85,50 $\r\nMerci");
	assert.equal(e.html, "<p>Montant</p>");
	assert.deepEqual(e.attachments.map((a) => [a.filename, a.content_type, a.data.toString()]), [["facture déc.pdf", "application/pdf", "%PDF-1.4 hello"]]);
	const plain = parseEml(Buffer.from("Subject: hi\n\nJust text\n"));
	assert.equal(plain.text, "Just text\n");
	assert.equal(parseEml(Buffer.from("garbage")).subject, "");
});

test("the email behind an inbox file: an .eml from its bytes, an attachment from the mailbox, before sending it on", async () => {
	const today = new Date().toISOString().slice(0, 10);
	const box = new Map([
		msg("4.1", today, "Hydro One <bills@hydroone.com>", "Your bill", [{ attachmentId: "x1", filename: "invoice.pdf", mimeType: "application/pdf", data: pdf(41) }], "Amount due $10"),
		msg("4.2", today, "City <water@city.example>", "Water invoice ready", [], "Amount due 40.00"),
	]);
	const L = fakeLedger(box);
	await L.checkMail();
	assert.deepEqual(L.saved.map((s) => [s.name, s.mail?.uid]), [["invoice.pdf", "4.1"], ["Water invoice ready.eml", "4.2"]], "each file remembers its email");
	const get = L.routes.get("GET /inbox/:id/email");
	const fromMailbox = await get({ params: { id: "1" } });
	assert.equal(fromMailbox.source, "mailbox");
	assert.equal(fromMailbox.text, "Amount due $10");
	assert.equal(fromMailbox.attachments[0].filename, "invoice.pdf");
	const att = await L.routes.get("GET /inbox/:id/email/attachment")({ params: { id: "1" }, query: new URLSearchParams({ attachment: "x1" }) });
	assert.equal(Buffer.from(att.data, "base64").toString("latin1").slice(0, 5), "%PDF-");

	// an .eml file is read from the inbox's own copy (no mailbox needed)
	L.saved.push({ name: "forwarded.eml", type: "message/rfc822", bytes: EML.length, data: Buffer.from(EML, "latin1"), origin: "upload" });
	const eml = await get({ params: { id: "3" } });
	assert.equal(eml.source, "file");
	assert.equal(eml.subject, "Votre facture décembre");
	assert.deepEqual(eml.attachments.map((a) => a.filename), ["facture déc.pdf"]);
	const a0 = await L.routes.get("GET /inbox/:id/email/attachment")({ params: { id: "3" }, query: new URLSearchParams({ attachment: "0" }) });
	assert.equal(a0.content_type, "application/pdf");
	await assert.rejects(L.routes.get("GET /inbox/:id/email/attachment")({ params: { id: "3" }, query: new URLSearchParams({ attachment: "7" }) }), (e) => e.status === 404);

	// a file that didn't come from email
	L.saved.push({ name: "scan.pdf", type: "application/pdf", bytes: 5, data: pdf(1), origin: "scanner" });
	await assert.rejects(get({ params: { id: "4" } }), (e) => e.status === 404 && /didn't come from email/.test(e.message));
	// the email was deleted from the mailbox since
	box.delete("4.1");
	await assert.rejects(get({ params: { id: "1" } }), (e) => e.status === 404 && /isn't in the mailbox/.test(e.message));
});

test("email check: nothing is imported twice, and it holds off while the Import module's data waits", async () => {
	// A file that is already a bill's document here (uploaded by hand) isn't put in the inbox again.
	const billPdf = pdf("already a bill");
	const messages = new Map();
	const today = new Date().toISOString().slice(0, 10);
	for (const [id, data, name] of [["m1", billPdf, "bill.pdf"], ["m2", pdf("new one"), "new.pdf"]]) messages.set(id, { id, date: `${today}T08:00:00.000Z`, from: "Hydro <bills@hydro.example>", to: "me@example.com", cc: "", subject: "Your bill", text: "", html: "", attachments: [{ attachmentId: `a-${id}`, filename: name, mimeType: "application/pdf", data }] });
	const M = fakeLedger(messages, { known: (data) => data.equals(billPdf) });
	const r = await M.checkMail({ by: "pat", user: M.user });
	assert.equal(r.files, 1);
	assert.equal(r.duplicates, 1);
	assert.deepEqual(M.saved.map((f) => f.name), ["new.pdf"]);
	assert.deepEqual(M.seen.map((s) => s.outcome).sort(), ["duplicate", "files"]);
	// A second check looks at neither message again.
	const again = await M.checkMail({ by: "pat", user: M.user });
	assert.equal(again.looked_at, 0);
	assert.equal(again.already_seen, 2);

	// While the Import module's data hasn't been taken over, the check doesn't read mail at all.
	const H = fakeLedger(messages, { hold: async () => "the Import module's files and email log haven't been taken over yet" });
	const held = await H.checkMail({ by: "pat", user: H.user });
	assert.match(held.error, /haven't been taken over/);
	assert.equal(H.saved.length, 0);
	assert.ok(!H.calls.some((c) => c.startsWith("search")));
	await assert.rejects(H.routes.get("POST /mail/check")({ user: H.user }), (e) => e.status === 409);
});
