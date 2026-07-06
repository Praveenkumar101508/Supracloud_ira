-- 016_command_center.sql — Command Center (PR #68): projects + command runs.
--
-- projects: local project workspaces created by natural commands ("create a
-- new project called X"). db_name is set when a private database was created
-- for the project; credentials NEVER live in this table (chmod-600 local file).
--
-- command_runs: every command the owner issued — the plan, the risk verdict,
-- and what actually happened. Statuses are honest: a run that never executed
-- says so ("awaiting_confirmation" / "needs_wizard" / "clarification" /
-- "blocked" / "failed"), never a fake success.

CREATE TABLE IF NOT EXISTS projects (
    id         UUID PRIMARY KEY,
    name       TEXT NOT NULL,
    slug       TEXT NOT NULL UNIQUE,
    notes_path TEXT NOT NULL DEFAULT '',
    db_name    TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS command_runs (
    id          UUID PRIMARY KEY,
    actor       TEXT NOT NULL DEFAULT 'owner',
    raw_text    TEXT NOT NULL,
    intent      TEXT NOT NULL,
    params      JSONB NOT NULL DEFAULT '{}'::jsonb,
    plan        JSONB NOT NULL DEFAULT '{}'::jsonb,
    risk        TEXT NOT NULL DEFAULT 'high',
    status      TEXT NOT NULL,
    result      JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    executed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_command_runs_created ON command_runs (created_at DESC);
