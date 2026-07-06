# IRA Personal v1 Status

IRA Personal v1 is focused on making IRA fully usable by the owner before public
release, monetisation, portable SSD mode, or advanced self-destruct security.

Application code lives in `supracloud-jarvis/` (backend: `ira/`, frontend: `frontend/`).
Statuses below reflect what the code and test suite actually cover today — not intent.

## Legend

- **Stable** — implemented, covered by tests, used on the daily driver.
- **Beta** — implemented and tested, but needs more real-world use before trusting fully.
- **Experimental** — implemented behind a flag that defaults to OFF; use at your own risk.
- **Planned** — not built yet (or deliberately deferred). Do not rely on it.

## Must Work (Personal v1 core)

| Feature | Status | Notes |
| ------- | ------ | ----- |
| Local chat (Ollama backend) | Stable | `LLM_BACKEND=ollama`, qwen3:8b fast / qwen3:14b deep tiers |
| Local model routing | Stable | model profiles + availability fallback (`ira/reasoning`), `IRA_USE_MODEL_ROUTER=true` |
| Memory save and recall (RAG) | Stable | pgvector embeddings + reranker; retrieve wired into chat |
| Memory Vault API (`/api/v1/memory`) | Beta | owner CRUD; forget is confirmation-gated |
| Memory Vault UI | Beta | list/save/edit/pin; forget goes through the backend confirmation-token flow |
| Voice input (STT) | Beta | faster-whisper local transcription (`POST /api/v1/voice/transcribe`) |
| Voice output (TTS) | Beta | Supertonic on-device engine, fails soft to 503 when not installed (`POST /api/v1/voice/say`) |
| Owner login | Stable | JWT + refresh tokens, account lockout, optional TOTP, canary tripwires |
| Owner voice enrollment / verification | Beta | `/api/v1/voice/enroll` + challenge phrases; optional, never blocks password login |
| Basic UI (chat + orb) | Stable | Next.js app, browser voice loop, resonance gate |
| Agent activity display | Beta | right-rail panel + "Last run" readout (agent, model, memories used, approval) from the stream done-frame; unreported fields show "Not reported yet" |
| Safe action approval | Stable | every destructive/outbound action (email send, calendar create/delete, note delete) is approval-gated |
| One-command startup | Stable | `start-ira.ps1` (Windows native), `start-ira.sh` / `stop-ira.sh` (Linux/macOS/WSL) |
| Trust Console API (`/api/v1/trust/status`) | Beta | privacy mode, model/DB locality, voice enrollment, pending approvals |
| Trust Console UI | Beta | renders the trust API verbatim; green safe-state only when the backend reports `local_only` |
| Voice Setup UI | Beta | status + guided in-browser enrolment (16 kHz WAV, one-time challenge); raw audio never stored |
| Daily dashboard | Beta | readiness from `/health` + trust probe, quick actions to all panels; "Welcome back" greeting from the owner profile + Owner Admin badge |
| First-run onboarding | Beta | phone-style wizard on first login (`/api/v1/onboarding/*`); owner name / preferred title / wake word, real system + privacy checks; the flag flips only when setup completes |
| Owner profile (identity fields) | Beta | preferred title, wake word, voice flag, fixed `owner_admin` role (never writable); preferred address injected into every chat turn |
| Owner Profile UI | Beta | edit name/title/wake word/voice flag; "run setup again" re-arms the wizard |
| Wake Mode v1 | Beta | OFF by default; owner toggle in Voice Setup with always-visible mic state (off/listening/awake/processing); local-only — cannot touch privacy/external-API settings; raw audio in memory only |
| One-click launchers | Beta | `Start IRA.bat` (Windows) / `Start IRA.command` (macOS) wrap the start scripts, open the dashboard, print "IRA is ready, boss." — Beta until exercised on real desktop hardware |
| Relationship memory | Beta | "Rahul is my friend" → confirm-before-save → `people` table; stored as labelled reference data, injected read-only into chat; always `no_access` by default |
| Delegated access | Beta | wizard-only grants: owner password (no DEV_MODE bypass) + confirmation token + audit log; each person gets separate credentials; voice-originated requests refused |
| Multi-user security | Beta | delegated logins are default-denied by the scope middleware except chat / basic voice / (family_admin+) trust read; roles: viewer, trusted_user, family_admin, owner_equivalent |
| Primary owner protection | Stable | the `.env` admin account can never be granted, revoked, demoted or duplicated — enforced in code, SQL (partial unique index + WHERE guards) and tests |
| Access audit log | Beta | every grant/revoke/role change and denied attempt in `access_audit_log` (`GET /api/v1/access/audit`) |
| Command Center | Beta | `POST /api/v1/command` parses natural commands into an intent + visible plan; owner-only; honest run history in `command_runs` |
| Natural command execution | Beta | 10 intents; low-risk auto-executes, medium needs plan approval, high needs owner password, unknown asks for clarification |
| Risk engine | Beta | low/medium/high/critical; access grants, deletes, outbound, security/role changes can never auto-execute; critical intents blocked |
| Private DB creation | Beta | local-only Postgres DB + project user; strong password written to a chmod-600 secrets file, never logged or committed |
| Automatic memory creation | Beta | successful commands (project/db created) save labelled reference data to the Memory Vault |

## Beta

- Deep research (multi-step, self-hosted SearXNG + Crawl4AI; fails soft when backends are down; injection-hardened with adversarial tests)
- Email triage / send-with-approval (SMTP/IMAP, local-first)
- CalDAV calendar actions (create/delete gated behind approval)
- Notes (local-first markdown, delete gated)
- Mobile PWA (Tailscale Serve HTTPS path)
- Multilingual voice (Indic TTS via indic-parler; whisper large-v3 for spoken Indic languages)
- Strategy mode (bounded deliberation)
- Realtime brain loop (`/ws/brain`) — OFF by default

## Experimental (flag-gated, OFF by default)

- Cortex engine routing (`IRA_USE_CORTEX`) — subprocess bridge via `cortex -z`
- Android actuator (droidclaw-derived, localhost-only pairing, rate-limited)
- Coding agent (Aider, owner-gated, branch-only)
- Wake-word always-on listener at boot (`IRA_WAKEWORD_ENABLED`) — the owner-facing runtime toggle is Wake Mode v1 (Beta, above)
- Computer use / architect self-modification (owner-gated, protected paths)

## Later (deliberately NOT in Personal v1)

- Portable SSD mode (guard-railed `IRA_MODE=portable_demo` exists; full portable is deferred)
- Self-destruct / emergency lockdown
- Face liveness / advanced voice biometrics (v2 voice)
- Public launch
- Paid product

## Known gaps / honesty notes

- The legacy `scripts/setup.sh` and `scripts/dev-start.sh` target the retired
  docker-compose path and require NVIDIA/docker; the supported startup is the
  native path (`start-ira.ps1` / `start-ira.sh`).
- Voice biometric verification is an additive factor only — password login always
  works, so you cannot lock yourself out via voice.
- External APIs are disabled by default (`IRA_ALLOW_EXTERNAL_API=false`,
  `WEB_SEARCH_ENABLED=false`); enabling them is an explicit opt-in in `.env`.
- The frontend has no unit-test framework; its gate is the strict TypeScript
  build (`next build`). Backend behaviour the panels rely on (trust status,
  memory-forget gating, the stream done-frame contract) is covered by the
  Python suite.
