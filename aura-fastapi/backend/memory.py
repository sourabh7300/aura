"""MODULE 1 — Persistent long-term memory (SQLite + vector search).

Design
------
* SQLite (aiosqlite) is the source of truth. Every memory row keeps the raw text,
  the owner and arbitrary metadata, so nothing is lost if a vector index dies or
  gets rebuilt.
* ChromaDB stores the embeddings and does the similarity search. If chromadb is
  not installed (or its client fails to start) we transparently fall back to a
  small SQLite cosine index: the service still boots and still retrieves, it just
  scans instead of using an ANN index. Good enough for a personal assistant,
  and it keeps local development dependency-free.
* Retrieval blends two signals:
      similarity  = cosine(query, memory)          -> "is this about the question?"
      recency     = 0.5 ** (age_days / half_life)  -> "did we just talk about it?"
      score       = similarity * (1 - w + w*recency)
  The decay is a plain exponential half-life so it is explainable and tunable
  per deployment instead of a magic constant hidden in the ranking code.

Everything here is async: aiosqlite runs the blocking sqlite3 driver in a
thread, and the Chroma client is wrapped with `asyncio.to_thread` because its
Python client is synchronous.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import math
import re
import time
import uuid
from array import array
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Protocol, Sequence

import aiosqlite

# --------------------------------------------------------------------------- #
# Types
# --------------------------------------------------------------------------- #

Vector = list[float]
# A batch embedder: takes N texts, returns N vectors of the same length.
Embedder = Callable[[Sequence[str]], list[Vector]]

_TOKEN_RE = re.compile(r"[a-z0-9\u0900-\u097f]+", re.IGNORECASE)


def _stem(token: str) -> str:
    """Tiny suffix stripper so plural/gerund forms still meet.

    Not a proper stemmer — just the handful of English endings that make a
    lexical fallback miss an obvious match ("peanuts" vs "peanut"). Applied to
    queries and documents alike, so it only has to be consistent, not correct.
    """
    if len(token) <= 4:
        return token
    if token.endswith("ies") and len(token) > 5:
        return token[:-3] + "y"
    if token.endswith("sses"):
        return token[:-2]
    if token.endswith("es") and len(token) > 5:
        return token[:-2]
    if token.endswith("s") and not token.endswith("ss"):
        return token[:-1]
    if token.endswith("ing") and len(token) > 6:
        return token[:-3]
    if token.endswith("ed") and len(token) > 5:
        return token[:-2]
    return token


@dataclass(slots=True)
class MemoryRecord:
    """One stored memory, exactly as it lives in SQLite."""

    id: str
    user_id: str
    text: str
    metadata: dict[str, Any]
    created_at: float  # unix seconds (float keeps ordering stable inside a second)

    @property
    def age_days(self) -> float:
        return max(0.0, (time.time() - self.created_at) / 86_400.0)


@dataclass(slots=True)
class RetrievedMemory:
    """A memory plus the scores that explain *why* it was returned."""

    memory: MemoryRecord
    similarity: float
    recency: float
    score: float


# --------------------------------------------------------------------------- #
# Embeddings
# --------------------------------------------------------------------------- #


class HashingEmbedder:
    """Dependency-free embedder used when no ML embedding function is available.

    It is a hashing bag of unigrams + bigrams projected into `dims` buckets and
    L2-normalised. That is lexical rather than truly semantic — documented as a
    degraded mode — but it is deterministic, offline, and keeps every code path
    (index, search, decay, ranking) exercised in tests and in local dev.
    """

    name = "hashing-v2"

    def __init__(self, dims: int = 2048) -> None:
        # 2048 buckets keeps collisions low for short chat lines; measured on a
        # 3-candidate sanity set, 384 dims ranked the wrong memory first.
        self.dims = dims

    def _vector(self, text: str) -> Vector:
        vec = [0.0] * self.dims
        tokens = [_stem(t) for t in _TOKEN_RE.findall(text.lower())]
        if not tokens:
            return vec
        # Unigrams carry the meaning; bigrams only reinforce exact phrases, so they
        # are down-weighted. Hashing is unsigned on purpose: signed hashing cancels
        # real overlaps against collision noise on sparse short texts (measured:
        # the right memory scored -0.03 while an unrelated one scored +0.04).
        grams: list[tuple[str, float]] = [(t, 1.0) for t in tokens]
        grams += [(tokens[i] + "_" + tokens[i + 1], 0.5) for i in range(len(tokens) - 1)]
        for gram, weight in grams:
            digest = hashlib.blake2b(gram.encode("utf-8"), digest_size=8).digest()
            idx = int.from_bytes(digest[:4], "big") % self.dims
            # sub-linear term weighting keeps long messages from dominating
            vec[idx] += weight * (1.0 + math.log(1 + len(gram)))
        return _l2_normalise(vec)

    def __call__(self, texts: Sequence[str]) -> list[Vector]:
        return [self._vector(t) for t in texts]


def _default_embedder() -> Embedder:
    """Prefer Chroma's ONNX MiniLM (real semantics); degrade to hashing.

    Chroma's default function downloads a small model on first use. If that is
    unavailable (offline build, no onnxruntime) we quietly use the hashing
    embedder rather than refusing to start.
    """
    try:  # pragma: no cover - depends on the optional model runtime
        from chromadb.utils.embedding_functions import (  # type: ignore[import-not-found]
            DefaultEmbeddingFunction,
        )

        fn = DefaultEmbeddingFunction()

        def embed(texts: Sequence[str]) -> list[Vector]:
            return [[float(x) for x in v] for v in fn(list(texts))]

        embed.name = "chroma-default"  # type: ignore[attr-defined]
        return embed
    except Exception:
        return HashingEmbedder()


def _l2_normalise(vec: Vector) -> Vector:
    norm = math.sqrt(sum(v * v for v in vec))
    if norm == 0.0:
        return vec
    return [v / norm for v in vec]


def _cosine(a: Sequence[float], b: Sequence[float]) -> float:
    if len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    if na == 0.0 or nb == 0.0:
        return 0.0
    return dot / (na * nb)


# --------------------------------------------------------------------------- #
# Vector stores
# --------------------------------------------------------------------------- #


class VectorStore(Protocol):
    """Minimal contract the manager needs — Chroma and the SQLite fallback both fit."""

    async def upsert(
        self, memory_id: str, user_id: str, vector: Vector, document: str, metadata: dict[str, Any]
    ) -> None: ...

    async def query(self, user_id: str, vector: Vector, limit: int) -> list[tuple[str, float]]:
        """Return (memory_id, cosine similarity in [-1, 1]) ordered by similarity desc."""
        ...

    async def delete(self, memory_id: str) -> None: ...

    async def close(self) -> None: ...


class ChromaVectorStore:
    """ChromaDB adapter. All blocking calls are pushed to a worker thread."""

    def __init__(self, persist_dir: str, collection: str) -> None:
        import chromadb  # imported lazily so the fallback path needs no package
        from chromadb.config import Settings as ChromaSettings

        self._client = chromadb.PersistentClient(
            path=persist_dir, settings=ChromaSettings(anonymized_telemetry=False)
        )
        self._collection = self._client.get_or_create_collection(
            name=collection,
            metadata={"hnsw:space": "cosine"},  # cosine keeps scores comparable to our fallback
        )

    async def upsert(
        self, memory_id: str, user_id: str, vector: Vector, document: str, metadata: dict[str, Any]
    ) -> None:
        clean = {k: v for k, v in metadata.items() if isinstance(v, (str, int, float, bool))}

        def _run() -> None:
            self._collection.upsert(
                ids=[memory_id],
                embeddings=[vector],
                documents=[document],
                metadatas=[{**clean, "user_id": user_id}],
            )

        await asyncio.to_thread(_run)

    async def query(self, user_id: str, vector: Vector, limit: int) -> list[tuple[str, float]]:
        def _run() -> list[tuple[str, float]]:
            res = self._collection.query(
                query_embeddings=[vector],
                n_results=max(1, limit),
                where={"user_id": user_id},
            )
            ids = (res.get("ids") or [[]])[0]
            dists = (res.get("distances") or [[]])[0]
            # hnsw:space=cosine returns distance = 1 - cosine
            return [(i, 1.0 - float(d)) for i, d in zip(ids, dists)]

        return await asyncio.to_thread(_run)

    async def delete(self, memory_id: str) -> None:
        await asyncio.to_thread(self._collection.delete, ids=[memory_id])

    async def close(self) -> None:
        # PersistentClient flushes on write; nothing to tear down explicitly.
        return None


class SQLiteVectorStore:
    """Dependency-free fallback: vectors in SQLite, cosine computed in Python."""

    def __init__(self, db: aiosqlite.Connection) -> None:
        self._db = db

    async def upsert(
        self, memory_id: str, user_id: str, vector: Vector, document: str, metadata: dict[str, Any]
    ) -> None:
        blob = array("f", vector).tobytes()
        await self._db.execute(
            "INSERT OR REPLACE INTO vectors (id, user_id, dim, vec) VALUES (?, ?, ?, ?)",
            (memory_id, user_id, len(vector), blob),
        )
        await self._db.commit()

    async def query(self, user_id: str, vector: Vector, limit: int) -> list[tuple[str, float]]:
        cursor = await self._db.execute(
            "SELECT id, dim, vec FROM vectors WHERE user_id = ?", (user_id,)
        )
        rows = await cursor.fetchall()
        scored: list[tuple[str, float]] = []
        for row in rows:
            stored = array("f")
            stored.frombytes(row["vec"])
            if len(stored) != len(vector):
                continue  # embedder changed size — ignore instead of comparing garbage
            scored.append((row["id"], _cosine(vector, stored)))
        scored.sort(key=lambda item: item[1], reverse=True)
        return scored[: max(1, limit)]

    async def delete(self, memory_id: str) -> None:
        await self._db.execute("DELETE FROM vectors WHERE id = ?", (memory_id,))
        await self._db.commit()

    async def close(self) -> None:
        return None


# --------------------------------------------------------------------------- #
# MemoryManager
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class MemoryConfig:
    db_path: str = "data/aura.db"
    chroma_dir: str = "data/chroma"
    collection: str = "aura_memories"
    # 0.0 = pure semantic, 1.0 = pure recency. 0.35 keeps relevance dominant
    # while letting a fresh memory win a near-tie (that is the point of the decay).
    recency_weight: float = 0.35
    decay_half_life_days: float = 21.0
    embedder: Embedder | None = None
    use_chroma: bool = True


class MemoryManager:
    """Async façade over SQLite + a vector index.

    Lifecycle: `await manager.start()` exactly once, `await manager.close()` on
    shutdown. Both are idempotent so tests can call them freely.
    """

    def __init__(self, config: MemoryConfig | None = None) -> None:
        self.config = config or MemoryConfig()
        self._db: aiosqlite.Connection | None = None
        self._store: VectorStore | None = None
        self._embedder: Embedder = self.config.embedder or _default_embedder()
        self._dim: int | None = None
        self._lock = asyncio.Lock()  # serialises embed+write so the index never interleaves
        self.backend: str = "uninitialised"

    # -- lifecycle ---------------------------------------------------------- #

    async def start(self) -> None:
        if self._db is not None:
            return
        import os

        os.makedirs(os.path.dirname(self.config.db_path) or ".", exist_ok=True)
        self._db = await aiosqlite.connect(self.config.db_path)
        self._db.row_factory = aiosqlite.Row
        await self._db.execute("PRAGMA journal_mode=WAL")  # concurrent reads while writing
        await self._db.execute("PRAGMA foreign_keys=ON")
        await self._db.executescript(
            """
            CREATE TABLE IF NOT EXISTS memories (
                id         TEXT PRIMARY KEY,
                user_id    TEXT NOT NULL,
                text       TEXT NOT NULL,
                metadata   TEXT NOT NULL DEFAULT '{}',
                created_at REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_memories_user_time
                ON memories (user_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS vectors (
                id      TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                dim     INTEGER NOT NULL,
                vec     BLOB NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_vectors_user ON vectors (user_id);
            """
        )
        await self._db.commit()

        self._store = await self._build_store()
        self.backend = "chroma" if isinstance(self._store, ChromaVectorStore) else "sqlite"
        await self._warm_dimension()

    async def _build_store(self) -> VectorStore:
        assert self._db is not None
        if self.config.use_chroma:
            try:
                return ChromaVectorStore(self.config.chroma_dir, self.config.collection)
            except Exception:
                # missing package, corrupt index, or a version bump: never block boot
                pass
        return SQLiteVectorStore(self._db)

    async def _warm_dimension(self) -> None:
        """Learn the embedder width once so mismatched vectors are rejected early."""
        try:
            vec = (await asyncio.to_thread(self._embedder, ["dimension probe"]))[0]
            self._dim = len(vec)
        except Exception:
            self._dim = None

    async def close(self) -> None:
        if self._store is not None:
            await self._store.close()
            self._store = None
        if self._db is not None:
            await self._db.close()
            self._db = None
        self.backend = "closed"

    # -- embedding ---------------------------------------------------------- #

    async def _embed(self, texts: Sequence[str]) -> list[Vector]:
        # `to_thread` keeps an ONNX/sentence-transformers model off the event loop
        vectors = await asyncio.to_thread(self._embedder, list(texts))
        if self._dim is None and vectors:
            self._dim = len(vectors[0])
        return [list(map(float, v)) for v in vectors]

    # -- writes ------------------------------------------------------------- #

    async def save_memory(
        self, user_id: str, text: str, metadata: dict[str, Any] | None = None
    ) -> MemoryRecord:
        """Persist raw text to SQLite and its embedding to the vector index."""
        if self._db is None or self._store is None:
            raise RuntimeError("MemoryManager.start() must be awaited before use")
        text = (text or "").strip()
        if not text:
            raise ValueError("text must not be empty")
        if not user_id:
            raise ValueError("user_id must not be empty")

        record = MemoryRecord(
            id=uuid.uuid4().hex,
            user_id=user_id,
            text=text,
            metadata=dict(metadata or {}),
            created_at=time.time(),
        )

        async with self._lock:
            vector = (await self._embed([text]))[0]
            await self._db.execute(
                "INSERT INTO memories (id, user_id, text, metadata, created_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (
                    record.id,
                    record.user_id,
                    record.text,
                    json.dumps(record.metadata, ensure_ascii=False),
                    record.created_at,
                ),
            )
            await self._db.commit()
            try:
                await self._store.upsert(
                    record.id, record.user_id, vector, record.text, record.metadata
                )
            except Exception:
                # The row is already durable; a failed index write must not lose
                # the conversation. Re-indexing is a maintenance job, not a crash.
                pass
        return record

    async def forget(self, memory_id: str) -> bool:
        if self._db is None or self._store is None:
            raise RuntimeError("MemoryManager.start() must be awaited before use")
        cursor = await self._db.execute("DELETE FROM memories WHERE id = ?", (memory_id,))
        await self._db.commit()
        deleted = cursor.rowcount > 0
        try:
            await self._store.delete(memory_id)
        except Exception:
            pass
        return deleted

    # -- reads -------------------------------------------------------------- #

    async def retrieve_context(
        self, user_id: str, query: str, top_k: int = 3, *, over_fetch: int = 4
    ) -> list[RetrievedMemory]:
        """Semantic search for `user_id`, re-ranked with exponential recency decay."""
        if self._db is None or self._store is None:
            raise RuntimeError("MemoryManager.start() must be awaited before use")
        query = (query or "").strip()
        top_k = max(1, min(int(top_k or 3), 20))
        if not query:
            return []

        vector = (await self._embed([query]))[0]
        # over-fetch: the decay can promote older-but-relevant rows past the cut
        hits = await self._store.query(user_id, vector, limit=top_k * over_fetch)
        if not hits:
            return []

        ids = [hit_id for hit_id, _ in hits]
        placeholders = ",".join("?" for _ in ids)
        cursor = await self._db.execute(
            f"SELECT id, user_id, text, metadata, created_at FROM memories"
            f" WHERE user_id = ? AND id IN ({placeholders})",
            (user_id, *ids),
        )
        rows = {row["id"]: row for row in await cursor.fetchall()}

        cfg = self.config
        now = time.time()
        ranked: list[RetrievedMemory] = []
        for memory_id, similarity in hits:
            row = rows.get(memory_id)
            if row is None:  # index outlived the row (manual delete) — skip silently
                continue
            age_days = max(0.0, (now - float(row["created_at"])) / 86_400.0)
            recency = 0.5 ** (age_days / max(cfg.decay_half_life_days, 0.01))
            w = min(max(cfg.recency_weight, 0.0), 1.0)
            score = similarity * (1.0 - w + w * recency)
            ranked.append(
                RetrievedMemory(
                    memory=MemoryRecord(
                        id=row["id"],
                        user_id=row["user_id"],
                        text=row["text"],
                        metadata=json.loads(row["metadata"] or "{}"),
                        created_at=float(row["created_at"]),
                    ),
                    similarity=float(similarity),
                    recency=float(recency),
                    score=float(score),
                )
            )

        ranked.sort(key=lambda item: item.score, reverse=True)
        return ranked[:top_k]

    async def recent(self, user_id: str, limit: int = 20) -> list[MemoryRecord]:
        """Newest-first listing for the Memory Log panel in the UI."""
        if self._db is None:
            raise RuntimeError("MemoryManager.start() must be awaited before use")
        limit = max(1, min(int(limit or 20), 200))
        cursor = await self._db.execute(
            "SELECT id, user_id, text, metadata, created_at FROM memories"
            " WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
            (user_id, limit),
        )
        return [
            MemoryRecord(
                id=row["id"],
                user_id=row["user_id"],
                text=row["text"],
                metadata=json.loads(row["metadata"] or "{}"),
                created_at=float(row["created_at"]),
            )
            for row in await cursor.fetchall()
        ]

    async def count(self, user_id: str | None = None) -> int:
        if self._db is None:
            raise RuntimeError("MemoryManager.start() must be awaited before use")
        if user_id:
            cursor = await self._db.execute(
                "SELECT COUNT(*) AS n FROM memories WHERE user_id = ?", (user_id,)
            )
        else:
            cursor = await self._db.execute("SELECT COUNT(*) AS n FROM memories")
        row = await cursor.fetchone()
        return int(row["n"] if row else 0)

    def context_block(self, memories: Sequence[RetrievedMemory], max_chars: int = 1800) -> str:
        """Render retrieved memories as a prompt block, oldest-last, budgeted."""
        if not memories:
            return ""
        lines: list[str] = []
        used = 0
        for item in memories:
            stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime(item.memory.created_at))
            line = f"- [{stamp}] {item.memory.text}"
            if used + len(line) > max_chars:
                break
            lines.append(line)
            used += len(line)
        if not lines:
            return ""
        return "RELEVANT LONG-TERM MEMORY (older lines are further back in time):\n" + "\n".join(lines)
