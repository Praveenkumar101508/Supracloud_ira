"""commands/executor.py — the ONLY module that performs command side effects.

Every function is local-first and honest: failures return {"ok": False,
"detail": ...} rather than pretending. Secret handling for the private
database is strict — the generated password goes into a chmod-600 file under
the local secrets dir and is NEVER logged, stored in Postgres, or included in
any return value (responses carry the file path, not the secret).

grant_access_request has NO executor on purpose: the API layer routes it to
the delegated-access wizard (PR #67) and records it as needs_wizard.
"""
from __future__ import annotations

import json
import logging
import os
import re
import secrets as _secrets
import uuid
from pathlib import Path

from config import get_settings

logger = logging.getLogger("ira.commands")

_SLUG_RE = re.compile(r"[^a-z0-9_]+")


def slugify(name: str) -> str:
    slug = _SLUG_RE.sub("_", (name or "").strip().lower()).strip("_")[:40]
    return slug or "project"


def _projects_dir() -> Path:
    return Path(get_settings().projects_dir)


def _secrets_dir() -> Path:
    return Path(get_settings().secrets_dir)


# ── Memory Vault integration (data, never instructions) ─────────────────────

async def _save_vault_memory(content: str, kind: str) -> bool:
    """Insert a Memory Vault entry exactly like the vault API does (embedded
    when possible, text-only otherwise). Fail-soft: memory is a bonus."""
    try:
        from utils.db import acquire
        from api.routes.memory import _embed_or_none

        vector = await _embed_or_none(content)
        async with acquire() as conn:
            await conn.execute(
                """INSERT INTO memory_embeddings
                       (source_id, source_type, content, embedding, user_id, metadata)
                   VALUES ($1, $2, $3, $4::vector, $5, '{}'::jsonb)""",
                uuid.uuid4(), kind, content, vector, "owner",
            )
        return True
    except Exception as e:  # noqa: BLE001
        logger.warning("command memory write failed (non-fatal): %s", e)
        return False


# ── Executors ────────────────────────────────────────────────────────────────

async def create_project(name: str | None) -> dict:
    if not name:
        return {"ok": False, "needs": "name",
                "detail": "What should the project be called? Say e.g. "
                          "\"create a project called Aurora\"."}
    slug = slugify(name)
    folder = _projects_dir() / slug
    folder.mkdir(parents=True, exist_ok=True)
    notes = folder / "notes.md"
    if not notes.exists():
        notes.write_text(f"# {name}\n\nProject notes.\n", encoding="utf-8")
    try:
        from utils.db import acquire
        async with acquire() as conn:
            await conn.execute(
                """INSERT INTO projects (id, name, slug, notes_path)
                   VALUES ($1, $2, $3, $4)
                   ON CONFLICT (slug) DO UPDATE SET updated_at = NOW()""",
                uuid.uuid4(), name, slug, str(notes),
            )
    except Exception as e:  # folder still exists; record honestly
        logger.warning("project record write failed: %s", e)
        return {"ok": False, "detail": f"Folder created at {folder}, but the project "
                                       f"record could not be saved (database error)."}
    await _save_vault_memory(f"Project created: {name} (folder: {folder})", "projects")
    return {"ok": True, "project": {"name": name, "slug": slug, "folder": str(folder)},
            "detail": f"Project {name!r} is ready: local record, folder and notes.md."}


async def create_project_folder(project: str | None) -> dict:
    if not project:
        return {"ok": False, "needs": "project",
                "detail": "Which project? Say e.g. \"create a notes folder for project Aurora\"."}
    slug = slugify(project)
    folder = _projects_dir() / slug
    folder.mkdir(parents=True, exist_ok=True)
    notes = folder / "notes.md"
    if not notes.exists():
        notes.write_text(f"# {project}\n\nProject notes.\n", encoding="utf-8")
    return {"ok": True, "folder": str(folder),
            "detail": f"Folder ready at {folder} with notes.md."}


async def create_private_database(project: str | None) -> dict:
    """Local-only Postgres database + project user. The password exists in
    exactly one place afterwards: a chmod-600 env file in the secrets dir."""
    if not project:
        return {"ok": False, "needs": "project",
                "detail": "Which project is this database for? Say e.g. "
                          "\"create a private database for project Aurora\"."}
    slug = slugify(project)
    db_name = f"ira_proj_{slug}"[:60]
    db_user = f"ira_proj_{slug}_u"[:60]
    password = _secrets.token_urlsafe(24)   # never logged, never returned

    try:
        from utils.db import acquire
        async with acquire() as conn:
            exists = await conn.fetchrow("SELECT 1 FROM pg_database WHERE datname = $1", db_name)
            if exists:
                return {"ok": False, "detail": f"Database {db_name!r} already exists — "
                                               "nothing was changed."}
            user_exists = await conn.fetchrow("SELECT 1 FROM pg_roles WHERE rolname = $1", db_user)
            # Identifiers can't be bind parameters; both are slug-derived
            # ([a-z0-9_] only) so interpolation is safe here.
            if not user_exists:
                await conn.execute(
                    f"CREATE USER {db_user} WITH PASSWORD '{password}' NOSUPERUSER NOCREATEDB NOCREATEROLE"
                )
            await conn.execute(f'CREATE DATABASE {db_name} OWNER {db_user}')
    except Exception as e:  # noqa: BLE001 — permissions / connection problems
        logger.warning("private database creation failed: %s", type(e).__name__)
        return {"ok": False,
                "detail": "Could not create the database — the configured Postgres user "
                          "may lack CREATEDB/CREATEROLE rights. Nothing was changed. "
                          "(Grant them with: ALTER USER <ira_db_user> CREATEDB CREATEROLE.)"}

    sdir = _secrets_dir()
    sdir.mkdir(parents=True, exist_ok=True)
    cfg = get_settings()
    env_path = sdir / f"{slug}.env"
    env_path.write_text(
        f"# Private database for project {project!r} — local only, never commit.\n"
        f"DATABASE_URL=postgresql://{db_user}:{password}@{cfg.postgres_host}:{cfg.postgres_port}/{db_name}\n",
        encoding="utf-8",
    )
    os.chmod(env_path, 0o600)

    await _save_vault_memory(
        f"Private local database created for project {project}: db={db_name}, "
        f"user={db_user}, credentials in {env_path} (local file, not committed).",
        "projects",
    )
    try:
        from utils.db import acquire
        async with acquire() as conn:
            await conn.execute(
                """INSERT INTO projects (id, name, slug, db_name)
                   VALUES ($1, $2, $3, $4)
                   ON CONFLICT (slug) DO UPDATE SET db_name = EXCLUDED.db_name, updated_at = NOW()""",
                uuid.uuid4(), project, slug, db_name,
            )
    except Exception:
        pass  # metadata only; the database itself is already created

    return {"ok": True,
            "database": {"name": db_name, "user": db_user, "credentials_file": str(env_path)},
            "detail": f"Private local database {db_name!r} is ready. Credentials are in "
                      f"{env_path} (owner-only file permissions) and were not logged or committed."}


async def save_memory(content: str | None) -> dict:
    content = (content or "").strip()
    if not content:
        return {"ok": False, "needs": "content", "detail": "What should I remember?"}
    ok = await _save_vault_memory(content, "note")
    if not ok:
        return {"ok": False, "detail": "Could not save the memory (database unavailable)."}
    return {"ok": True, "detail": "Saved to the Memory Vault as your data."}


async def open_panel(panel: str | None) -> dict:
    return {"ok": True, "panel": panel or "dashboard",
            "detail": f"Opening the {panel or 'dashboard'} panel."}


async def create_backup() -> dict:
    try:
        from worker.backup import run_database_backup
        path = await run_database_backup()
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "detail": f"Backup failed: {e}"}
    if path is None:
        return {"ok": False, "detail": "Backup did not produce a file — check the backup log."}
    return {"ok": True, "backup_file": str(path), "detail": f"Backup written to {path}."}


async def check_system_status() -> dict:
    """Live local probes; each pillar reports honestly and independently."""
    out: dict = {}
    try:
        from utils.db import acquire
        async with acquire() as conn:
            await conn.fetchrow("SELECT 1")
        out["database"] = "ok"
    except Exception:
        out["database"] = "down"
    try:
        from utils.redis_client import get_redis
        await get_redis().ping()
        out["redis"] = "ok"
    except Exception:
        out["redis"] = "down"
    try:
        import httpx
        cfg = get_settings()
        base = cfg.ollama_base_url.removesuffix("/v1")
        async with httpx.AsyncClient(timeout=3) as client:
            r = await client.get(f"{base}/api/tags")
        out["ollama"] = "ok" if r.status_code == 200 else f"http {r.status_code}"
    except Exception:
        out["ollama"] = "down"
    ok = all(v == "ok" for v in out.values())
    return {"ok": ok, "services": out,
            "detail": "All core services are up." if ok
                      else "Some services are down: " +
                           ", ".join(k for k, v in out.items() if v != "ok")}


async def update_project_config(project: str | None, note: str | None) -> dict:
    if not project:
        return {"ok": False, "needs": "project", "detail": "Which project's config?"}
    slug = slugify(project)
    folder = _projects_dir() / slug
    folder.mkdir(parents=True, exist_ok=True)
    cfg_file = folder / "config.md"
    with cfg_file.open("a", encoding="utf-8") as fh:
        fh.write(f"- {json.dumps((note or '').strip())[1:-1]}\n")
    return {"ok": True, "config_file": str(cfg_file),
            "detail": f"Noted in {cfg_file}."}


__all__ = [
    "slugify", "create_project", "create_project_folder", "create_private_database",
    "save_memory", "open_panel", "create_backup", "check_system_status",
    "update_project_config",
]
