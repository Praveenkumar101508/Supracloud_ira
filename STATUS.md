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
| Memory Vault API (`/api/v1/memory`) | Beta | owner CRUD; forget is confirmation-gated. UI: Planned |
| Voice input (STT) | Beta | faster-whisper local transcription (`POST /api/v1/voice/transcribe`) |
| Voice output (TTS) | Beta | Supertonic on-device engine, fails soft to 503 when not installed (`POST /api/v1/voice/say`) |
| Owner login | Stable | JWT + refresh tokens, account lockout, optional TOTP, canary tripwires |
| Owner voice enrollment / verification | Beta | `/api/v1/voice/enroll` + challenge phrases; optional, never blocks password login |
| Basic UI (chat + orb) | Stable | Next.js app, browser voice loop, resonance gate |
| Agent activity display | Beta | agents list/detail API + routing decision returned per chat turn |
| Safe action approval | Stable | every destructive/outbound action (email send, calendar create/delete, note delete) is approval-gated |
| One-command startup | Stable | `start-ira.ps1` (Windows native), `start-ira.sh` / `stop-ira.sh` (Linux/macOS/WSL) |
| Trust Console API (`/api/v1/trust/status`) | Beta | privacy mode, model/DB locality, voice enrollment, pending approvals. UI: Planned |

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
- Wake-word always-on listener
- Computer use / architect self-modification (owner-gated, protected paths)

## Planned (next PR — Personal v1 UI panels)

- Trust Console UI panel
- Memory Vault UI (Use / Edit / Forget / Pin buttons)
- Agent Activity view
- Voice Setup screen
- Daily-use dashboard

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
