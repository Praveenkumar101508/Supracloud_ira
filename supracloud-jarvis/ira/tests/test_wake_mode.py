"""PR #66 — Wake Mode v1: visible, local-only, OFF by default.

Covers the status/toggle API surface and the safety properties the UI promises:
wake mode starts OFF, its state is visible (off/listening/awake/processing),
toggling it can never change privacy/external-API settings, and a full wake
cycle keeps raw audio in memory — nothing is ever written to disk.
"""
from __future__ import annotations

import os
import types
from unittest.mock import AsyncMock

import owner_profile
from voice import wakeword
from voice.wakeword import WakeWordListener

SILENCE = b"\x00" * 2560
TRIGGER = b"\x11" * 2560


class _FakeSource:
    def __init__(self, frames):
        self._frames = list(frames)
        self.closed = False

    def read(self):
        return self._frames.pop(0) if self._frames else None

    def close(self):
        self.closed = True


class _FakeDetector:
    def score(self, frame):
        return 0.9 if frame == TRIGGER else 0.0


class _FakeBrain:
    def __init__(self):
        self.perceived = []

    async def perceive(self, source, text):
        self.perceived.append((source, text))


def _app():
    return types.SimpleNamespace(state=types.SimpleNamespace(brain=_FakeBrain()))


# ── Default-off + visible state ──────────────────────────────────────────────

def test_wake_mode_is_off_by_default(monkeypatch):
    monkeypatch.delenv("IRA_WAKEWORD_ENABLED", raising=False)
    app = types.SimpleNamespace(state=types.SimpleNamespace())
    payload = wakeword.status(app)
    assert payload["enabled"] is False
    assert payload["enabled_at_boot"] is False
    assert payload["state"] == "off"
    assert payload["local_only"] is True


async def test_listener_states_are_visible_through_a_wake_cycle():
    """The UI's mic chip is driven by listener.state: listening while scanning,
    awake during owner verification, processing while transcribing."""
    app = _app()
    src = _FakeSource([SILENCE, TRIGGER, SILENCE, SILENCE])
    seen: dict[str, str] = {}
    listener = WakeWordListener(
        app, detector=_FakeDetector(), audio_source=src,
        threshold=0.5, cooldown=2.0, verify_frames=1, command_frames=1,
    )

    async def spy_gate(pcm, *, session_id):
        seen["at_gate"] = listener.state
        return True

    def spy_transcribe(wav):
        seen["at_transcribe"] = listener.state
        return "hello"

    listener._gate = spy_gate
    listener._transcribe = spy_transcribe

    assert listener.state == "off"          # before start
    await listener.run()
    assert seen["at_gate"] == "awake"
    assert seen["at_transcribe"] == "processing"
    assert listener.state == "off"          # source ended → back to off
    assert app.state.brain.perceived == [("voice", "hello")]


def test_stop_resets_state_to_off():
    app = _app()
    listener = WakeWordListener(
        app, detector=_FakeDetector(), audio_source=_FakeSource([]),
        threshold=0.5, cooldown=2.0, verify_frames=1, command_frames=1,
    )
    listener.state = "listening"
    listener.running = True
    listener.stop()
    assert listener.running is False
    assert listener.state == "off"


# ── Toggle API: fail-soft and privacy-neutral ────────────────────────────────

async def test_wake_toggle_cannot_enable_external_api(monkeypatch):
    """Turning wake mode on/off must never touch privacy or external-API flags."""
    from config import get_settings
    from api.routes.voice import wake_toggle, WakeToggleBody

    monkeypatch.setattr(
        owner_profile, "get_profile",
        AsyncMock(return_value=dict(owner_profile._EMPTY)),
    )

    external_before = get_settings().ira_allow_external_api
    privacy_before = get_settings().ira_privacy_mode
    env_before = os.environ.get("IRA_ALLOW_EXTERNAL_API")

    request = types.SimpleNamespace(app=types.SimpleNamespace(state=types.SimpleNamespace()))
    payload_on = await wake_toggle(WakeToggleBody(enabled=True), request, _user="owner")
    payload_off = await wake_toggle(WakeToggleBody(enabled=False), request, _user="owner")

    assert get_settings().ira_allow_external_api == external_before
    assert get_settings().ira_privacy_mode == privacy_before
    assert os.environ.get("IRA_ALLOW_EXTERNAL_API") == env_before
    assert payload_on["local_only"] is True
    assert payload_off["enabled"] is False


async def test_wake_toggle_fails_soft_without_wakeword_stack(monkeypatch):
    """openwakeword isn't installed in CI: enabling must report honestly, not crash."""
    from api.routes.voice import wake_toggle, WakeToggleBody

    monkeypatch.setattr(
        owner_profile, "get_profile",
        AsyncMock(return_value=dict(owner_profile._EMPTY)),
    )
    request = types.SimpleNamespace(app=types.SimpleNamespace(state=types.SimpleNamespace()))
    payload = await wake_toggle(WakeToggleBody(enabled=True), request, _user="owner")
    assert payload["enabled"] is False        # could not actually start
    assert payload["available"] is False
    assert payload["reason"]                  # says why instead of pretending


async def test_wake_status_reports_configured_wake_word(monkeypatch):
    from api.routes.voice import wake_status

    monkeypatch.setattr(
        owner_profile, "get_profile",
        AsyncMock(return_value={**owner_profile._EMPTY, "wake_word": "ira"}),
    )
    request = types.SimpleNamespace(app=types.SimpleNamespace(state=types.SimpleNamespace()))
    payload = await wake_status(request, _user="owner")
    assert payload["wake_word"] == "ira"
    assert payload["state"] == "off"


# ── Raw audio is never persisted ─────────────────────────────────────────────

async def test_wake_cycle_writes_no_files(tmp_path, monkeypatch):
    """A full detect→gate→transcribe cycle must leave the filesystem untouched:
    raw audio lives only in memory (the WAV handed to STT is a bytes object)."""
    monkeypatch.chdir(tmp_path)
    app = _app()
    src = _FakeSource([TRIGGER, SILENCE, SILENCE])
    got: dict[str, object] = {}

    def transcribe(wav):
        got["wav_type"] = type(wav)
        return "hello"

    async def gate(pcm, *, session_id):
        return True

    listener = WakeWordListener(
        app, detector=_FakeDetector(), audio_source=src,
        gate=gate, transcribe=transcribe,
        threshold=0.5, cooldown=2.0, verify_frames=1, command_frames=1,
    )
    await listener.run()

    assert got["wav_type"] is bytes                    # in-memory WAV, not a path
    assert list(tmp_path.iterdir()) == []              # nothing persisted
    assert app.state.brain.perceived == [("voice", "hello")]
