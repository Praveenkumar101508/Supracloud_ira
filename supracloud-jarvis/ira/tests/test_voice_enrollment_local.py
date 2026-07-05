"""Voice enrollment stores ONLY the voiceprint embedding, locally.

Personal v1 requirement: raw enrolment audio must never be persisted — the
/voice/enroll route processes uploads in-memory, computes ECAPA embeddings and
saves just those to the local database. These tests pin:

  - a successful enrolment passes EMBEDDINGS (not audio bytes) to the profile store
  - the raw WAV payload is never handed to the persistence layer
  - enrolment is admin-only and consumes the anti-replay challenge
  - malformed (non-WAV) uploads are rejected before any processing
"""
import io
import os
import sys
import types
import wave

for _k in ("IRA_SECRET_KEY", "IRA_ADMIN_PASSWORD", "POSTGRES_PASSWORD", "REDIS_PASSWORD", "VLLM_API_KEY"):
    os.environ.setdefault(_k, "test-placeholder")

import pytest

pytest.importorskip("fastapi")
pytest.importorskip("multipart")


FAKE_EMBEDDING = [0.25] * 8


def _wav_bytes(seconds: float = 0.2) -> bytes:
    """A tiny valid 16kHz mono 16-bit PCM WAV."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(16000)
        wf.writeframes(b"\x01\x00" * int(16000 * seconds))
    return buf.getvalue()


def _build(monkeypatch, *, username="admin"):
    """Voice-router app with stubbed auth, challenge and biometrics."""
    fake_auth = types.ModuleType("api.middleware.auth")
    fake_auth.require_auth = lambda: username
    fake_auth.is_owner = lambda _u=None: True
    monkeypatch.setitem(sys.modules, "api.middleware.auth", fake_auth)
    monkeypatch.delitem(sys.modules, "api.routes.voice", raising=False)

    saved = {}

    fake_bio = types.ModuleType("voice.biometrics")

    async def compute_embedding(audio_bytes):
        assert isinstance(audio_bytes, (bytes, bytearray))
        return list(FAKE_EMBEDDING)

    async def save_owner_profile(embeddings):
        saved["embeddings"] = embeddings
        return True

    fake_bio.compute_embedding = compute_embedding
    fake_bio.save_owner_profile = save_owner_profile
    fake_bio.invalidate_profile_cache = lambda: saved.setdefault("cache_invalidated", True)
    monkeypatch.setitem(sys.modules, "voice.biometrics", fake_bio)

    import api.routes.voice as voice_route

    consumed = {}

    async def fake_consume(challenge_id):
        consumed["id"] = challenge_id

    monkeypatch.setattr(voice_route, "_consume_challenge", fake_consume)

    from fastapi import FastAPI
    app = FastAPI()
    app.include_router(voice_route.router, prefix="/api/v1")

    from fastapi.testclient import TestClient
    return TestClient(app), saved, consumed


def _enroll(client, files=3):
    wav = _wav_bytes()
    return client.post(
        "/api/v1/voice/enroll",
        files=[("audio_files", (f"seg{i}.wav", wav, "audio/wav")) for i in range(files)],
        data={"challenge_id": "challenge-1"},
    )


def test_enrollment_persists_embeddings_not_raw_audio(monkeypatch):
    client, saved, consumed = _build(monkeypatch)
    r = _enroll(client)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "enrolled"

    # Only embeddings reached the persistence layer — never audio bytes.
    assert saved["embeddings"] == [FAKE_EMBEDDING] * 3
    for e in saved["embeddings"]:
        assert not isinstance(e, (bytes, bytearray))
    assert saved.get("cache_invalidated") is True
    # Anti-replay: the one-time challenge was consumed.
    assert consumed["id"] == "challenge-1"


def test_enrollment_rejects_non_admin(monkeypatch):
    client, saved, _ = _build(monkeypatch, username="somebody-else")
    r = _enroll(client)
    assert r.status_code == 403
    assert "embeddings" not in saved            # nothing was stored


def test_enrollment_requires_three_segments(monkeypatch):
    client, saved, _ = _build(monkeypatch)
    r = _enroll(client, files=2)
    assert r.status_code == 400
    assert "embeddings" not in saved


def test_enrollment_rejects_non_wav_upload(monkeypatch):
    client, saved, _ = _build(monkeypatch)
    r = client.post(
        "/api/v1/voice/enroll",
        files=[("audio_files", (f"seg{i}.mp3", b"not-a-wav-file", "audio/mpeg")) for i in range(3)],
        data={"challenge_id": "challenge-1"},
    )
    assert r.status_code == 400
    assert "embeddings" not in saved
