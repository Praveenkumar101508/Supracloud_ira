#!/bin/bash
# SessionStart hook — pins git commit identity and enables the tracked hooks.
#
# Remote (web) session containers boot with a tool identity as the git author;
# this resets it to the repository's canonical identity (see .mailmap) so every
# commit satisfies the identity rules in CLAUDE.md, and points core.hooksPath at
# the tracked .githooks/ guard since .git/hooks does not survive a fresh clone.

set -euo pipefail

cd "$CLAUDE_PROJECT_DIR"

git config core.hooksPath .githooks

if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
    git config user.name "Praveen Kamineti"
    git config user.email "praveenkamineti2415@gmail.com"
fi
