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
	loadOrgs();
};

// The organization files go to (with more than one).
async function loadOrgs() {
	const r = await chrome.runtime.sendMessage({ type: "orgs" });
	if (!r?.ok) return;
	const { current, list, saved } = r.data;
	if (list.length < 2) return $("org-form").classList.add("hidden");
	$("org").replaceChildren(
		new Option(`Where Ledger is now${current ? ` (now ${current.name})` : ""}`, "0"),
		...list.map((o) => Object.assign(new Option(o.role === "viewer" ? `${o.name} (view only)` : o.name, String(o.id)), { disabled: o.role === "viewer" })),
	);
	$("org").value = list.some((o) => o.id === saved && o.role !== "viewer") ? String(saved) : "0";
	$("org-form").classList.remove("hidden");
}
$("org").onchange = async () => {
	const id = Number($("org").value) || 0;
	await chrome.storage.local.set({ orgId: id, orgName: id ? $("org").selectedOptions[0].textContent : "" });
	$("org-msg").className = "small ok";
	$("org-msg").textContent = id ? `Files go to ${$("org").selectedOptions[0].textContent}.` : "Files go where Ledger is at the time.";
};

$("test").onclick = async () => {
	say("Connecting…", "muted");
	const r = await chrome.runtime.sendMessage({ type: "whoami" });
	if (r?.ok) say(`Works: logged in to Ledger as ${r.data.username}${r.data.role ? ` (${r.data.role})` : ""}.`, "ok");
	else say(r?.error || "No answer.", "err");
};

chrome.storage.local.get("ledgerUrl").then(async ({ ledgerUrl }) => {
	// A copy downloaded from the module's page in Ledger comes with that Ledger's address: press Save to allow it.
	if (!ledgerUrl) ledgerUrl = await fetch(chrome.runtime.getURL("defaults.json")).then((r) => r.json()).then((d) => d.ledgerUrl || "", () => "");
	if (ledgerUrl) $("url").value = ledgerUrl;
	if (ledgerUrl) loadOrgs();
});
