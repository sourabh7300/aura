"""PASSIVE CO-PILOT — FastAPI parity for the Node endpoint.

The live site is served by the Node backend (aura-backend/server.js), which is what
Render runs today. This module gives the FastAPI build the same contract so either
backend can serve the page:

    POST /api/passive-vision
    { "image": "data:image/jpeg;base64,...", "mode": "Standard" | "Zeus Mode" }
    -> { "action": "IGNORE" }
    -> { "action": "SUGGEST", "short_voice_line": "...", "detailed_fix": "markdown" }

Keys: GEMINI_API_KEY (best screen reader, shared quota) and GROQ_API_KEY (fallback,
Llama 4 Scout is multimodal). With neither key the route answers IGNORE, so the
frontend keeps working without any vision key at all.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import time
from typing import Any

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

GEMINI_KEY = os.getenv("GEMINI_API_KEY") or os.getenv("AI_KEY_VISION") or ""
GROQ_KEY = os.getenv("GROQ_API_KEY") or os.getenv("AI_KEY") or ""
GEMINI_MODELS = [m for m in (os.getenv("VISION_MODELS") or "gemini-2.5-flash,gemini-2.0-flash").split(",") if m]
GROQ_VISION_MODELS = [m for m in (os.getenv("GROQ_VISION_MODELS") or "meta-llama/llama-4-scout-17b-16e-instruct").split(",") if m]

MIN_GAP_S = 2.5          # one analysis per device per 2.5s
DAY_MAX = 400            # hard daily ceiling per device
CAP_S = 35.0             # a passive check must never hold a connection open

PROMPT = (
    "You are the passive co-pilot inside AURA, an assistant that is sometimes allowed to see the user's screen. "
    "Look at this single frame and decide whether the user is VISIBLY STUCK. "
    "Stuck means: a code editor or terminal showing an error/stack trace they have not fixed, "
    "a form or checkout with a visible validation error, or a dense technical passage being highlighted. "
    "Not stuck: reading normal text, browsing, chatting, watching video, idle, gaming, personal content. "
    "Never mention private details you see. Never guess. If nothing is clearly wrong, stay silent. "
    'Reply with JSON only: either {"action":"IGNORE"} or '
    '{"action":"SUGGEST","short_voice_line":"<one natural spoken sentence, 6-12 words>",'
    '"detailed_fix":"<markdown, max 120 words, concrete steps>"}.'
)

_seen: dict[str, float] = {}
_count: dict[str, tuple[str, int]] = {}
_stats = {"frames": 0, "ignored": 0, "suggestions": 0, "lastErr": ""}


def _parse(text: str, model: str) -> dict[str, Any] | None:
    match = re.search(r"\{[\s\S]*\}", text or "")
    if not match:
        return None
    try:
        data = json.loads(match.group(0))
    except Exception:
        return None
    if str(data.get("action", "")).upper() != "SUGGEST":
        return {"action": "IGNORE", "model": model}
    line = " ".join(str(data.get("short_voice_line") or "").split())[:90]
    fix = str(data.get("detailed_fix") or "").strip()[:1200]
    if not line or not fix:
        return {"action": "IGNORE", "model": model}
    return {"action": "SUGGEST", "short_voice_line": line, "detailed_fix": fix, "model": model}


async def _gemini(client: httpx.AsyncClient, prompt: str, mime: str, b64: str) -> dict[str, Any] | None:
    if not GEMINI_KEY:
        return None
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}, {"inlineData": {"mimeType": mime, "data": b64}}]}],
        "generationConfig": {"temperature": 0.15, "maxOutputTokens": 320},
    }
    for model in GEMINI_MODELS[:2]:
        try:
            r = await client.post(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                params={"key": GEMINI_KEY}, json=body, timeout=7.0,
            )
            if r.status_code != 200:
                _stats["lastErr"] = f"{model} HTTP {r.status_code}"
                continue
            data = r.json()
            parts = ((data.get("candidates") or [{}])[0].get("content") or {}).get("parts") or []
            text = "".join(p.get("text", "") for p in parts if not p.get("thought")).strip()
            parsed = _parse(text, model)
            if parsed:
                return parsed
        except Exception as exc:  # timeout / network
            _stats["lastErr"] = f"{model} {exc}"
    return None


async def _groq(client: httpx.AsyncClient, prompt: str, mime: str, b64: str) -> dict[str, Any] | None:
    if not GROQ_KEY:
        return None
    messages = [
        {"role": "system", "content": prompt},
        {"role": "user", "content": [
            {"type": "text", "text": "Is the user stuck on this screen frame? Reply with the JSON described."},
            {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
        ]},
    ]
    for model in GROQ_VISION_MODELS[:2]:
        try:
            r = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={"Authorization": f"Bearer {GROQ_KEY}"},
                json={"model": model, "messages": messages, "max_tokens": 320, "temperature": 0.2},
                timeout=20.0,
            )
            if r.status_code != 200:
                _stats["lastErr"] = f"groq/{model} HTTP {r.status_code}"
                continue
            text = (((r.json().get("choices") or [{}])[0].get("message") or {}).get("content") or "").strip()
            parsed = _parse(text, f"groq/{model}")
            if parsed:
                return parsed
        except Exception as exc:
            _stats["lastErr"] = f"groq/{model} {exc}"
    return None


async def analyze(image: str, mode: str) -> dict[str, Any] | None:
    match = re.match(r"^data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$", image or "")
    if not match:
        return None
    mime, b64 = match.group(1), re.sub(r"\s+", "", match.group(2))
    if not (500 <= len(b64) <= 5_500_000):
        return None
    prompt = PROMPT + (f"\nActive mode: {mode[:20]}." if mode else "")
    async with httpx.AsyncClient() as client:
        tasks = [asyncio.create_task(_gemini(client, prompt, mime, b64)),
                 asyncio.create_task(_groq(client, prompt, mime, b64))]
        done, pending = await asyncio.wait(tasks, timeout=CAP_S, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        for task in done:
            try:
                result = task.result()
            except Exception:
                result = None
            if result:
                return result
    return None


def create_copilot_router() -> APIRouter:
    router = APIRouter()

    @router.post("/api/passive-vision")
    async def passive_vision(request: Request) -> JSONResponse:
        body = await request.json()
        ip = (request.headers.get("x-forwarded-for") or (request.client.host if request.client else "anon")).split(",")[0].strip()
        now = time.time()
        if _seen.get(ip, 0) + MIN_GAP_S > now:
            return JSONResponse({"action": "IGNORE", "reason": "too_soon"}, status_code=429)
        day = time.strftime("%Y-%m-%d")
        stored_day, n = _count.get(ip, (day, 0))
        n = n if stored_day == day else 0
        if n >= DAY_MAX:
            return JSONResponse({"action": "IGNORE", "reason": "daily_cap"}, status_code=429)
        if not (GEMINI_KEY or GROQ_KEY):
            return JSONResponse({"action": "IGNORE", "reason": "vision_off"})
        image = body.get("image")
        if not image:
            return JSONResponse({"action": "IGNORE", "reason": "image_required"}, status_code=400)

        _seen[ip] = now
        _count[ip] = (day, n + 1)
        _stats["frames"] += 1
        try:
            out = await analyze(image, str(body.get("mode") or ""))
        except Exception as exc:
            _stats["lastErr"] = str(exc)[:140]
            out = None
        if not out:
            _stats["ignored"] += 1
            return JSONResponse({"action": "IGNORE", "reason": "no_read"})
        _stats["suggestions" if out["action"] == "SUGGEST" else "ignored"] += 1
        return JSONResponse(out)

    @router.get("/api/passive-vision/stats")
    async def passive_stats() -> dict[str, Any]:
        return dict(_stats)

    return router
