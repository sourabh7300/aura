#!/usr/bin/env python3
"""AURA local bridge — Ghost Mode's hands on Windows.

The AURA page runs in a browser and cannot touch the disk on its own. This script
is the *optional* local half: it listens on 127.0.0.1:8765 and performs a small,
fixed set of file and diagnostic actions that the page asks for — and nothing else.
No third-party SDK is involved on either side: the page calls this bridge directly.

Security model (read this before changing anything):

  * binds 127.0.0.1 only, so the LAN cannot reach it;
  * every call needs the token printed at start (X-Aura-Token), compared in
    constant time; the token is never logged by the page;
  * CORS answers only AURA's own origins (the GitHub Pages app and localhost
    dev servers), never "*" for credentialed calls;
  * file work is confined to --allow roots (default: Downloads and ~/AURA) and
    symlinks may not escape them;
  * dry-run is the default: nothing moves unless the server was started with
    --live AND the request carries "confirm": true;
  * diagnostics run a fixed, read-only PowerShell script — there is no generic
    "run this command" op, so a compromised page cannot shell out;
  * every request body is capped and every action has an item/duration limit.

Run it:
    py aura_bridge.py                 # token printed, dry-run, safe
    py aura_bridge.py --live          # allow real moves, still needs "confirm"
    py aura_bridge.py --allow "D:\\Work" --port 8765
"""

from __future__ import annotations

import argparse
import hmac
import json
import os
import platform
import re
import secrets
import shutil
import subprocess
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse

VERSION = "1.0.0"
MAX_BODY = 64 * 1024
MAX_ITEMS = 500
POWERSHELL_TIMEOUT = 12
ORIGIN_EXACT = {
    "https://sourabh7300.github.io",
    "https://sourabh7300.github.io".replace("https://", "http://"),
}
LOCALHOST_RE = re.compile(r"^http://(localhost|127\.0\.0\.1)(:\d+)?$", re.I)
HOME = Path.home()
DEFAULT_ROOTS = [HOME / "Downloads", HOME / "AURA"]

IMAGE_EXT = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".svg"}
DOC_EXT = {".doc", ".docx", ".pdf", ".txt", ".md", ".rtf", ".odt", ".xls", ".xlsx", ".ppt", ".pptx"}

STATE: dict[str, Any] = {"live": False, "roots": [], "token": "", "debug": False}


# --------------------------------------------------------------------------- #
# path safety
# --------------------------------------------------------------------------- #
def allowed_roots() -> list[Path]:
    return STATE["roots"]


def inside_allowed(path: Path) -> bool:
    """True only when `path` really lives under an allowed root (symlinks resolved)."""
    try:
        real = path.resolve()
    except OSError:
        return False
    for root in allowed_roots():
        try:
            real.relative_to(root.resolve())
            return True
        except (ValueError, OSError):
            continue
    return False


def safe_dir(raw: str) -> Path:
    if not raw:
        raise ValueError("directory is required")
    p = Path(os.path.expandvars(os.path.expanduser(str(raw))))
    if not p.is_absolute():
        raise ValueError("directory must be an absolute path")
    if not p.is_dir():
        raise ValueError(f"not a directory: {p}")
    if not inside_allowed(p):
        raise ValueError("that folder is outside the folders this bridge may touch")
    return p.resolve()


def safe_child(parent: Path, name: str) -> Path:
    """A child folder name we create ourselves — never a path from the request."""
    clean = re.sub(r"[^A-Za-z0-9._ -]", "", str(name)).strip(" .")
    if not clean:
        raise ValueError("bad folder name")
    target = (parent / clean[:60]).resolve()
    if not inside_allowed(target):
        raise ValueError("target escapes the allowed roots")
    return target


# --------------------------------------------------------------------------- #
# actions
# --------------------------------------------------------------------------- #
def rule_bucket(path: Path, rule: str) -> str | None:
    ext = path.suffix.lower()
    if rule == "pdf":
        return "PDF" if ext == ".pdf" else None
    if rule == "images":
        return "Images" if ext in IMAGE_EXT else None
    if rule == "documents":
        return "Documents" if ext in DOC_EXT else None
    if rule == "by-type":
        return (ext.lstrip(".") or "no-extension").upper()
    if rule == "by-date":
        try:
            return time.strftime("%Y-%m", time.localtime(path.stat().st_mtime))
        except OSError:
            return None
    raise ValueError("rule must be one of: pdf, images, documents, by-type, by-date")


def act_organize_files(args: dict) -> dict:
    directory = safe_dir(args.get("directory") or "")
    rule = str(args.get("rule") or "pdf").lower().strip()
    confirm = args.get("confirm") is True
    plan: list[dict] = []
    errors: list[str] = []

    for item in sorted(directory.iterdir()):
        if len(plan) >= MAX_ITEMS:
            break
        if not item.is_file() or item.name.startswith("."):
            continue
        bucket = rule_bucket(item, rule)
        if not bucket:
            continue
        target = safe_child(directory, bucket)
        plan.append({"from": item.name, "to": f"{bucket}/{item.name}", "folder": str(target)})

    moved = 0
    if STATE["live"] and confirm:
        for row in plan:
            try:
                target = Path(row["folder"])
                target.mkdir(exist_ok=True)
                dest = target / row["from"]
                if not inside_allowed(dest) or dest.exists():
                    errors.append(f"{row['from']}: target exists or is outside the allowed roots")
                    continue
                shutil.move(str(directory / row["from"]), str(dest))
                moved += 1
            except OSError as exc:
                errors.append(f"{row['from']}: {exc}")

    return {
        "ok": True,
        "action": "organize_files",
        "directory": str(directory),
        "rule": rule,
        "dry_run": not (STATE["live"] and confirm),
        "planned": len(plan),
        "moved": moved,
        "sample": [row["to"] for row in plan[:12]],
        "errors": errors[:10],
    }


def act_create_note(args: dict) -> dict:
    title = str(args.get("title") or "").strip()
    content = str(args.get("content") or "")
    if not title:
        raise ValueError("title is required")
    if len(content) > 20000:
        raise ValueError("content is too long for a bridge note")
    notes = safe_child(allowed_roots()[0] if allowed_roots() else HOME / "AURA", "notes")
    slug = re.sub(r"[^A-Za-z0-9._ -]", "", title).strip().replace(" ", "-")[:60] or "note"
    path = notes / (slug + ".md")
    if not STATE["live"]:
        return {"ok": True, "action": "create_workspace_note", "dry_run": True, "path": str(path)}
    notes.mkdir(parents=True, exist_ok=True)
    if not inside_allowed(path):
        raise ValueError("note path escapes the allowed roots")
    path.write_text(f"# {title}\n\n{content}\n", encoding="utf-8")
    return {"ok": True, "action": "create_workspace_note", "dry_run": False, "path": str(path)}


PS_SCRIPT = r"""
$ErrorActionPreference = 'SilentlyContinue'
$out = @{}
try {
  $out.drives = @(Get-PSDrive -PSProvider FileSystem | Where-Object { $_.Used -ne $null } |
    Select-Object Name,
      @{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}},
      @{n='UsedGB';e={[math]::Round($_.Used/1GB,1)}})
} catch {}
try {
  $os = Get-CimInstance Win32_OperatingSystem
  $out.memory = @{
    FreeGB  = [math]::Round($os.FreePhysicalMemory/1MB,1)
    TotalGB = [math]::Round($os.TotalVisibleMemorySize/1MB,1)
  }
  $out.uptimeMinutes = [int]((Get-Date) - $os.LastBootUpTime).TotalMinutes
} catch {}
try {
  $out.top = @(Get-Process | Sort-Object -Property CPU -Descending | Select-Object -First 5 Name, CPU, @{n='RAMMB';e={[math]::Round($_.WS/1MB,0)}})
} catch {}
$out | ConvertTo-Json -Depth 5 -Compress
"""


def act_health_check(_args: dict) -> dict:
    info: dict[str, Any] = {
        "ok": True,
        "action": "system_health_check",
        "platform": platform.platform(),
        "python": platform.python_version(),
        "host": platform.node(),
    }
    if os.name != "nt" or not shutil.which("powershell"):
        info["note"] = "PowerShell not available — platform details only"
        return info
    try:
        proc = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", PS_SCRIPT],
            capture_output=True, text=True, timeout=POWERSHELL_TIMEOUT, check=False,
        )
        raw = (proc.stdout or "").strip()
        info["powershell"] = json.loads(raw) if raw.startswith("{") else {"raw": raw[:400]}
    except (subprocess.TimeoutExpired, OSError, json.JSONDecodeError) as exc:
        info["powershell"] = {"error": str(exc)[:200]}
    return info


ACTIONS = {
    "organize_files": act_organize_files,
    "create_workspace_note": act_create_note,
    "system_health_check": act_health_check,
}


# --------------------------------------------------------------------------- #
# HTTP
# --------------------------------------------------------------------------- #
def cors_origin(origin: str | None) -> str | None:
    if not origin:
        return None
    if origin in ORIGIN_EXACT or LOCALHOST_RE.match(origin):
        return origin
    if origin == "null":          # a page opened straight from disk (file://)
        return "null"
    return None


class BridgeHandler(BaseHTTPRequestHandler):
    server_version = "AuraBridge/" + VERSION
    sys_version = ""

    def log_message(self, fmt: str, *args: Any) -> None:  # keep the console quiet
        return

    # -- helpers --------------------------------------------------------- #
    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        origin = cors_origin(self.headers.get("Origin"))
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            # Chrome's Private Network Access: an https page calling 127.0.0.1 is
            # blocked unless the local server opts in explicitly
            self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        self.wfile.write(body)

    def _authorised(self) -> bool:
        got = self.headers.get("X-Aura-Token") or ""
        want = STATE["token"] or ""
        return bool(want) and hmac.compare_digest(got, want)

    def _read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return {}
        if length <= 0 or length > MAX_BODY:
            return {}
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return {}
        return data if isinstance(data, dict) else {}

    # -- routes ---------------------------------------------------------- #
    def do_OPTIONS(self) -> None:  # noqa: N802 (http.server naming)
        self.send_response(204)
        origin = cors_origin(self.headers.get("Origin"))
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            # Chrome's Private Network Access asks for this grant on a preflight and
            # then re-checks it on the real request; send it for every allowed origin.
            self.send_header("Access-Control-Allow-Private-Network", "true")
            if STATE.get("debug"):
                print("  [preflight] " + origin + " acrpn=" + str(self.headers.get("Access-Control-Request-Private-Network"))
                         + " acrh=" + str(self.headers.get("Access-Control-Request-Headers")))
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Aura-Token")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path not in ("/health", "/"):
            self._send(404, {"ok": False, "error": "not found"})
            return
        self._send(200, {
            "ok": True,
            "name": "AURA local bridge",
            "version": VERSION,
            "live": STATE["live"],
            "ops": sorted(ACTIONS),
            "roots": [str(r) for r in allowed_roots()],
            "auth": "required" if STATE["token"] else "off",
        })

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        if path != "/ghost":
            self._send(404, {"ok": False, "error": "not found"})
            return
        if not self._authorised():
            self._send(401, {"ok": False, "error": "missing or wrong X-Aura-Token"})
            return
        body = self._read_json()
        op = str(body.get("op") or "").strip()
        handler = ACTIONS.get(op)
        if not handler:
            self._send(400, {"ok": False, "error": f"unknown op: {op or '(none)'}"})
            return
        args = body.get("args") if isinstance(body.get("args"), dict) else {}
        started = time.perf_counter()
        try:
            result = handler(args)
        except ValueError as exc:
            self._send(400, {"ok": False, "error": str(exc)})
            return
        except Exception as exc:                      # never leak a traceback to the page
            self._send(500, {"ok": False, "error": f"{type(exc).__name__}: {exc}"[:240]})
            return
        result["ms"] = int((time.perf_counter() - started) * 1000)
        self._send(200, result)


def build_roots(raw: Iterable[str]) -> list[Path]:
    roots: list[Path] = []
    for item in raw:
        p = Path(os.path.expandvars(os.path.expanduser(item)))
        try:
            p = p.resolve()
        except OSError:
            continue
        if p.is_dir():
            roots.append(p)
        else:
            print(f"  ! skip root (not a folder): {p}")
    return roots or [r for r in DEFAULT_ROOTS if r.is_dir()]


def _utf8_console() -> None:
    """A Windows console is cp1252 by default and printing '→' killed the start-up
    line before the token was readable. Reconfigure, and never depend on it."""
    for stream in (sys.stdout, sys.stderr):
        try:
            # line_buffering matters: redirected output is block-buffered otherwise, so
            # the token line only appeared after the process exited
            stream.reconfigure(encoding="utf-8", errors="replace", line_buffering=True)
        except (AttributeError, ValueError, OSError):
            pass


def main(argv: list[str] | None = None) -> int:
    _utf8_console()
    ap = argparse.ArgumentParser(description="AURA local bridge (Ghost Mode) — 127.0.0.1 only")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--token", default="", help="fixed token (default: a fresh one each start)")
    ap.add_argument("--live", action="store_true", help="allow real file changes (still needs confirm)")
    ap.add_argument("--allow", action="append", default=[], help="folder the bridge may touch (repeatable)")
    ap.add_argument("--debug", action="store_true", help="print preflight headers (diagnosing CORS/PNA)")
    args = ap.parse_args(argv)

    STATE["live"] = bool(args.live)
    STATE["debug"] = bool(args.debug)
    STATE["roots"] = build_roots(args.allow)
    STATE["token"] = args.token or secrets.token_urlsafe(18)

    print("AURA local bridge " + VERSION)
    print("  url    : http://127.0.0.1:%d" % args.port)
    print("  mode   : " + ("LIVE (changes need confirm:true)" if STATE["live"] else "dry-run (nothing moves)"))
    print("  roots  : " + ", ".join(str(r) for r in STATE["roots"]))
    print("  token  : " + STATE["token"])
    print("  paste that token into AURA once (Ghost Mode -> Bridge); it stays on this machine.")
    print("  ops    : " + ", ".join(sorted(ACTIONS)))
    print("  stop   : Ctrl+C")

    try:
        httpd = ThreadingHTTPServer(("127.0.0.1", args.port), BridgeHandler)
    except OSError as exc:
        print(f"  ! cannot bind 127.0.0.1:{args.port} - {exc}")
        return 1
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n  bye")
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
