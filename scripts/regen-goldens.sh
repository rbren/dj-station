#!/usr/bin/env bash
# Intentionally regenerate the E2E audio regression goldens (and the
# serialized patch directories they render). Run after an engine or module
# change that legitimately alters rendered audio, then review the diff:
#
#   ./scripts/regen-goldens.sh
#   git diff crates/dj-engine/tests/e2e
#
set -u
cd "$(dirname "$0")/.."
REGEN_GOLDENS=1 cargo test -p dj-engine --test e2e_suite -- --test-threads=1 || exit 1
echo
echo "Goldens regenerated. Review with: git status crates/dj-engine/tests/e2e"
