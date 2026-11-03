"""MESH — a tiny device-command relay (owner room + joined devices).

Why it exists: the same AURA page runs on a laptop (the owner) and on a phone
(the device). The owner shows a 6-digit code, the phone opens the link, and from
then on the laptop can ping, speak, vibrate or toast on the phone — and the phone
stays connected until it is explicitly disconnected.

Design notes
------------
* State is in memory: a relay like this is a convenience channel, not a database.
  Rooms die after 6 h of silence, so a restart never leaves zombies.
* Commands are acknowledged by the device (`seen` ids) instead of being deleted on
  read: a dropped response must not lose a command, and a retry must not run it
  twice — the device dedupes by id.
* A backgrounded phone polls far less often (browsers throttle it), so a device is
  "away" for 15 minutes before it is dropped, while the UI marks it idle.
"""

from __future__ import annotations

import asyncio
import random
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

from fastapi import APIRouter, Header, HTTPException
from pydantic import BaseModel, Field

LIVE_MS = 35_000
AWAY_TTL_MS = 15 * 60_000
CMD_TTL_MS = 120_000
ROOM_TTL_MS = 6 * 3600_000


def _now() -> int:
    return int(time.time() * 1000)


@dataclass(slots=True)
class Device:
    id: str
    name: str
    joined_at: int
    last_seen: int
    vis: bool = True
    meta: dict[str, Any] = field(default_factory=dict)


@dataclass(slots=True)
class Command:
    id: str
    kind: str
    payload: dict[str, Any]
    targets: list[str]
    created_at: int


@dataclass(slots=True)
class Room:
    code: str
    owner_token: str
    created_at: int
    touched_at: int
    devices: dict[str, Device] = field(default_factory=dict)
    commands: list[Command] = field(default_factory=list)
    results: list[dict[str, Any]] = field(default_factory=list)
    seq: int = 0


class MeshManager:
    def __init__(self) -> None:
        self._rooms: dict[str, Room] = {}
        self._by_owner: dict[str, str] = {}  # owner token -> code
        self._lock = asyncio.Lock()

    # -- helpers ------------------------------------------------------------ #

    def _room(self, code: str) -> Room:
        room = self._rooms.get(code)
        if room is None:
            raise HTTPException(status_code=404, detail="mesh closed")
        if _now() - room.touched_at > ROOM_TTL_MS:
            self._rooms.pop(code, None)
            self._by_owner.pop(room.owner_token, None)
            raise HTTPException(status_code=404, detail="mesh closed")
        return room

    def _owned(self, room: Room, token: str) -> Room:
        if not token or token != room.owner_token:
            raise HTTPException(status_code=403, detail="not the owner of this mesh")
        return room

    def _sweep(self, room: Room) -> None:
        now = _now()
        for device_id, device in list(room.devices.items()):
            ttl = AWAY_TTL_MS if not device.vis else AWAY_TTL_MS
            if now - device.last_seen > ttl:
                room.devices.pop(device_id, None)
        room.commands = [c for c in room.commands if now - c.created_at < CMD_TTL_MS]
        room.results = room.results[-200:]

    def _device_view(self, device: Device) -> dict[str, Any]:
        now = _now()
        return {
            "id": device.id,
            "name": device.name,
            "seen": now - device.last_seen,
            "fresh": now - device.last_seen < LIVE_MS and device.vis,
            "away": not device.vis,
            "meta": device.meta,
        }

    # -- owner -------------------------------------------------------------- #

    async def register(self, owner_token: str) -> Room:
        async with self._lock:
            existing = self._by_owner.get(owner_token)
            if existing and existing in self._rooms:
                room = self._rooms[existing]
                room.touched_at = _now()
                return room
            for _ in range(20):
                code = f"{random.randint(0, 999_999):06d}"
                if code not in self._rooms:
                    break
            else:  # pragma: no cover - 20 collisions is not a real scenario
                raise HTTPException(status_code=503, detail="could not allocate a code")
            room = Room(code=code, owner_token=owner_token, created_at=_now(), touched_at=_now())
            self._rooms[code] = room
            self._by_owner[owner_token] = code
            return room

    async def state(self, code: str, token: str, since: int = 0) -> dict[str, Any]:
        async with self._lock:
            room = self._owned(self._room(code), token)
            self._sweep(room)
            room.touched_at = _now()
            return {
                "code": room.code,
                "devices": [self._device_view(d) for d in room.devices.values()],
                "results": [r for r in room.results if r["seq"] > since],
                "seq": room.seq,
            }

    async def command(
        self, code: str, token: str, kind: str, payload: dict[str, Any], targets: list[str]
    ) -> int:
        async with self._lock:
            room = self._owned(self._room(code), token)
            self._sweep(room)
            room.touched_at = _now()
            wanted = [t for t in targets if t in room.devices] or list(room.devices)
            if not wanted:
                return 0
            room.commands.append(
                Command(id=uuid.uuid4().hex[:10], kind=kind, payload=payload, targets=wanted, created_at=_now())
            )
            return len(wanted)

    async def kick(self, code: str, token: str, device_id: str) -> bool:
        async with self._lock:
            room = self._owned(self._room(code), token)
            return room.devices.pop(device_id, None) is not None

    async def close(self, code: str, token: str) -> bool:
        async with self._lock:
            room = self._owned(self._room(code), token)
            self._rooms.pop(room.code, None)
            self._by_owner.pop(room.owner_token, None)
            return True

    # -- device ------------------------------------------------------------- #

    async def join(self, code: str, device_id: str, name: str, meta: dict[str, Any]) -> dict[str, Any]:
        async with self._lock:
            room = self._room(code)
            room.touched_at = _now()
            device = room.devices.get(device_id)
            if device is None:
                device = Device(id=device_id, name=name or "device", joined_at=_now(), last_seen=_now())
                room.devices[device_id] = device
            device.last_seen = _now()
            device.name = name or device.name
            device.meta.update(meta or {})
            device.vis = True
            return {"ok": True, "code": room.code, "peers": len(room.devices)}

    async def poll(
        self, code: str, device_id: str, seen: list[str], vis: bool = True
    ) -> dict[str, Any]:
        async with self._lock:
            room = self._room(code)
            device = room.devices.get(device_id)
            if device is None:
                # the room forgot us (TTL/restart): tell the client to re-join
                raise HTTPException(status_code=404, detail="mesh-closed")
            device.last_seen = _now()
            device.vis = bool(vis)
            room.touched_at = _now()
            self._sweep(room)
            drop = set(seen or [])
            room.commands = [c for c in room.commands if c.id not in drop]
            mine = [
                {"id": c.id, "kind": c.kind, "payload": c.payload}
                for c in room.commands
                if device_id in c.targets
            ]
            return {"ok": True, "commands": mine, "peers": len(room.devices)}

    async def result(
        self, code: str, device_id: str, command_id: str, ok: bool, text: str
    ) -> None:
        async with self._lock:
            room = self._room(code)
            room.touched_at = _now()
            if any(r["id"] == command_id for r in room.results):
                return  # idempotent: a retried result must not duplicate
            room.seq += 1
            device = room.devices.get(device_id)
            room.results.append(
                {
                    "seq": room.seq,
                    "id": command_id,
                    "device": device.name if device else device_id,
                    "ok": bool(ok),
                    "text": str(text or "")[:400],
                    "at": _now(),
                }
            )

    async def leave(self, code: str, device_id: str) -> bool:
        async with self._lock:
            room = self._room(code)
            room.touched_at = _now()
            return room.devices.pop(device_id, None) is not None


# --------------------------------------------------------------------------- #
# HTTP surface
# --------------------------------------------------------------------------- #


class RegisterIn(BaseModel):
    owner: str = Field(min_length=1, max_length=128)


class JoinIn(BaseModel):
    code: str = Field(min_length=6, max_length=6)
    device_id: str = Field(min_length=1, max_length=64)
    name: str = Field(default="device", max_length=48)
    meta: dict[str, Any] = Field(default_factory=dict)


class PollIn(BaseModel):
    code: str = Field(min_length=6, max_length=6)
    device_id: str = Field(min_length=1, max_length=64)
    seen: list[str] = Field(default_factory=list)
    vis: bool = True


class CommandIn(BaseModel):
    code: str = Field(min_length=6, max_length=6)
    kind: str = Field(min_length=1, max_length=32)
    payload: dict[str, Any] = Field(default_factory=dict)
    targets: list[str] = Field(default_factory=list)


class ResultIn(BaseModel):
    code: str = Field(min_length=6, max_length=6)
    device_id: str = Field(min_length=1, max_length=64)
    id: str = Field(min_length=1, max_length=64)
    ok: bool = True
    text: str = Field(default="", max_length=400)


class DeviceIn(BaseModel):
    code: str = Field(min_length=6, max_length=6)
    device_id: str = Field(min_length=1, max_length=64)


def create_mesh_router(mesh: MeshManager) -> APIRouter:
    """REST relay. The owner proves itself with `X-Aura-Owner` (its local profile id)."""
    router = APIRouter(prefix="/v1/mesh", tags=["mesh"])

    def token(owner: str | None) -> str:
        # The owner proves itself with a header, not a query string: query strings
        # end up in logs and in the history of every proxy in between.
        if not owner:
            raise HTTPException(status_code=401, detail="missing X-Aura-Owner")
        return owner

    Owner = Header(default=None, alias="X-Aura-Owner")

    @router.post("/register")
    async def register(body: RegisterIn) -> dict[str, Any]:
        room = await mesh.register(body.owner)
        return {"code": room.code, "owner": body.owner}

    @router.get("/state")
    async def state(code: str, since: int = 0, owner: str | None = Owner) -> dict[str, Any]:
        return await mesh.state(code, token(owner), since)

    @router.post("/command")
    async def command(body: CommandIn, owner: str | None = Owner) -> dict[str, Any]:
        queued = await mesh.command(body.code, token(owner), body.kind, body.payload, body.targets)
        return {"queued": queued}

    @router.post("/kick")
    async def kick(body: DeviceIn, owner: str | None = Owner) -> dict[str, Any]:
        return {"removed": await mesh.kick(body.code, token(owner), body.device_id)}

    @router.post("/close")
    async def close(code: str, owner: str | None = Owner) -> dict[str, Any]:
        return {"closed": await mesh.close(code, token(owner))}

    @router.post("/join")
    async def join(body: JoinIn) -> dict[str, Any]:
        return await mesh.join(body.code, body.device_id, body.name, body.meta)

    @router.post("/poll")
    async def poll(body: PollIn) -> dict[str, Any]:
        return await mesh.poll(body.code, body.device_id, body.seen, body.vis)

    @router.post("/result")
    async def result(body: ResultIn) -> dict[str, Any]:
        await mesh.result(body.code, body.device_id, body.id, body.ok, body.text)
        return {"ok": True}

    @router.post("/leave")
    async def leave(body: DeviceIn) -> dict[str, Any]:
        return {"left": await mesh.leave(body.code, body.device_id)}

    return router
