-- 015_relationships_access.sql — relationship memory + delegated access (PR #67).
--
-- people: the owner's relationship memories ("Rahul is my friend"). Stored as
-- DATA, never instructions; saved only after explicit owner confirmation, and
-- access_level defaults to no_access — remembering a person NEVER grants access.
--
-- delegated_users: separate accounts created through the secure access wizard.
-- Each person gets their OWN bcrypt password hash. The primary owner is the
-- .env admin account and is never stored here; a partial unique index keeps
-- is_primary_owner impossible to duplicate should it ever be used.
--
-- access_audit_log: every access change (grant/revoke/role change, and denied
-- attempts) is recorded for the owner to review.

CREATE TABLE IF NOT EXISTS people (
    id                 UUID PRIMARY KEY,
    person_name        TEXT NOT NULL,
    relationship       TEXT NOT NULL,
    added_by           TEXT NOT NULL DEFAULT 'owner',
    confirmed_by_owner BOOLEAN NOT NULL DEFAULT FALSE,
    access_level       TEXT NOT NULL DEFAULT 'no_access',
    notes              TEXT NOT NULL DEFAULT '',
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_people_name ON people (LOWER(person_name));

CREATE TABLE IF NOT EXISTS delegated_users (
    id               UUID PRIMARY KEY,
    username         TEXT NOT NULL UNIQUE,
    password_hash    TEXT NOT NULL,
    role             TEXT NOT NULL DEFAULT 'trusted_user',
    person_id        UUID REFERENCES people(id) ON DELETE SET NULL,
    is_primary_owner BOOLEAN NOT NULL DEFAULT FALSE,
    active           BOOLEAN NOT NULL DEFAULT TRUE,
    voice_enrolled   BOOLEAN NOT NULL DEFAULT FALSE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- At most one primary-owner row can ever exist (the app never creates one:
-- the primary owner is the .env admin account, protected in code as well).
CREATE UNIQUE INDEX IF NOT EXISTS idx_delegated_users_primary
    ON delegated_users (is_primary_owner) WHERE is_primary_owner;

CREATE TABLE IF NOT EXISTS access_audit_log (
    id         BIGSERIAL PRIMARY KEY,
    actor      TEXT NOT NULL,
    action     TEXT NOT NULL,
    target     TEXT NOT NULL DEFAULT '',
    details    JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_access_audit_created ON access_audit_log (created_at DESC);
