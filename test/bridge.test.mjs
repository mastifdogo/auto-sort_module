// The Python scan bridge (ui/scan-bridge/ledger-scan-bridge.py) with a stand-in for SANE's
// scanimage, driven by Import's own eSCL client. Skipped where python3 isn't installed.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { capabilities, scan, status } from "../lib/escl.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const bridge = path.join(here, "..", "ui", "scan-bridge", "ledger-scan-bridge.py");
const hasPython = spawnSync("python3", ["--version"]).status === 0;
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==", "base64");

function fakeScanimage(dir) {
	const jpeg = path.join(dir, "page.jpg");
	writeFileSync(jpeg, JPEG);
	const log = path.join(dir, "calls.log");
	const script = path.join(dir, "scanimage");
	writeFileSync(
		script,
		`#!/usr/bin/env python3
import sys, os
args = sys.argv[1:]
open(${JSON.stringify(log)}, "a").write(" ".join(args) + "\\n")
if "-f" in args:
    print("fake:usb:001\\tAcme ScanJet 200"); sys.exit(0)
if "--help" in args:
    print("    --format=pnm|tiff|png|jpeg   file format of output"); sys.exit(0)
if "-A" in args:
    print("  Scan mode:\\n    --mode Lineart|Gray|Color [Color]\\n    --resolution 75|150|300|600dpi [75]\\n    --source Flatbed|ADF|ADF Duplex [Flatbed]"); sys.exit(0)
page = open(${JSON.stringify(jpeg)}, "rb").read()
batch = [a for a in args if a.startswith("--batch=")]
if batch:
    pattern = batch[0].split("=", 1)[1]
    for i in range(1, 4):
        open(pattern.replace("%04d", "%04d" % i), "wb").write(page)
    sys.stderr.write("scanimage: sane_start: Document feeder out of documents\\n"); sys.exit(7)
sys.stdout.buffer.write(page)
`,
	);
	chmodSync(script, 0o755);
	return { script, log };
}

test("scan bridge (Python, SANE): capabilities, a glass scan and a feeder scan", { skip: !hasPython && "python3 isn't installed" }, async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "bridge-"));
	const fake = fakeScanimage(dir);
	const port = 20000 + Math.floor(Math.random() * 20000);
	const child = spawn("python3", [bridge, "--port", String(port)], { env: { ...process.env, SCANIMAGE: fake.script } });
	let out = "";
	child.stdout.on("data", (d) => (out += d));
	child.stderr.on("data", (d) => (out += d));
	try {
		for (let i = 0; i < 100 && !out.includes("In Ledger:"); i++) await new Promise((r) => setTimeout(r, 50));
		assert.match(out, /Sharing Acme ScanJet 200 \(fake:usb:001\)/);
		assert.match(out, /glass: yes, feeder: yes, both sides: yes, 75\/150\/300\/600 dpi/);
		const root = `http://127.0.0.1:${port}/eSCL`;
		const caps = await capabilities(root);
		assert.equal(caps.name, "Acme ScanJet 200");
		assert.deepEqual(caps.sources.map((s) => [s.id, s.duplex]), [["Platen", false], ["Feeder", true]]);
		assert.deepEqual(caps.sources[0].colorModes, ["RGB24", "Grayscale8"]);
		assert.equal((await status(root)).state, "Idle");

		const glass = await scan(root, caps, { source: "Platen", color: "gray", resolution: 300 });
		assert.equal(glass.pages.length, 1);
		assert.ok(glass.pages[0].data.equals(JPEG));
		const feeder = await scan(root, caps, { source: "Feeder", duplex: true, resolution: 200 });
		assert.equal(feeder.pages.length, 3);
		const calls = readFileSync(fake.log, "utf8");
		assert.match(calls, /-d fake:usb:001 --format=jpeg --resolution 300 --mode Gray --source Flatbed/);
		assert.match(calls, /--resolution 150 --mode Color --source ADF Duplex --batch=/); // 200 dpi isn't offered: the nearest
	} finally {
		child.kill();
	}
});
