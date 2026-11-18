// What the email check learns from you. Each file imported from email keeps
// the features of where it came from (sender, its domain, subject words,
// attachment name words and type). Deleting one with "Delete and learn" stores
// those features as an unwanted example; sending a file on (to Auto sort,
// Extract data, another module, Ledger's CSV files) or importing a skipped
// email stores a wanted one. Later checks score each attachment with a small
// naive Bayes model over those examples and skip what looks unwanted, with the
// reason, so it can be imported anyway. No AI: this is word statistics, and
// a person's own choices are the only input.
//
// The examples are exportable as a "training file" (JSON) and can be loaded
// back, e.g. into another organization.

export const TRAINING_FORMAT = "ledger-import-email-training";
const STOP = new Set(
	"the and for you your our from with this that are was has have will not but all any can out new now get one more about here there their them they its it's www com http https html pdf jpg png csv eml re fw fwd".split(" "),
);
/** How sure the model must be before it skips. */
export const SKIP_AT = 0.85;
const ALPHA = 0.5; // smoothing: one deletion already counts, many examples count more

/** "Hydro One <Bills@Hydro.example.com>" -> "bills@hydro.example.com" */
export function senderAddress(from) {
	const m = /<([^>]+)>/.exec(String(from)) ?? /([^\s<>]+@[^\s<>]+)/.exec(String(from));
	return (m ? m[1] : "").trim().toLowerCase();
}

/** The registrable part of a domain, roughly: "mail.hydro.example.co.uk" -> "example.co.uk", "e.shop.com" -> "shop.com". */
export function baseDomain(domain) {
	const parts = String(domain).toLowerCase().split(".").filter(Boolean);
	if (parts.length <= 2) return parts.join(".");
	const twoLevel = /^(co|com|net|org|gov|ac|edu)$/.test(parts.at(-2)) && parts.at(-1).length === 2;
	return parts.slice(twoLevel ? -3 : -2).join(".");
}

const words = (s) =>
	[...new Set(String(s ?? "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").match(/\p{L}{3,}/gu) ?? [])].filter((w) => !STOP.has(w));

/**
 * Features of one imported file: where the email came from and what the file is.
 * attachment: { name } for an attachment, or null for an email saved as .eml.
 */
export function features({ from, subject }, attachment) {
	const f = new Set();
	const addr = senderAddress(from);
	if (addr) {
		f.add(`from:${addr}`);
		const domain = addr.split("@")[1];
		if (domain) f.add(`domain:${baseDomain(domain)}`);
	}
	for (const w of words(subject).slice(0, 15)) f.add(`s:${w}`);
	if (attachment) {
		const name = String(attachment.name ?? "");
		const ext = /\.([a-z0-9]{1,5})$/i.exec(name)?.[1]?.toLowerCase();
		f.add(`ext:${ext ?? "none"}`);
		for (const w of words(name.replace(/\.[a-z0-9]{1,5}$/i, "")).slice(0, 10)) f.add(`a:${w}`);
	} else f.add("kind:email");
	return [...f];
}

const senderOf = (feats) => feats.filter((x) => x.startsWith("from:") || x.startsWith("domain:"));

/** A model over examples [{ label: 1 | -1, features: string[] }]: counts per class. */
export function model(examples) {
	const m = { neg: 0, pos: 0, n: new Map(), p: new Map() };
	for (const e of examples) {
		const bag = e.label < 0 ? m.n : m.p;
		if (e.label < 0) m.neg++;
		else m.pos++;
		for (const f of new Set(e.features)) bag.set(f, (bag.get(f) ?? 0) + 1);
	}
	return m;
}

const LABEL = { from: "sender", domain: "sender's domain", s: "subject word", a: "file name word", ext: "file type", kind: "" };
const describe = (f) => {
	const [k, ...v] = f.split(":");
	return k === "kind" ? "an email without attachments" : `${LABEL[k] ?? k} "${v.join(":")}"`;
};

/**
 * Scores a file's features. → { p (chance it's unwanted, 0..1), skip, reason, deleted, kept }.
 * Bernoulli naive Bayes over the features present, equal priors, additive smoothing; features
 * never seen don't count. It only skips with p ≥ SKIP_AT, a deleted example from the same sender
 * or domain (a new sender is never skipped on subject words alone), and the same kind of file:
 * a file name word or "an email without attachments" seen in what was deleted, so deleting one
 * sender's terms.pdf doesn't skip its invoices. A sender whose files were deleted 3 times and never
 * kept is skipped whatever the file.
 */
export function judge(m, feats) {
	if (m.neg === 0) return { p: 0, skip: false, reason: "", deleted: 0, kept: 0 };
	let llr = 0;
	const parts = [];
	for (const f of feats) {
		const cn = m.n.get(f) ?? 0;
		const cp = m.p.get(f) ?? 0;
		if (cn === 0 && cp === 0) continue;
		const w = Math.log((cn + ALPHA) / (m.neg + 2 * ALPHA)) - Math.log((cp + ALPHA) / (m.pos + 2 * ALPHA));
		llr += w;
		parts.push({ f, w, cn, cp });
	}
	const p = 1 / (1 + Math.exp(-llr));
	const sender = senderOf(feats);
	const deleted = Math.max(0, ...sender.map((f) => m.n.get(f) ?? 0));
	const kept = Math.max(0, ...sender.map((f) => m.p.get(f) ?? 0));
	const sameFile = feats.some((f) => (f.startsWith("a:") || f.startsWith("kind:")) && (m.n.get(f) ?? 0) > 0);
	const skip = p >= SKIP_AT && deleted >= 1 && (sameFile || (deleted >= 3 && kept === 0));
	const top = parts
		.filter((x) => x.w > 0)
		.sort((a, b) => b.w - a.w)
		.slice(0, 3)
		.map((x) => describe(x.f));
	const reason = skip
		? `looks like ${deleted} file${deleted === 1 ? "" : "s"} you deleted from this sender (${top.join(", ")}); ${Math.round(p * 100)}% sure`.slice(0, 500)
		: "";
	return { p, skip, reason, deleted, kept };
}

/**
 * A judge over all examples that scores each file against the examples from its own sender or
 * domain only, so what you taught about one sender doesn't tilt another's. A sender with no
 * examples is never skipped. → { judge(feats) }
 */
export function learner(examples) {
	const bySender = new Map();
	for (const e of examples) for (const f of senderOf(e.features)) (bySender.get(f) ?? bySender.set(f, []).get(f)).push(e);
	return {
		judge(feats) {
			const local = new Set();
			for (const f of senderOf(feats)) for (const e of bySender.get(f) ?? []) local.add(e);
			return judge(model([...local]), feats);
		},
	};
}

/** A training file's examples, checked: [{ label, features, sender, subject, file_name, source, created_at }]. */
export function readTrainingFile(json) {
	if (!json || typeof json !== "object" || json.format !== TRAINING_FORMAT || !Array.isArray(json.examples)) {
		throw new Error(`this isn't an Import training file (expected "format": "${TRAINING_FORMAT}")`);
	}
	if (json.examples.length > 20_000) throw new Error("a training file holds at most 20,000 examples");
	const str = (x, n) => (typeof x === "string" ? x.slice(0, n) : "");
	return json.examples.map((e, i) => {
		if (!e || (e.label !== 1 && e.label !== -1)) throw new Error(`example ${i + 1}: label must be 1 (wanted) or -1 (deleted)`);
		if (!Array.isArray(e.features) || e.features.length === 0 || e.features.length > 60 || !e.features.every((f) => typeof f === "string" && /^[a-z]+:.{1,300}$/s.test(f))) {
			throw new Error(`example ${i + 1}: features must be a list such as ["from:bills@shop.com", "s:invoice"]`);
		}
		return {
			label: e.label,
			features: [...new Set(e.features)],
			sender: str(e.sender, 300),
			subject: str(e.subject, 300),
			file_name: str(e.file_name, 255),
			source: ["delete", "sent", "import", "file"].includes(e.source) ? e.source : "file",
		};
	});
}
