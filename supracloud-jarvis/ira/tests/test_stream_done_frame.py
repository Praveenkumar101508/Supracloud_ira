"""The /chat/stream done-frame carries the routing metadata the Agent Activity
UI renders: agent, model, and how many memories were retrieved for the turn.

The UI promises to show only backend-reported facts ("Not reported yet"
otherwise), so this pins the contract: the legacy streaming path must report
`model` and `memory_count` alongside the existing `agent` / `latency_ms`.
"""
import os

for _k in ("IRA_SECRET_KEY", "IRA_ADMIN_PASSWORD", "POSTGRES_PASSWORD", "REDIS_PASSWORD", "VLLM_API_KEY"):
    os.environ.setdefault(_k, "test-placeholder")

import asyncio
import json
import sys
from unittest.mock import AsyncMock

# conftest.py stubs sentence_transformers as an EMPTY module; the import chain
# only needs the SentenceTransformer name to resolve (model loads lazily).
_st = sys.modules.get("sentence_transformers")
if _st is not None and not hasattr(_st, "SentenceTransformer"):
    _st.SentenceTransformer = object

import api.routes.chat as chatmod
from api.routes.chat import ChatRequest, chat_stream


class _Cfg:
    ira_admin_username = "owner"
    ira_voice_service_username = "ira-voice"
    dev_mode = True
    owner_name = "Praveen"


def _stub_stream_io(monkeypatch, memories: list[dict]):
    monkeypatch.setattr(chatmod, "_USE_CORTEX", False)
    monkeypatch.setattr(chatmod, "get_settings", lambda: _Cfg())
    monkeypatch.setattr(chatmod, "ensure_conversation", AsyncMock(return_value="conv1"))
    monkeypatch.setattr(chatmod, "retrieve", AsyncMock(return_value=memories))
    monkeypatch.setattr(chatmod, "get_recent_messages", AsyncMock(return_value=[]))
    monkeypatch.setattr(chatmod, "get_profile_summary", AsyncMock(return_value=""))
    monkeypatch.setattr("memory.store.save_message", AsyncMock())
    # No live classifier / search / feature handlers in tests.
    monkeypatch.setattr(
        "agents.supervisor.classify",
        AsyncMock(return_value={"active_agent": "conversational", "use_deep_model": False}),
    )
    monkeypatch.setattr("utils.search_tools.get_search_context", AsyncMock(return_value=("", {})))
    monkeypatch.setattr("api.routes._dispatch.dispatch", AsyncMock(return_value=None))

    async def _fake_tokens(messages, use_deep=False, use_reasoning=False):
        for tok in ("hello", " world"):
            yield tok

    monkeypatch.setattr(chatmod, "stream_tokens", _fake_tokens)


async def _collect_done_frame(resp) -> dict:
    """Drain the SSE generator and return the parsed done-frame payload."""
    async for item in resp.body_iterator:
        payload = item["data"] if isinstance(item, dict) else item
        data = json.loads(payload)
        if data.get("done"):
            return data
    raise AssertionError("stream ended without a done frame")


def test_done_frame_reports_model_and_memory_count(monkeypatch):
    memories = [{"content": f"m{i}"} for i in range(3)]
    _stub_stream_io(monkeypatch, memories)

    resp = asyncio.run(chat_stream(ChatRequest(message="hello there", session_id="s1"), _user="owner"))
    done = asyncio.run(_collect_done_frame(resp))

    assert done["agent"] == "conversational"
    assert done["model"] == "qwen3-fast"          # fast tier: no deep / no reasoning
    assert done["memory_count"] == 3               # exactly what retrieve() returned
    assert isinstance(done["latency_ms"], int)


def test_done_frame_memory_count_zero_when_no_memories(monkeypatch):
    _stub_stream_io(monkeypatch, [])

    resp = asyncio.run(chat_stream(ChatRequest(message="hello there", session_id="s2"), _user="owner"))
    done = asyncio.run(_collect_done_frame(resp))

    assert done["memory_count"] == 0
    assert done["model"] == "qwen3-fast"
