"""Ghost Mode — tool contracts, execution policy and the pending-action store.

The /v1/chat endpoint can let the model *ask* for four actions. It never performs
them: a tool call is turned into a plan, parked behind a one-time token, and
returned to the browser, which shows a confirmation card. Only the browser has
the real hands (the page itself, or aura_bridge.py on the machine), so the
server cannot move a file even if the model is talked into trying.

Destructive or off-machine work needs an explicit confirmation — the card button
or the spoken phrase "Zeus, confirm" / "Aura, confirm". Everything else (a web
search, a read-only health check) can run on the first ask.

Nothing here imports FastAPI: it is plain data plus a tiny dict, so the same
contract can be tested without booting the app.
"""

from __future__ import annotations

import re
import secrets
import time
from typing import Any, Iterable

# --------------------------------------------------------------------------- #
# policy
# --------------------------------------------------------------------------- #

#: executor names the browser understands
EXEC_APP = "app"            # the page itself: device storage, a download, a new tab
EXEC_BRIDGE = "bridge"      # aura_bridge.py on 127.0.0.1:8765
EXEC_BROWSER = "browser"    # plain tab navigation, no data leaves the page

GHOST_TOOL_SPECS: dict[str, dict[str, Any]] = {
    "organize_files": {
        "description": (
            "Sort the files in one folder into sub-folders by a rule (pdf, images, "
            "documents, by-type, by-date). Moves real files, so it always needs the "
            "user's confirmation before anything happens."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "directory": {
                    "type": "string",
                    "description": "Absolute folder path, e.g. C:/Users/me/Downloads or /Workspace/Inbox",
                },
                "rule": {
                    "type": "string",
                    "enum": ["pdf", "images", "documents", "by-type", "by-date"],
                    "description": "How to group the files.",
                },
            },
            "required": ["directory"],
        },
        "executor": EXEC_BRIDGE,
        "destructive": True,
    },
    "create_workspace_note": {
        "description": (
            "Save a titled note on the user's device and offer it as a .md download. "
            "Safe to create, so no confirmation is required."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "title": {"type": "string", "description": "Short note title, 3-80 characters."},
                "content": {"type": "string", "description": "The note body, markdown is fine."},
            },
            "required": ["title", "content"],
        },
        "executor": EXEC_APP,
        "destructive": False,
    },
    "open_and_search_web": {
        "description": (
            "Open a web search for the user's query in a new tab. Reads nothing and "
            "writes nothing, so it runs immediately."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to search for, verbatim."},
            },
            "required": ["query"],
        },
        "executor": EXEC_BROWSER,
        "destructive": False,
    },
    "system_health_check": {
        "description": (
            "Read-only diagnostics: disk space, memory, uptime and the busiest processes "
            "(local bridge), or battery/network/memory of the current page when no bridge "
            "is connected. Never changes anything."
        ),
        "parameters": {"type": "object", "properties": {}, "required": []},
        "executor": EXEC_BRIDGE,
        "destructive": False,
    },
}

GHOST_TOOL_NAMES: tuple[str, ...] = tuple(GHOST_TOOL_SPECS)

#: spoken or typed approval
CONFIRM_RE = re.compile(r"\b(zeus|aura)\s*[,:!.\-]?\s*(please\s+)?confirm\b", re.IGNORECASE)
#: the same words appearing inside a longer sentence are still an approval
CONFIRM_LOOSE_RE = re.compile(r"\b(zeus|aura)\b[^.]{0,20}\bconfirm(ed)?\b", re.IGNORECASE)

CONFIRM_TTL = 120.0
MAX_PENDING = 40
_pending: dict[str, dict[str, Any]] = {}


def requires_confirmation(name: str) -> bool:
    return bool(GHOST_TOOL_SPECS.get(name, {}).get("destructive"))


def executor_for(name: str) -> str:
    return str(GHOST_TOOL_SPECS.get(name, {}).get("executor") or EXEC_APP)


def is_confirmation(text: str) -> bool:
    """True for "Zeus, confirm" / "Aura confirm please" — and nothing else."""
    s = str(text or "").strip()
    if not s or len(s) > 80:
        return False
    return bool(CONFIRM_RE.search(s) or CONFIRM_LOOSE_RE.search(s))


def summarise(name: str, args: dict[str, Any]) -> str:
    """One plain sentence for the confirmation card, in the app's voice."""
    if name == "organize_files":
        return f"Sort {args.get('directory') or 'the folder'} by {args.get('rule') or 'pdf'}"
    if name == "create_workspace_note":
        return f"Save note “{str(args.get('title') or '')[:60]}”"
    if name == "open_and_search_web":
        return f"Search the web for “{str(args.get('query') or '')[:60]}”"
    if name == "system_health_check":
        return "Run a read-only system health check"
    return name


def _prune() -> None:
    now = time.time()
    for token in [t for t, a in _pending.items() if now - a.get("at", 0) > CONFIRM_TTL]:
        _pending.pop(token, None)
    while len(_pending) > MAX_PENDING:
        oldest = min(_pending, key=lambda t: _pending[t].get("at", 0))
        _pending.pop(oldest, None)


def plan(name: str, args: dict[str, Any] | None = None) -> dict[str, Any]:
    """Turn a model tool call into the payload the browser receives.

    No side effect other than an in-memory token — the same shape is returned for
    every tool, so the frontend has one code path.
    """
    spec = GHOST_TOOL_SPECS.get(name)
    if not spec:
        return {"status": "unsupported", "tool": name, "error": "unknown tool"}
    clean = {k: v for k, v in (args or {}).items() if isinstance(v, (str, int, float, bool))}
    for key in list(clean):
        if isinstance(clean[key], str) and len(clean[key]) > 4000:
            clean[key] = clean[key][:4000]
    _prune()
    token = secrets.token_urlsafe(12)
    action = {
        "token": token,
        "tool": name,
        "args": clean,
        "executor": executor_for(name),
        "requires_confirmation": requires_confirmation(name),
        "summary": summarise(name, clean),
        "at": time.time(),
    }
    _pending[token] = action
    return {
        "status": "planned",
        "tool": name,
        "executor": action["executor"],
        "requires_confirmation": action["requires_confirmation"],
        "token": token,
        "summary": action["summary"],
        "args": clean,
        "note": "the browser executes this; the server never touches the filesystem",
    }


def take(token: str) -> dict[str, Any] | None:
    """Consume a parked action (single use, short lived)."""
    _prune()
    action = _pending.pop(str(token or ""), None)
    if not action:
        return None
    return {k: v for k, v in action.items() if k != "at"}


def actions_from_trace(trace: Iterable[Any]) -> list[dict[str, Any]]:
    """Pull the ghost plans out of a ChatResult tool trace, in order."""
    out: list[dict[str, Any]] = []
    for step in trace or []:
        result = getattr(step, "result", None)
        if isinstance(result, dict) and result.get("status") == "planned" and result.get("token"):
            out.append(result)
    return out


# --------------------------------------------------------------------------- #
# tool registration (stubs only — the browser does the work)
# --------------------------------------------------------------------------- #
def register_ghost_tools() -> None:
    """Register the four tools with the provider router, idempotently."""
    from .router import TOOL_REGISTRY, tool  # local import keeps this module testable

    if "organize_files" in TOOL_REGISTRY:
        return

    def make(name: str):
        async def runner(**kwargs: Any) -> dict[str, Any]:
            return plan(name, kwargs)

        runner.__name__ = name
        return runner

    for name, spec in GHOST_TOOL_SPECS.items():
        tool(
            name=name,
            description=spec["description"],
            parameters=spec["parameters"],
        )(make(name))
