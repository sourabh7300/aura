"""MESH relay checks:  python tests/mesh_check.py

Exercises the same paths the browser uses: owner registers, a phone joins, the
owner sends targeted commands, the device acks them (so a retry never re-runs
one), results are deduped, kick and close behave.
"""

from __future__ import annotations

import os
import sys
import tempfile

try:
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[attr-defined]
except Exception:
    pass

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("AURA_USE_CHROMA", "0")
os.environ.setdefault("AURA_DATA_DIR", tempfile.mkdtemp(prefix="aura-mesh-"))

from fastapi.testclient import TestClient  # noqa: E402

from backend.main import app  # noqa: E402

passed = 0
failed = 0


def check(name: str, condition: bool, extra: object = None) -> None:
    global passed, failed
    if condition:
        passed += 1
        print(f"  ok   {name}")
    else:
        failed += 1
        print(f"  FAIL {name}" + (f" -> {extra!r}" if extra is not None else ""))


def main() -> None:
    with TestClient(app) as client:
        owner = {"X-Aura-Owner": "owner-1"}
        reg = client.post("/v1/mesh/register", json={"owner": "owner-1"})
        check("register -> 200", reg.status_code == 200, reg.text[:120])
        code = reg.json()["code"]
        check("code is six digits", code.isdigit() and len(code) == 6, code)

        again = client.post("/v1/mesh/register", json={"owner": "owner-1"}).json()["code"]
        check("register is idempotent per owner", again == code, again)

        join = client.post(
            "/v1/mesh/join",
            json={"code": code, "device_id": "phone-1", "name": "Pixel", "meta": {"battery": 74}},
        )
        check("device joins", join.status_code == 200 and join.json()["ok"], join.text[:120])

        state = client.get("/v1/mesh/state", params={"code": code}, headers=owner)
        devices = state.json()["devices"]
        check("state lists the device", len(devices) == 1 and devices[0]["name"] == "Pixel", devices)
        check("device is fresh right after join", devices[0]["fresh"] is True, devices)

        sent = client.post(
            "/v1/mesh/command",
            json={"code": code, "kind": "toast", "payload": {"text": "hi"}, "targets": []},
            headers=owner,
        ).json()
        check("command queued for the joined device", sent["queued"] == 1, sent)

        poll = client.post("/v1/mesh/poll", json={"code": code, "device_id": "phone-1", "seen": []}).json()
        check("device receives the command", len(poll["commands"]) == 1, poll)
        cmd_id = poll["commands"][0]["id"]

        acked = client.post(
            "/v1/mesh/poll", json={"code": code, "device_id": "phone-1", "seen": [cmd_id]}
        ).json()
        check("acked command is dropped", acked["commands"] == [], acked)

        client.post(
            "/v1/mesh/result",
            json={"code": code, "device_id": "phone-1", "id": cmd_id, "ok": True, "text": "toast shown"},
        )
        client.post(
            "/v1/mesh/result",
            json={"code": code, "device_id": "phone-1", "id": cmd_id, "ok": True, "text": "toast shown"},
        )
        after = client.get("/v1/mesh/state", params={"code": code, "since": 0}, headers=owner).json()
        check("result is stored once (dedupe)", len(after["results"]) == 1, after["results"])
        check("result carries the device name", after["results"][0]["device"] == "Pixel", after["results"])

        # away: a backgrounded phone must stay listed but not look live
        client.post("/v1/mesh/poll", json={"code": code, "device_id": "phone-1", "seen": [], "vis": False})
        away = client.get("/v1/mesh/state", params={"code": code}, headers=owner).json()["devices"][0]
        check("backgrounded device is away, not gone", away["away"] is True and away["fresh"] is False, away)

        # a non-owner must not drive someone else's mesh
        bad = client.post(
            "/v1/mesh/command",
            json={"code": code, "kind": "ping", "payload": {}, "targets": []},
            headers={"X-Aura-Owner": "someone-else"},
        )
        check("foreign owner is rejected", bad.status_code == 403, bad.status_code)

        # unknown device gets a re-join signal
        orphan = client.post("/v1/mesh/poll", json={"code": code, "device_id": "ghost", "seen": []})
        check("unknown device is told to re-join", orphan.status_code == 404, orphan.status_code)

        kick = client.post(
            "/v1/mesh/kick", json={"code": code, "device_id": "phone-1"}, headers=owner
        ).json()
        check("kick removes the device", kick["removed"] is True, kick)

        closed = client.post("/v1/mesh/close", params={"code": code}, headers=owner).json()
        check("close releases the room", closed["closed"] is True, closed)
        gone = client.post("/v1/mesh/poll", json={"code": code, "device_id": "phone-1", "seen": []})
        check("closed mesh is gone", gone.status_code == 404, gone.status_code)

    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
