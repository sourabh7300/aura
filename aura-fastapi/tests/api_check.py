"""REST + WebSocket smoke test:  python tests/api_check.py

Runs the real app through Starlette's test client — no API keys needed, because
nothing here calls a model. It verifies wiring: lifespan startup, memory
endpoints, the socket handshake/state protocol, and that the UI is served.
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
os.environ.setdefault("AURA_DATA_DIR", tempfile.mkdtemp(prefix="aura-api-"))
os.environ.setdefault("ALLOWED_ORIGINS", "*")

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
        health = client.get("/health")
        check("GET /health -> 200", health.status_code == 200, health.status_code)
        body = health.json()
        check("health reports memory backend", body.get("memory", {}).get("backend") in ("sqlite", "chroma"), body)
        check("health reports providers block", "providers" in body, list(body))

        created = client.post(
            "/v1/memory",
            json={
                "user_id": "tester",
                "text": "My standup is at 9:30 every morning.",
                "metadata": {"kind": "routine"},
            },
        )
        check("POST /v1/memory -> 201", created.status_code == 201, created.text[:120])
        check("memory returns an id", bool(created.json().get("id")), created.text[:120])

        client.post("/v1/memory", json={"user_id": "tester", "text": "I prefer dark mode everywhere."})
        client.post("/v1/memory", json={"user_id": "other", "text": "My standup is at 6pm."})

        search = client.get("/v1/memory/search", params={"user_id": "tester", "q": "when is my standup?", "top_k": 3})
        check("GET /v1/memory/search -> 200", search.status_code == 200, search.text[:120])
        results = search.json().get("results", [])
        check("search returns a hit", len(results) > 0, results)
        check(
            "top hit is the standup note",
            bool(results) and "standup" in results[0]["text"],
            results[0]["text"] if results else None,
        )
        check(
            "search is user-scoped",
            all(r["created_at"] for r in results) and "6pm" not in (results[0]["text"] if results else ""),
            results,
        )

        recent = client.get("/v1/memory/recent", params={"user_id": "tester", "limit": 10})
        check("GET /v1/memory/recent -> 200", recent.status_code == 200, recent.text[:120])
        check("recent lists both tester memories", recent.json().get("count") == 2, recent.json().get("count"))

        ui = client.get("/")
        check("GET / -> UI html", ui.status_code == 200 and "AURA" in ui.text, ui.status_code)
        check("UI ships the orb canvas", 'id="orb"' in ui.text, None)

        # ---- websocket handshake + control frames ----
        with client.websocket_connect("/ws/stream") as ws:
            ready = ws.receive_json()
            check("ws greets with ready", ready.get("type") == "ready", ready)
            check("ws exposes a session id", bool(ready.get("session")), ready)

            ws.send_json({"type": "hello", "user_id": "tester"})
            second = ws.receive_json()
            check("ws hello re-acks", second.get("type") == "ready", second)

            ws.send_json({"type": "ping"})
            pong = ws.receive_json()
            check("ws ping -> pong", pong.get("type") == "pong", pong)

            ws.send_json({"type": "video", "data": "A" * 120, "mime": "image/jpeg"})
            ws.send_json({"type": "audio_end", "mime": "audio/webm"})
            reply = ws.receive_json()
            # no audio was buffered, so the server must answer with a clear error,
            # never hang and never crash the socket
            check("ws reports empty audio instead of hanging", reply.get("type") in ("error", "state"), reply)

    print(f"\n{passed} passed, {failed} failed")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
