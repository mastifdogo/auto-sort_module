// Turning untrusted HTML (email bodies, saved web pages) into text, and deciding what an
// attachment may be shown as. Mail comes from anyone, so everything here runs in one pass over
// the text: a pattern like /<!--[\s\S]*?-->/ takes quadratic time on mail built to have openers
// with no end, which would stop the whole Ledger server while it runs.

/** How much HTML is looked at; the rest of a huge message adds nothing a person reads. */
export const MAX_HTML = 2 * 1024 * 1024;

/**
 * Removes everything from each `open` match to the end of its closing marker. An opener that is
 * never closed takes the rest of the text with it, as a browser would. `open` must be global.
 */
export function cutSpans(s, open, closeOf) {
	// ASCII letters only: toLowerCase() can change a string's length, and the positions must stay true.
	const lower = s.replace(/[A-Z]+/g, (x) => x.toLowerCase());
	let out = "";
	let pos = 0;
	open.lastIndex = 0;
	for (let m = open.exec(s); m; m = open.exec(s)) {
		out += s.slice(pos, m.index);
		const close = closeOf(m);
		const end = lower.indexOf(close, m.index + m[0].length);
		if (end < 0) return out;
		const after = close.endsWith(">") ? end + close.length - 1 : lower.indexOf(">", end);
		if (after < 0) return out;
		pos = after + 1;
		open.lastIndex = pos;
	}
	return out + s.slice(pos);
}

/** Replaces each tag ("<...>") with what fn(tag) returns. A "<" that is never closed stays as text. */
export function mapTags(s, fn) {
	let out = "";
	let pos = 0;
	for (;;) {
		const lt = s.indexOf("<", pos);
		if (lt < 0) break;
		const gt = s.indexOf(">", lt + 1);
		if (gt < 0) break;
		out += s.slice(pos, lt) + fn(s.slice(lt, gt + 1));
		pos = gt + 1;
	}
	return out + s.slice(pos);
}

/** The HTML without comments and without scripts, styles and titles (their contents are not text to read). */
export function withoutCode(html) {
	let s = String(html ?? "").slice(0, MAX_HTML);
	s = cutSpans(s, /<!--/g, () => "-->");
	// Not <head>: its end tag is optional, and without one the whole message would go with it.
	return cutSpans(s, /<(script|style|title)\b/gi, (m) => `</${m[1].toLowerCase()}`);
}

/**
 * What a file from an email may be opened as in a browser tab, from its bytes: never from the type
 * the sender declared, which could say "text/html" and run script in Ledger's own origin. PDFs and
 * pictures by their first bytes; plain text only when declared as text and free of NULs; anything
 * else is "application/octet-stream" (a download).
 */
export function safeType(data, declared = "") {
	const head = data.subarray(0, 16).toString("latin1");
	if (head.startsWith("%PDF-")) return "application/pdf";
	if (head.startsWith("\x89PNG\r\n\x1a\n")) return "image/png";
	if (head.startsWith("\xff\xd8\xff")) return "image/jpeg";
	if (head.startsWith("GIF87a") || head.startsWith("GIF89a")) return "image/gif";
	if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP") return "image/webp";
	const d = String(declared ?? "").split(";")[0].trim().toLowerCase();
	if ((d === "text/plain" || d === "text/csv") && !data.subarray(0, 4096).includes(0)) return "text/plain";
	return "application/octet-stream";
}

/** The types safeType() can answer that a browser tab shows without running anything. */
export const OPENABLE = ["application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp", "text/plain"];
