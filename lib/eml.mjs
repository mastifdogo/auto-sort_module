// Reading an .eml file (RFC 822 / MIME) kept in the inbox, to show it as an
// email before it's sent on: headers (with =?charset?B/Q?…?= words), the text
// (text/plain, else text/html), and the attachments. No packages: Buffer and
// TextDecoder only. Lenient: a broken part is left out, never an error.

const MAX_DEPTH = 8;
const MAX_PARTS = 200;

function decodeCharset(buf, charset) {
	const cs = String(charset || "utf-8").trim().toLowerCase().replace(/^"|"$/g, "");
	try {
		return new TextDecoder(cs === "us-ascii" || cs === "ascii" ? "utf-8" : cs, { fatal: false }).decode(buf);
	} catch {
		return new TextDecoder("utf-8").decode(buf);
	}
}

function qpBytes(s, header = false) {
	if (header) s = s.replace(/_/g, " ");
	s = s.replace(/=\r?\n/g, "");
	const out = [];
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
			out.push(parseInt(s.slice(i + 1, i + 3), 16));
			i += 2;
		} else {
			const code = s.charCodeAt(i);
			if (code < 256) out.push(code);
			else out.push(...Buffer.from(c, "utf8"));
		}
	}
	return Buffer.from(out);
}

/** A header value with its encoded words decoded. */
export function decodeWords(value) {
	return String(value ?? "")
		.replace(/(=\?[^?]+\?[bBqQ]\?[^?]*\?=)\s+(?==\?)/g, "$1") // spaces between encoded words don't count
		.replace(/=\?([^?*]+)(?:\*[^?]*)?\?([bBqQ])\?([^?]*)\?=/g, (all, cs, enc, text) => {
			try {
				const buf = enc.toUpperCase() === "B" ? Buffer.from(text, "base64") : qpBytes(text, true);
				return decodeCharset(buf, cs);
			} catch {
				return all;
			}
		});
}

/** Splits head and body; headers as a Map of lowercase name → raw (unfolded) value, first one wins. */
function splitPart(buf) {
	let end = -1;
	let skip = 0;
	for (let i = 0; i < buf.length - 1; i++) {
		if (buf[i] === 10 && buf[i + 1] === 10) { end = i; skip = 2; break; }
		if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) { end = i; skip = 4; break; }
	}
	const head = end < 0 ? buf.toString("latin1") : buf.subarray(0, end).toString("latin1");
	const body = end < 0 ? Buffer.alloc(0) : buf.subarray(end + skip);
	const headers = new Map();
	for (const line of head.replace(/\r?\n[ \t]+/g, " ").split(/\r?\n/)) {
		const m = /^([^:\s]+)\s*:\s*(.*)$/.exec(line);
		if (m && !headers.has(m[1].toLowerCase())) headers.set(m[1].toLowerCase(), m[2]);
	}
	return { headers, body };
}

/** "text/plain; charset=utf-8; name=x" → { value, params } (RFC 2231 name*= understood). */
function parseParams(v) {
	const [value, ...rest] = String(v ?? "").split(";");
	const params = {};
	const ext = {};
	for (const p of rest) {
		const m = /^\s*([^=\s]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;]*))/.exec(p);
		if (!m) continue;
		const key = m[1].toLowerCase();
		const val = m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3].trim();
		const star = /^([^*]+)\*(\d+)?(\*)?$/.exec(key);
		if (star) (ext[star[1]] ??= []).push({ n: Number(star[2] ?? 0), val, enc: Boolean(star[3]) || (!star[2] && key.endsWith("*")) });
		else params[key] = val;
	}
	for (const [k, parts] of Object.entries(ext)) {
		parts.sort((a, b) => a.n - b.n);
		let charset = "utf-8";
		const bytes = [];
		parts.forEach((p, i) => {
			let s = p.val;
			if (p.enc && i === 0) {
				const m = /^([^']*)'[^']*'(.*)$/.exec(s);
				if (m) { charset = m[1] || charset; s = m[2]; }
			}
			if (p.enc) bytes.push(Buffer.from(s.replace(/%([0-9A-Fa-f]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1"));
			else bytes.push(Buffer.from(s, "latin1"));
		});
		params[k] = decodeCharset(Buffer.concat(bytes), charset);
	}
	return { value: value.trim().toLowerCase(), params };
}

function decodeBody(body, encoding) {
	const enc = String(encoding ?? "").trim().toLowerCase();
	if (enc === "base64") return Buffer.from(body.toString("latin1").replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
	if (enc === "quoted-printable") return qpBytes(body.toString("latin1"));
	return body;
}

function splitMultipart(body, boundary) {
	const text = body.toString("latin1");
	const delim = `--${boundary}`;
	const parts = [];
	let pos = text.indexOf(delim);
	while (pos >= 0 && parts.length < MAX_PARTS) {
		let start = pos + delim.length;
		if (text.startsWith("--", start)) break; // closing delimiter
		start = text.indexOf("\n", start);
		if (start < 0) break;
		start++;
		const next = text.indexOf(`\n${delim}`, start);
		const stop = next < 0 ? text.length : next;
		const chunk = text.slice(start, stop).replace(/\r$/, "");
		parts.push(Buffer.from(chunk, "latin1"));
		if (next < 0) break;
		pos = next + 1;
	}
	return parts;
}

/**
 * Parses an .eml → { subject, from, to, cc, date, text, html, attachments: [{ filename, content_type, data }] }.
 * The first text/plain (else text/html) that isn't an attachment is the text.
 */
export function parseEml(buf) {
	const top = splitPart(Buffer.isBuffer(buf) ? buf : Buffer.from(buf));
	const h = (k) => decodeWords(top.headers.get(k) ?? "").trim();
	const out = { subject: h("subject"), from: h("from"), to: h("to"), cc: h("cc"), date: "", text: "", html: "", attachments: [] };
	const d = Date.parse(top.headers.get("date") ?? "");
	if (d) out.date = new Date(d).toISOString();

	const walk = ({ headers, body }, depth) => {
		if (depth > MAX_DEPTH || out.attachments.length >= MAX_PARTS) return;
		const type = parseParams(headers.get("content-type") || "text/plain");
		const disp = parseParams(headers.get("content-disposition") || "");
		if (type.value.startsWith("multipart/") && type.params.boundary) {
			for (const p of splitMultipart(body, type.params.boundary)) walk(splitPart(p), depth + 1);
			return;
		}
		const data = decodeBody(body, headers.get("content-transfer-encoding"));
		const filename = decodeWords(disp.params.filename || type.params.name || "").replace(/[\u0000-\u001f/\\]/g, "-").trim();
		const inline = disp.value !== "attachment" && !filename;
		if (inline && type.value === "text/plain" && !out.text) return void (out.text = decodeCharset(data, type.params.charset));
		if (inline && type.value === "text/html" && !out.html) return void (out.html = decodeCharset(data, type.params.charset));
		if (inline && (type.value.startsWith("text/") || type.value.startsWith("multipart/"))) return; // another alternative
		const ext = type.value === "message/rfc822" ? "eml" : (type.value.split("/")[1] || "bin").replace(/[^a-z0-9]/g, "").slice(0, 8) || "bin";
		out.attachments.push({ filename: filename || `attachment.${ext}`, content_type: type.value || "application/octet-stream", data });
	};
	walk(top, 0);
	return out;
}
