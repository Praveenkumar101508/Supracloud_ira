"""PR #66 — launcher scripts must not embed or expose secrets.

The double-click launchers (Start IRA.bat / Start IRA.command) and the real
launchers they wrap (start-ira.sh / start-ira.ps1) read configuration from the
local .env at runtime. None of them may contain a hardcoded credential, echo a
secret value, or copy .env contents anywhere.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

_REPO = Path(__file__).resolve().parents[2]   # supracloud-jarvis/

LAUNCHERS = [
    _REPO / "Start IRA.bat",
    _REPO / "Start IRA.command",
    _REPO / "start-ira.sh",
    _REPO / "start-ira.ps1",
]

# A secret-looking assignment: KEY containing PASSWORD/SECRET/TOKEN/API_KEY set
# to a non-trivial literal value (not a variable reference or empty default).
_SECRET_ASSIGNMENT = re.compile(
    r"""(?ix)
    \b[A-Z0-9_]*(PASSWORD|SECRET|TOKEN|API_KEY)[A-Z0-9_]*\s*=\s*
    ["']?(?![\s"']|\$|%|\{)[A-Za-z0-9+/=!@#\$%^&*_-]{8,}
    """
)


@pytest.mark.parametrize("path", LAUNCHERS, ids=lambda p: p.name)
def test_launcher_exists(path: Path):
    assert path.is_file(), f"{path.name} missing"


@pytest.mark.parametrize("path", LAUNCHERS, ids=lambda p: p.name)
def test_launcher_contains_no_hardcoded_secret(path: Path):
    text = path.read_text(encoding="utf-8", errors="replace")
    hits = [m.group(0) for m in _SECRET_ASSIGNMENT.finditer(text)]
    assert hits == [], f"{path.name} contains secret-looking assignments: {hits}"


@pytest.mark.parametrize("path", LAUNCHERS, ids=lambda p: p.name)
def test_launcher_never_prints_env_contents(path: Path):
    """The launchers may check that .env exists but must never dump its contents
    (cat/type/Get-Content of .env would put secrets on screen and in logs)."""
    text = path.read_text(encoding="utf-8", errors="replace").lower()
    for pattern in ("cat .env", "cat \"$root/.env\"", "type .env", "get-content .env"):
        assert pattern not in text, f"{path.name} prints .env contents ({pattern!r})"
