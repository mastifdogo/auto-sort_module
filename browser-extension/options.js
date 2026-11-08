// Send to Ledger: options. Saves Ledger's address and asks for permission to reach that origin only.
const $ = (id) => document.getElementById(id);
const say = (text, cls = "") => {
	$("msg").className = `small ${cls}`;
	$("msg").textContent = text;
};

function normalize(input) {
	let s = input.trim();
	if (!/^https?:\/\//i.test(s)) s = "http://" + s;
	const u = new URL(s);
	return u.origin + u.pathname.replace(/\/+$/, "");
}

$("form").onsubmit = async (e) => {
	e.preventDefault();
	let url;
	try {
		url = normalize($("url").value);
	} catch {
		return say("That isn't a web address.", "err");
	}
	// Must be called straight from the click, before any other await.
	const granted = await chrome.permissions.request({ origins: [`${new URL(url).origin}/*`] });
	if (!granted) return say("Without permission the extension can't reach Ledger.", "err");
	await chrome.storage.local.set({ ledgerUrl: url });
	$("url").value = url;
	say("Saved.", "ok");
};

$("test").onclick = async () => {
	say("Connecting…", "muted");
	const r = await chrome.runtime.sendMessage({ type: "whoami" });
	if (r?.ok) say(`Works: logged in to Ledger as ${r.data.username}${r.data.role ? ` (${r.data.role})` : ""}.`, "ok");
	else say(r?.error || "No answer.", "err");
};

chrome.storage.local.get("ledgerUrl").then(({ ledgerUrl }) => {
	if (ledgerUrl) $("url").value = ledgerUrl;
});
