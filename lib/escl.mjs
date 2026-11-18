// Network scanners over eSCL ("AirScan", the HTTP protocol behind AirPrint
// scanning: most HP, Canon, Epson, Brother and Xerox scanners and multifunction
// printers since ~2015), driven from the Ledger server so scanning works the
// same from a computer or a phone. No dependencies.
//
//   capabilities(root)  what the scanner can do (glass / feeder, colour, dpi)
//   status(root)        idle or busy, paper in the feeder
//   scan(root, opts)    one job -> [{ type, data }] pages
//   findScanners()      mDNS (_uscan._tcp / _uscans._tcp) on the server's network
//
// Only scanners on the local network are reachable (private, link-local,
// Tailscale and loopback addresses): the address is resolved once and checked, then used
// for the connection, so a name can't later point somewhere else. Scanners
// use self-signed certificates, so https isn't verified (the address check
// is what limits where requests go).

import dgram from "node:dgram";
import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

export class ScannerError extends Error {}

const SCAN_NS = "http://schemas.hp.com/imaging/escl/2011/05/03";
const PWG_NS = "http://www.pwg.org/schemas/2010/12/sm";

/** Cloud hosts' metadata services sit in the link-local, CGNAT and unique local ranges, and are never scanners. */
const METADATA_ADDRESSES = new Set(["169.254.169.254", "169.254.170.2", "100.100.100.200", "fd00:ec2::254"]);

/**
 * Private (RFC 1918, unique local), link-local, CGNAT/Tailscale and loopback addresses (loopback for
 * a scanner bridge such as AirSane on the Ledger machine itself, sharing a USB scanner).
 */
export function isLocalAddress(ip) {
	if (METADATA_ADDRESSES.has(ip)) return false;
	if (net.isIPv4(ip)) {
		const [a, b] = ip.split(".").map(Number);
		return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
	}
	if (net.isIPv6(ip)) {
		const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
		if (v4) return isLocalAddress(v4[1]);
		const first = parseInt(ip.split(":")[0] || "0", 16);
		return ip === "::1" || (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80;
	}
	return false;
}

/** "192.168.1.40", "scanner.local", "https://10.0.0.5:443/eSCL" -> "http(s)://host[:port]/eSCL" (no trailing slash). */
export function normalizeScannerUrl(input) {
	let s = String(input ?? "").trim();
	if (!s) throw new ScannerError("enter the scanner's address, e.g. 192.168.1.40");
	if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
	let u;
	try {
		u = new URL(s);
	} catch {
		throw new ScannerError("that isn't an address, e.g. 192.168.1.40 or http://scanner.local/eSCL");
	}
	if (u.username || u.password || u.search || u.hash) throw new ScannerError("the address can't contain a user name, query or #");
	const path = u.pathname.replace(/\/+$/, "") || "/eSCL";
	return `${u.protocol}//${u.host}${path}`;
}

/** Resolves the URL's host and checks every address is on the local network → the address to connect to. */
async function localTarget(url) {
	const u = new URL(url);
	const host = u.hostname.replace(/^\[|\]$/g, "");
	let addrs;
	if (net.isIP(host)) addrs = [host];
	else {
		try {
			addrs = (await dns.lookup(host, { all: true })).map((a) => a.address);
		} catch {
			throw new ScannerError(`can't find ${host} on the network`);
		}
	}
	if (addrs.length === 0 || !addrs.every(isLocalAddress)) {
		throw new ScannerError(`${host} isn't on your local network; only scanners on it (e.g. 192.168.x.x, 10.x.x.x, *.local) can be used`);
	}
	return { u, host, ip: addrs[0] };
}

/** One HTTP(S) request to a local scanner → { status, headers, body: Buffer }. */
async function request(method, url, { body = null, headers = {}, timeoutMs = 15_000, maxBytes = 60 << 20 } = {}) {
	const { u, host, ip } = await localTarget(url);
	const secure = u.protocol === "https:";
	const lib = secure ? https : http;
	return new Promise((resolve, reject) => {
		const req = lib.request(
			{
				method,
				host: ip,
				port: u.port || (secure ? 443 : 80),
				path: u.pathname + u.search,
				headers: { Host: u.host, ...headers, ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}) },
				servername: secure && !net.isIP(host) ? host : undefined,
				rejectUnauthorized: false, // scanners have self-signed certificates
				timeout: timeoutMs,
			},
			(res) => {
				const chunks = [];
				let size = 0;
				res.on("data", (c) => {
					size += c.length;
					if (size > maxBytes) req.destroy(new ScannerError("the scanner sent more than expected"));
					else chunks.push(c);
				});
				res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
				res.on("error", reject);
			},
		);
		req.on("timeout", () => req.destroy(new ScannerError(`the scanner didn't answer within ${Math.round(timeoutMs / 1000)} s`)));
		req.on("error", (err) => reject(err instanceof ScannerError ? err : new ScannerError(`can't reach the scanner at ${u.host}: ${err.code || err.message}`)));
		if (body) req.write(body);
		req.end();
	});
}

const tags = (xml, name) => [...xml.matchAll(new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`, "g"))].map((m) => m[1].trim());
const first = (xml, name) => tags(xml, name)[0] ?? "";
const section = (xml, name) => new RegExp(`<(?:\\w+:)?${name}>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml)?.[1] ?? "";
const unescape = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

/** What the scanner offers: { name, sources: [{ id: "Platen"|"Feeder", duplex, colorModes, resolutions, formats, maxWidth, maxHeight }] }. */
export async function capabilities(root) {
	const r = await request("GET", `${root}/ScannerCapabilities`, { timeoutMs: 8_000, maxBytes: 2 << 20 });
	if (r.status !== 200 || !/ScannerCapabilities/.test(r.body.toString("utf8"))) {
		throw new ScannerError(`${new URL(root).host} doesn't answer as an eSCL (AirScan) scanner (HTTP ${r.status}); check the address`);
	}
	const xml = r.body.toString("utf8");
	const sources = [];
	for (const [tag, id] of [
		["Platen", "Platen"],
		["Adf", "Feeder"],
	]) {
		const s = section(xml, tag);
		if (!s) continue;
		const caps = section(s, id === "Platen" ? "PlatenInputCaps" : "AdfSimplexInputCaps") || s;
		const uniq = (a) => [...new Set(a)];
		sources.push({
			id,
			duplex: id === "Feeder" && /AdfDuplexInputCaps/.test(s),
			colorModes: uniq(tags(caps, "ColorMode")),
			resolutions: uniq(tags(caps, "XResolution").map(Number).filter((n) => n > 0)).sort((a, b) => a - b),
			formats: uniq([...tags(caps, "DocumentFormat"), ...tags(caps, "DocumentFormatExt")]),
			maxWidth: Number(first(caps, "MaxWidth")) || 2550,
			maxHeight: Number(first(caps, "MaxHeight")) || 3508,
		});
	}
	if (sources.length === 0) throw new ScannerError("the scanner reports no glass or document feeder");
	return { name: unescape(first(xml, "MakeAndModel")) || new URL(root).host, sources };
}

/** { state: "Idle" | "Processing" | ..., adf: "ScannerAdfLoaded" | "ScannerAdfEmpty" | "" } */
export async function status(root) {
	const r = await request("GET", `${root}/ScannerStatus`, { timeoutMs: 8_000, maxBytes: 1 << 20 });
	if (r.status !== 200) throw new ScannerError(`the scanner's status isn't available (HTTP ${r.status})`);
	const xml = r.body.toString("utf8");
	return { state: first(xml, "State"), adf: first(xml, "AdfState") };
}

const pick = (want, list, fallback) => (list.includes(want) ? want : list.length ? list[0] : fallback);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Scans: opts { source: "Platen"|"Feeder", color: "color"|"gray", resolution, duplex, onPage(n) }.
 * → { pages: [{ type: "image/jpeg" | "application/pdf", data }], format, color, resolution, source }
 */
export async function scan(root, caps, opts = {}) {
	const src = caps.sources.find((s) => s.id === opts.source) ?? caps.sources[0];
	const colorWant = opts.color === "gray" ? "Grayscale8" : "RGB24";
	const color = pick(colorWant, src.colorModes, colorWant);
	const res = src.resolutions.length ? src.resolutions.reduce((best, r) => (Math.abs(r - (opts.resolution || 300)) < Math.abs(best - (opts.resolution || 300)) ? r : best)) : opts.resolution || 300;
	// JPEG pages when offered (the PDF is made here, one page per sheet, and image models can read them); else PDF.
	const format = src.formats.includes("image/jpeg") ? "image/jpeg" : src.formats.includes("application/pdf") ? "application/pdf" : src.formats[0] || "image/jpeg";
	const duplex = src.id === "Feeder" && src.duplex && !!opts.duplex;
	const settings = `<?xml version="1.0" encoding="UTF-8"?>
<scan:ScanSettings xmlns:scan="${SCAN_NS}" xmlns:pwg="${PWG_NS}">
  <pwg:Version>2.0</pwg:Version>
  <pwg:ScanRegions pwg:MustHonor="false"><pwg:ScanRegion>
    <pwg:ContentRegionUnits>escl:ThreeHundredthsOfInches</pwg:ContentRegionUnits>
    <pwg:XOffset>0</pwg:XOffset><pwg:YOffset>0</pwg:YOffset>
    <pwg:Width>${src.maxWidth}</pwg:Width><pwg:Height>${src.maxHeight}</pwg:Height>
  </pwg:ScanRegion></pwg:ScanRegions>
  <pwg:InputSource>${src.id}</pwg:InputSource>
  <scan:ColorMode>${color}</scan:ColorMode>
  <scan:XResolution>${res}</scan:XResolution><scan:YResolution>${res}</scan:YResolution>
  <pwg:DocumentFormat>${format}</pwg:DocumentFormat>
  <scan:DocumentFormatExt>${format}</scan:DocumentFormatExt>${duplex ? "\n  <scan:Duplex>true</scan:Duplex>" : ""}
</scan:ScanSettings>`;
	let job;
	for (let attempt = 0; ; attempt++) {
		job = await request("POST", `${root}/ScanJobs`, { body: settings, headers: { "Content-Type": "text/xml" }, timeoutMs: 20_000, maxBytes: 1 << 20 });
		if (job.status === 503 && attempt < 5) {
			await sleep(2000); // busy (e.g. warming up)
			continue;
		}
		break;
	}
	if (job.status === 409) throw new ScannerError(src.id === "Feeder" ? "the document feeder is empty; load the pages and try again" : "the scanner is busy; try again in a moment");
	if (job.status !== 201 || !job.headers.location) throw new ScannerError(`the scanner refused the scan (HTTP ${job.status})`);
	// The job's address must stay on the same scanner.
	const jobUrl = new URL(job.headers.location, `${root}/`);
	const rootUrl = new URL(root);
	if (jobUrl.hostname !== rootUrl.hostname) throw new ScannerError("the scanner answered with an address on another machine");
	if (jobUrl.protocol !== rootUrl.protocol || jobUrl.port !== rootUrl.port) {
		jobUrl.protocol = rootUrl.protocol;
		jobUrl.port = rootUrl.port;
	}
	const base = jobUrl.toString().replace(/\/+$/, "");
	const pages = [];
	try {
		for (let busy = 0; pages.length < 200; ) {
			const r = await request("GET", `${base}/NextDocument`, { timeoutMs: 180_000 });
			if (r.status === 200 && r.body.length > 0) {
				pages.push({ type: String(r.headers["content-type"] || format).split(";")[0].trim(), data: r.body });
				opts.onPage?.(pages.length);
				// The glass holds one sheet; a PDF holds every page; only the feeder's JPEGs come one by one.
				if (src.id === "Platen" || format === "application/pdf") break;
				continue;
			}
			if (r.status === 503 && busy++ < 30) {
				await sleep(1000);
				continue;
			}
			if (r.status === 404 || r.status === 410) break; // no more pages
			const said = /^text\/plain/.test(String(r.headers["content-type"] ?? "")) ? r.body.toString("utf8").trim().slice(0, 300) : "";
			throw new ScannerError(said ? `the scanner says: ${said}` : `the scanner stopped with HTTP ${r.status}`);
		}
	} finally {
		request("DELETE", base, { timeoutMs: 5_000 }).catch(() => {});
	}
	if (pages.length === 0) throw new ScannerError(src.id === "Feeder" ? "no pages came out of the feeder; load them and try again" : "the scanner sent no page");
	return { pages, format, color, resolution: res, source: src.id };
}

// ---------------------------------------------------------------------------
// mDNS discovery
// ---------------------------------------------------------------------------

function dnsQuery(names) {
	const parts = [Buffer.from([0, 0, 0, 0, 0, names.length, 0, 0, 0, 0, 0, 0])];
	for (const name of names) {
		for (const label of name.split(".")) parts.push(Buffer.from([label.length]), Buffer.from(label, "ascii"));
		parts.push(Buffer.from([0, 0, 12, 0x80, 1])); // PTR, class IN with "unicast response please"
	}
	return Buffer.concat(parts);
}

function readName(b, off) {
	const labels = [];
	let jumped = false;
	let end = off;
	for (let guard = 0; guard < 128; guard++) {
		const len = b[off];
		if (len === undefined) throw new Error("bad name");
		if (len === 0) {
			if (!jumped) end = off + 1;
			break;
		}
		if ((len & 0xc0) === 0xc0) {
			if (!jumped) end = off + 2;
			off = ((len & 0x3f) << 8) | b[off + 1];
			jumped = true;
			continue;
		}
		labels.push(b.toString("utf8", off + 1, off + 1 + len));
		off += 1 + len;
	}
	return { name: labels.join("."), end };
}

/** Records of an mDNS answer: [{ name, type, data }]. */
export function parseDns(b) {
	const out = [];
	const qd = b.readUInt16BE(4);
	const total = b.readUInt16BE(6) + b.readUInt16BE(8) + b.readUInt16BE(10);
	let off = 12;
	for (let i = 0; i < qd; i++) off = readName(b, off).end + 4;
	for (let i = 0; i < total; i++) {
		const { name, end } = readName(b, off);
		const type = b.readUInt16BE(end);
		const len = b.readUInt16BE(end + 8);
		const at = end + 10;
		let data = null;
		if (type === 12) data = readName(b, at).name; // PTR
		else if (type === 33) data = { port: b.readUInt16BE(at + 4), target: readName(b, at + 6).name }; // SRV
		else if (type === 1 && len === 4) data = [...b.subarray(at, at + 4)].join("."); // A
		else if (type === 16) {
			data = {};
			for (let p = at; p < at + len; ) {
				const l = b[p];
				const kv = b.toString("utf8", p + 1, p + 1 + l);
				const eq = kv.indexOf("=");
				if (eq > 0) data[kv.slice(0, eq).toLowerCase()] = kv.slice(eq + 1);
				p += 1 + l;
			}
		}
		out.push({ name: name.toLowerCase(), type, data });
		off = at + len;
	}
	return out;
}

/** eSCL scanners announcing themselves on the server's local network → [{ name, url }]. */
export async function findScanners(timeoutMs = 3000) {
	const services = ["_uscan._tcp.local", "_uscans._tcp.local"];
	const records = [];
	const sockets = [];
	const listen = (sock) => {
		sock.on("message", (msg) => {
			try {
				records.push(...parseDns(msg));
			} catch {
				// not a DNS packet we understand
			}
		});
		sock.on("error", () => {});
		sockets.push(sock);
	};
	// Unicast answers come back to this socket...
	const ask = dgram.createSocket({ type: "udp4", reuseAddr: true });
	listen(ask);
	await new Promise((r) => ask.bind(0, r));
	// ...and responders that answer by multicast reach this one, where the port is free to share.
	try {
		const group = dgram.createSocket({ type: "udp4", reuseAddr: true });
		listen(group);
		await new Promise((resolve, reject) => {
			group.once("error", reject);
			group.bind(5353, () => {
				try {
					group.addMembership("224.0.0.251");
				} catch {}
				resolve();
			});
		});
	} catch {
		// port 5353 taken without sharing (e.g. avahi): unicast answers still work
	}
	const query = dnsQuery(services);
	ask.send(query, 5353, "224.0.0.251");
	setTimeout(() => ask.send(query, 5353, "224.0.0.251"), 800);
	await sleep(timeoutMs);
	for (const s of sockets) s.close();

	const byType = (t) => records.filter((r) => r.type === t);
	const found = new Map();
	for (const ptr of byType(12)) {
		const service = services.find((s) => ptr.name === s);
		if (!service || typeof ptr.data !== "string") continue;
		const inst = ptr.data.toLowerCase();
		const srv = byType(33).find((r) => r.name === inst)?.data;
		if (!srv) continue;
		const ip = byType(1).find((r) => r.name === srv.target.toLowerCase())?.data;
		if (!ip || !isLocalAddress(ip)) continue;
		const txt = Object.assign({}, ...byType(16).filter((r) => r.name === inst).map((r) => r.data));
		const secure = service.startsWith("_uscans");
		const path = String(txt.rs ?? "eSCL").replace(/^\/+|\/+$/g, "") || "eSCL";
		const url = `${secure ? "https" : "http"}://${ip}:${srv.port}/${path}`;
		const name = txt.ty || ptr.data.split("._uscan")[0];
		// One entry per scanner: prefer plain http (some scanners' https needs pairing).
		const key = `${ip}|${name}`;
		if (!found.has(key) || !secure) found.set(key, { name, url });
	}
	return [...found.values()];
}
