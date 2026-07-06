-- 014_owner_onboarding.sql — first-run onboarding + owner/admin identity fields.
--
-- Extends the singleton owner_profile row (009) with the fields the first-run
-- setup wizard writes: how IRA should address the owner (preferred_title), the
-- fixed owner role, whether onboarding has been completed, the configured wake
-- word, and whether voice features were enabled during setup.
--
-- role is informational and fixed to 'owner_admin' — IRA is single-owner and the
-- application never allows changing it. Destructive/outbound actions stay
-- confirmation-gated regardless of role.

ALTER TABLE owner_profile
    ADD COLUMN IF NOT EXISTS preferred_title     TEXT        NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS role                TEXT        NOT NULL DEFAULT 'owner_admin',
    ADD COLUMN IF NOT EXISTS first_run_completed BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS wake_word           TEXT        NOT NULL DEFAULT 'ira',
    ADD COLUMN IF NOT EXISTS voice_enabled       BOOLEAN     NOT NULL DEFAULT FALSE,
    ADD COLUMN IF NOT EXISTS created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW();
