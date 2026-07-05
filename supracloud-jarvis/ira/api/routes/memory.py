"""
Memory Vault v1 — owner CRUD over long-term memories (/api/v1/memory).

GET    /api/v1/memory             — list recent memories (?kind= filter, ?q= substring)
POST   /api/v1/memory             — save a memory {content, kind, pinned}
PUT    /api/v1/memory/{id}        — edit content (re-embeds; fail-soft on embed error)
POST   /api/v1/memory/{id}/pin    — pin / unpin (metadata flag)
DELETE /api/v1/memory/{id}        — forget (owner-gated + confirmation-gated)

Memories are DATA, never instructions: this API stores and returns content
verbatim as opaque text. The reference-only treatment happens at the prompt
layer (memory_context + the injection guard), which has its own tests.

Kinds are free-form slugs so the owner can organise the vault however they
like (profile, projects, job_search, decisions, preferences, documents,
reminders, goals, ...).
"""

from __future__ import annotations

import logging
import re
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from api.middleware.auth import require_auth, is_owner
from utils.approval import owner_gated_action

logger = logging.getLogger("ira.memory_vault")

router = APIRouter(prefix="/memory", tags=["memory"])

_KIND_RE = re.compile(r"^[a-z0-9][a-z0-9_\-]{0,63}$")

# Vault entries are the owner's curated memories — chat-transcript embeddings
# (source_type='message') stay out of the vault listing.
_VAULT_USER = "owner"


class CreateMemoryRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=20_000)
    kind: str = Field("note", description="Category slug, e.g. profile / projects / goals")
    pinned: bool = False


class UpdateMemoryRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=20_000)


class PinRequest(BaseModel):
    pinned: bool = True


def _validate_kind(kind: str) -> str:
    kind = kind.strip().lower()
    if not _KIND_RE.match(kind):
        raise HTTPException(
            status_code=422,
            detail="kind must be a slug: lowercase letters, digits, '-' or '_' (max 64 chars)",
        )
    return kind


def _row_out(row) -> dict:
    meta = row["metadata"] or {}
    if isinstance(meta, str):
        import json
        try:
            meta = json.loads(meta)
        except ValueError:
            meta = {}
    return {
        "id": str(row["id"]),
        "content": row["content"],
        "kind": row["source_type"],
        "pinned": bool(meta.get("pinned", False)),
        "created_at": row["created_at"].isoformat() if row["created_at"] else None,
    }


async def _embed_or_none(content: str):
    """Vector string for pgvector, or None when the embedder is unavailable."""
    try:
        from memory.embeddings import embed_one
        vector = await embed_one(content)
        return "[" + ",".join(map(str, vector)) + "]"
    except Exception as e:
        logger.warning(f"Memory vault: embedding unavailable, storing text only ({e})")
        return None


@router.get("")
async def list_memories(
    kind: str | None = Query(None, description="Filter by category slug"),
    q: str | None = Query(None, description="Substring filter over content"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _user: str = Depends(require_auth),
):
    """List the owner's curated memories, newest first."""
    from utils.db import acquire

    clauses = ["user_id = $1", "source_type <> 'message'"]
    args: list = [_VAULT_USER]
    if kind:
        args.append(_validate_kind(kind))
        clauses.append(f"source_type = ${len(args)}")
    if q:
        args.append(f"%{q}%")
        clauses.append(f"content ILIKE ${len(args)}")
    args += [limit, offset]

    sql = (
        "SELECT id, content, source_type, metadata, created_at FROM memory_embeddings "
        f"WHERE {' AND '.join(clauses)} "
        f"ORDER BY created_at DESC LIMIT ${len(args)-1} OFFSET ${len(args)}"
    )
    async with acquire() as conn:
        rows = await conn.fetch(sql, *args)
    items = [_row_out(r) for r in rows]
    return {"memories": items, "count": len(items)}


@router.post("")
async def create_memory(body: CreateMemoryRequest, _user: str = Depends(require_auth)):
    """Save a memory into the vault (embedded for recall when possible)."""
    from utils.db import acquire

    kind = _validate_kind(body.kind)
    vector_str = await _embed_or_none(body.content)
    import json
    meta = json.dumps({"pinned": body.pinned}) if body.pinned else json.dumps({})

    async with acquire() as conn:
        row = await conn.fetchrow(
            """INSERT INTO memory_embeddings (source_id, source_type, content, embedding, user_id, metadata)
               VALUES ($1, $2, $3, $4::vector, $5, $6::jsonb)
               RETURNING id, content, source_type, metadata, created_at""",
            uuid.uuid4(), kind, body.content, vector_str, _VAULT_USER, meta,
        )
    return _row_out(row)


@router.put("/{memory_id}")
async def update_memory(memory_id: uuid.UUID, body: UpdateMemoryRequest, _user: str = Depends(require_auth)):
    """Edit a memory's content; re-embeds so recall matches the new text."""
    from utils.db import acquire

    vector_str = await _embed_or_none(body.content)
    async with acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE memory_embeddings
               SET content = $2, embedding = $3::vector
               WHERE id = $1 AND user_id = $4
               RETURNING id, content, source_type, metadata, created_at""",
            memory_id, body.content, vector_str, _VAULT_USER,
        )
    if row is None:
        raise HTTPException(status_code=404, detail=f"Memory {memory_id} not found.")
    return _row_out(row)


@router.post("/{memory_id}/pin")
async def pin_memory(memory_id: uuid.UUID, body: PinRequest, _user: str = Depends(require_auth)):
    """Pin or unpin a memory (a vault flag; pinned memories sort first in UIs)."""
    from utils.db import acquire

    async with acquire() as conn:
        row = await conn.fetchrow(
            """UPDATE memory_embeddings
               SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('pinned', $2::bool)
               WHERE id = $1 AND user_id = $3
               RETURNING id, content, source_type, metadata, created_at""",
            memory_id, body.pinned, _VAULT_USER,
        )
    if row is None:
        raise HTTPException(status_code=404, detail=f"Memory {memory_id} not found.")
    return _row_out(row)


@router.delete("/{memory_id}")
async def delete_memory(
    memory_id: uuid.UUID,
    confirm_token: str | None = Query(None, description="Approval token; omit to receive a draft"),
    _user: str = Depends(require_auth),
):
    """Forget a memory — owner-gated + confirmation-gated (destructive)."""
    from utils.db import acquire

    async with acquire() as conn:
        row = await conn.fetchrow(
            "SELECT content FROM memory_embeddings WHERE id = $1 AND user_id = $2",
            memory_id, _VAULT_USER,
        )
    if row is None:
        raise HTTPException(status_code=404, detail=f"Memory {memory_id} not found.")
    snippet = (row["content"] or "")[:80]

    async def _do():
        async with acquire() as conn:
            await conn.execute(
                "DELETE FROM memory_embeddings WHERE id = $1 AND user_id = $2",
                memory_id, _VAULT_USER,
            )
        return {"deleted": str(memory_id)}

    outcome = await owner_gated_action(
        owner_username=_user, is_owner=is_owner(_user),
        action="forget_memory",
        preview=f"Forget memory {memory_id} ({snippet!r}...) — cannot be undone",
        execute=_do, confirm_token=confirm_token,
    )
    if outcome["status"] == "forbidden":
        raise HTTPException(status_code=403, detail=outcome["detail"])
    if outcome["status"] in ("expired", "not_found"):
        raise HTTPException(status_code=409, detail=outcome["detail"])
    if outcome["status"] == "executed":
        return outcome["result"]
    return outcome  # confirmation_required
