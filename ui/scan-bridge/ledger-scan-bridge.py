#!/usr/bin/env python3
"""Ledger scan bridge (macOS and Linux): shares a USB scanner on this computer
with Ledger's Import module, as a network scanner (the eSCL / AirScan protocol).

    python3 ledger-scan-bridge.py                 # first scanner SANE finds, port 8090
    python3 ledger-scan-bridge.py --list          # the scanners SANE sees
    python3 ledger-scan-bridge.py --device "epson2:libusb:001:004" --port 8090
    python3 ledger-scan-bridge.py --allow 192.168.1.10   # only the Ledger server may scan

Then in Ledger: Import -> Scan -> Change scanner -> this computer's address, e.g.
http://192.168.1.25:8090/eSCL (the bridge prints it). Leave it running while you scan.

Needs SANE's scanimage, version 1.0.28 or newer (JPEG output):
  macOS:          brew install sane-backends
  Debian/Ubuntu:  sudo apt install sane-utils
  Fedora:         sudo dnf install sane-backends
Only Python's standard library is used. By default only computers on your local
network (private addresses) may use it; --allow narrows that to given addresses.
"""

import argparse
import ipaddress
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.0"
SCANIMAGE = os.environ.get("SCANIMAGE", "scanimage")
STANDARD_DPI = [75, 100, 150, 200, 300, 400, 600]


def run(args, timeout=60):
    return subprocess.run([SCANIMAGE, *args], capture_output=True, timeout=timeout)


def list_devices():
    r = run(["-f", "%d\t%v %m%n"], timeout=60)
    out = []
    for line in r.stdout.decode("utf-8", "replace").splitlines():
        if "\t" in line:
            dev, name = line.split("\t", 1)
            out.append((dev.strip(), name.strip()))
    return out


def option_values(text, name):
    """'--source Flatbed|ADF|ADF Duplex [Flatbed]' -> ['Flatbed', 'ADF', 'ADF Duplex']"""
    m = re.search(r"^\s*--?%s\s+(.+?)(?:\s+\[[^\]]*\])?\s*$" % re.escape(name), text, re.M)
    if not m:
        return []
    return [v.strip() for v in m.group(1).split("|") if v.strip()]


def resolutions(text):
    m = re.search(r"^\s*--resolution\s+(.+?)(?:\s+\[[^\]]*\])?\s*$", text, re.M)
    if not m:
        return [150, 300]
    spec = m.group(1).replace("dpi", "")
    r = re.match(r"\s*(\d+)\.\.(\d+)", spec)
    if r:
        lo, hi = int(r.group(1)), int(r.group(2))
        return [d for d in STANDARD_DPI if lo <= d <= hi] or [lo]
    vals = sorted({int(v) for v in re.findall(r"\d+", spec)})
    return [v for v in vals if v <= 1200] or [300]


class Scanner:
    def __init__(self, device, name):
        self.device, self.name = device, name
        help_text = run(["--help", "-d", device], timeout=60).stdout.decode("utf-8", "replace")
        if not re.search(r"--format[^\n]*jpeg", help_text):
            sys.exit("This scanimage can't write JPEG. Update SANE to 1.0.28 or newer.")
        opts = run(["-d", device, "-A"], timeout=60).stdout.decode("utf-8", "replace")
        sources = option_values(opts, "source")
        self.flatbed = next((s for s in sources if re.search(r"flatbed|platen|normal", s, re.I)), None)
        self.feeder = next((s for s in sources if re.search(r"adf|feeder|automatic", s, re.I) and not re.search(r"duplex", s, re.I)), None)
        self.duplex = next((s for s in sources if re.search(r"duplex", s, re.I)), None)
        if not sources:
            self.flatbed = ""  # no --source option: a flatbed
        modes = option_values(opts, "mode")
        self.color = next((m for m in modes if re.search(r"colou?r", m, re.I)), None)
        self.gray = next((m for m in modes if re.search(r"gr[ae]y", m, re.I)), None)
        self.dpi = resolutions(opts)
        self.lock = threading.Lock()
        self.jobs = {}

    def caps_xml(self):
        def caps(tag, inner_tag, height):
            modes = ("<scan:ColorMode>RGB24</scan:ColorMode>" if self.color or not self.gray else "") + ("<scan:ColorMode>Grayscale8</scan:ColorMode>" if self.gray else "")
            res = "".join("<scan:DiscreteResolution><scan:XResolution>%d</scan:XResolution><scan:YResolution>%d</scan:YResolution></scan:DiscreteResolution>" % (d, d) for d in self.dpi)
            return (
                "<scan:%s><scan:%s><scan:MinWidth>16</scan:MinWidth><scan:MaxWidth>2550</scan:MaxWidth><scan:MinHeight>16</scan:MinHeight><scan:MaxHeight>%d</scan:MaxHeight>"
                "<scan:SettingProfiles><scan:SettingProfile><scan:ColorModes>%s</scan:ColorModes>"
                "<scan:DocumentFormats><pwg:DocumentFormat>image/jpeg</pwg:DocumentFormat><scan:DocumentFormatExt>image/jpeg</scan:DocumentFormatExt></scan:DocumentFormats>"
                "<scan:SupportedResolutions><scan:DiscreteResolutions>%s</scan:DiscreteResolutions></scan:SupportedResolutions>"
                "</scan:SettingProfile></scan:SettingProfiles></scan:%s>%s</scan:%s>"
                % (tag, inner_tag, height, modes, res, inner_tag, "<scan:AdfDuplexInputCaps/>" if tag == "Adf" and self.duplex else "", tag)
            )

        parts = []
        if self.flatbed is not None:
            parts.append(caps("Platen", "PlatenInputCaps", 3508))
        if self.feeder or self.duplex:
            parts.append(caps("Adf", "AdfSimplexInputCaps", 4200))
        name = self.name.replace("&", "&amp;").replace("<", "&lt;")
        return (
            '<?xml version="1.0" encoding="UTF-8"?><scan:ScannerCapabilities xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">'
            "<pwg:Version>2.0</pwg:Version><pwg:MakeAndModel>%s</pwg:MakeAndModel>%s</scan:ScannerCapabilities>" % (name, "".join(parts))
        ).encode()

    def status_xml(self):
        state = "Processing" if self.lock.locked() else "Idle"
        return ('<?xml version="1.0" encoding="UTF-8"?><scan:ScannerStatus xmlns:scan="http://schemas.hp.com/imaging/escl/2011/05/03" xmlns:pwg="http://www.pwg.org/schemas/2010/12/sm">'
                "<pwg:Version>2.0</pwg:Version><pwg:State>%s</pwg:State></scan:ScannerStatus>" % state).encode()

    def scan(self, job):
        """Scans the job's pages (all of them for the feeder) into job['pages']."""
        s = job["settings"]
        args = ["-d", self.device, "--format=jpeg", "--resolution", str(s["dpi"])]
        mode = self.gray if s["gray"] and self.gray else self.color
        if mode:
            args += ["--mode", mode]
        source = (self.duplex if s["duplex"] and self.duplex else self.feeder or self.duplex) if s["feeder"] else self.flatbed
        if source:
            args += ["--source", source]
        if not s["feeder"]:
            r = run(args, timeout=300)
            if r.returncode != 0 or not r.stdout.startswith(b"\xff\xd8"):
                raise RuntimeError(r.stderr.decode("utf-8", "replace").strip() or "scanimage failed")
            job["pages"] = [r.stdout]
            return
        tmp = tempfile.mkdtemp(prefix="ledger-scan-")
        try:
            r = run(args + ["--batch=%s" % os.path.join(tmp, "p%04d.jpg")], timeout=900)
            files = sorted(f for f in os.listdir(tmp) if f.endswith(".jpg"))
            job["pages"] = [open(os.path.join(tmp, f), "rb").read() for f in files]
            if not job["pages"]:
                raise RuntimeError(r.stderr.decode("utf-8", "replace").strip() or "no pages came out of the feeder")
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


def tag(xml, name):
    m = re.search(r"<(?:\w+:)?%s>([^<]*)</" % name, xml)
    return m.group(1).strip() if m else ""


def make_handler(scanner, allowed):
    class Handler(BaseHTTPRequestHandler):
        server_version = "LedgerScanBridge/" + VERSION

        def log_message(self, fmt, *args):
            sys.stderr.write("%s %s\n" % (self.client_address[0], fmt % args))

        def allowed(self):
            ip = ipaddress.ip_address(self.client_address[0])
            if allowed:
                return str(ip) in allowed or ip.is_loopback
            return ip.is_private or ip.is_loopback or ip.is_link_local or ip in ipaddress.ip_network("100.64.0.0/10")

        def reply(self, code, body=b"", ctype="text/xml", headers=None):
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            for k, v in (headers or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if not self.allowed():
                return self.reply(403, b"not allowed", "text/plain")
            path = self.path.split("?")[0].rstrip("/")
            if path == "/eSCL/ScannerCapabilities":
                return self.reply(200, scanner.caps_xml())
            if path == "/eSCL/ScannerStatus":
                return self.reply(200, scanner.status_xml())
            m = re.match(r"^/eSCL/ScanJobs/([0-9a-f-]{36})/NextDocument$", path)
            if m:
                job = scanner.jobs.get(m.group(1))
                if not job:
                    return self.reply(404)
                if job["pages"] is None:
                    if not scanner.lock.acquire(blocking=False):
                        return self.reply(503)
                    try:
                        scanner.scan(job)
                    except Exception as e:  # noqa: BLE001 - reported to Ledger and the console
                        sys.stderr.write("scan failed: %s\n" % e)
                        job["pages"] = []
                        return self.reply(500, str(e).encode("utf-8", "replace")[:500], "text/plain")
                    finally:
                        scanner.lock.release()
                if job["next"] >= len(job["pages"]):
                    return self.reply(404)
                page = job["pages"][job["next"]]
                job["next"] += 1
                return self.reply(200, page, "image/jpeg")
            return self.reply(404)

        def do_POST(self):
            if not self.allowed():
                return self.reply(403, b"not allowed", "text/plain")
            if self.path.rstrip("/") != "/eSCL/ScanJobs":
                return self.reply(404)
            size = int(self.headers.get("Content-Length") or 0)
            xml = self.rfile.read(min(size, 1 << 16)).decode("utf-8", "replace")
            if scanner.lock.locked():
                return self.reply(503)
            feeder = tag(xml, "InputSource") == "Feeder"
            if feeder and not (scanner.feeder or scanner.duplex):
                return self.reply(409)
            dpi = int(tag(xml, "XResolution") or 300)
            dpi = min(scanner.dpi, key=lambda d: abs(d - dpi))
            job_id = str(uuid.uuid4())
            for old in list(scanner.jobs)[:-10]:
                scanner.jobs.pop(old, None)
            scanner.jobs[job_id] = {
                "settings": {"feeder": feeder, "duplex": tag(xml, "Duplex") == "true", "gray": tag(xml, "ColorMode").startswith("Gray"), "dpi": dpi},
                "pages": None,
                "next": 0,
            }
            host = self.headers.get("Host") or "%s:%d" % self.server.server_address[:2]
            return self.reply(201, headers={"Location": "http://%s/eSCL/ScanJobs/%s" % (host, job_id)})

        def do_DELETE(self):
            if not self.allowed():
                return self.reply(403, b"not allowed", "text/plain")
            m = re.match(r"^/eSCL/ScanJobs/([0-9a-f-]{36})$", self.path.rstrip("/"))
            if m:
                scanner.jobs.pop(m.group(1), None)
            return self.reply(200)

    return Handler


def my_address():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "this-computer"


def main():
    ap = argparse.ArgumentParser(description="Share a USB scanner with Ledger's Import module (eSCL).")
    ap.add_argument("--port", type=int, default=8090)
    ap.add_argument("--device", help="a SANE device name (see --list); default: the first one")
    ap.add_argument("--allow", default="", help="comma-separated addresses that may scan (default: any on your local network)")
    ap.add_argument("--list", action="store_true", help="list the scanners SANE sees and stop")
    a = ap.parse_args()
    if not shutil.which(SCANIMAGE):
        sys.exit("scanimage isn't installed. macOS: brew install sane-backends; Debian/Ubuntu: sudo apt install sane-utils")
    devices = list_devices()
    if a.list:
        for dev, name in devices:
            print("%s\t%s" % (dev, name))
        return
    if a.device:
        found = [d for d in devices if d[0] == a.device]
        dev, name = found[0] if found else (a.device, a.device)
    elif devices:
        dev, name = devices[0]
    else:
        sys.exit("SANE finds no scanner. Is it plugged in and switched on? Try: scanimage -L")
    scanner = Scanner(dev, name)
    allowed = {x.strip() for x in a.allow.split(",") if x.strip()}
    httpd = ThreadingHTTPServer(("0.0.0.0", a.port), make_handler(scanner, allowed))
    print("Sharing %s (%s)" % (name, dev))
    print("  glass: %s, feeder: %s, both sides: %s, %s dpi" % ("yes" if scanner.flatbed is not None else "no", "yes" if scanner.feeder or scanner.duplex else "no", "yes" if scanner.duplex else "no", "/".join(map(str, scanner.dpi))))
    print("In Ledger: Import -> Scan -> Change scanner -> http://%s:%d/eSCL" % (my_address(), a.port))
    print("Only %s may scan. Ctrl-C stops." % (", ".join(sorted(allowed)) if allowed else "computers on your local network"))
    sys.stdout.flush()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
