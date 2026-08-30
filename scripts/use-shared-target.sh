#!/usr/bin/env bash
# Point this worktree's build directories at the machine-wide cargo cache.
#
# Every agent worktree starts with an empty target/ and pays a full cold
# compile of the ~370 dependencies. Dependency artifacts do not depend on the
# worktree path, so one cache serves all of them. Measured in a fresh worktree:
# `cargo check -p dj-engine --release` 1:06 -> 0:05, `cargo build --workspace
# --release` 16:00 -> 0:34, and the worktree keeps no build output of its own.
#
# Symlinks rather than CARGO_TARGET_DIR, so the hardcoded ./target/… paths in
# run.sh, the extension scripts and the CI recipe keep working. One cache per
# workspace in the checkout, because they are three separate dependency sets.
#
# Usage:
#   scripts/use-shared-target.sh          # link this worktree
#   scripts/use-shared-target.sh --all    # link every worktree that has none yet
#
# Caveats, all consequences of one shared directory:
#   * cargo takes an exclusive lock on it, so two concurrent BUILDS serialize
#     (seconds each — only the workspace crates rebuild). Test EXECUTION does
#     not: cargo drops the lock before it runs the binaries.
#   * workspace-crate artifacts are keyed by crate name, not by worktree, so a
#     concurrent worker's build replaces yours and your next build redoes it.
#     The dependencies — the expensive part — are shared, not fought over.
#   * `./target/release/dj-cli` is whoever built last. Rebuild it right before
#     you run it, or opt out: `rm target && mkdir target`.
set -euo pipefail

SHARED=${DJ_SHARED_TARGET_DIR:-/var/cache/dj-cargo-target}

# <workspace root, relative to the checkout>:<cache subdirectory>
WORKSPACES=(
    ".:workspace"
    "app/src-tauri:tauri"
    "extensions:extensions"
)

link_one() {
    local dir=$1 cache=$2
    [ -d "$dir" ] || return 0
    local target="$dir/target"
    if [ -L "$target" ]; then
        echo "already linked: $target -> $(readlink "$target")"
        return 0
    fi
    if [ -e "$target" ]; then
        echo "skip (real target/ with build output): $target"
        return 0
    fi
    mkdir -p "$SHARED/$cache"
    ln -s "$SHARED/$cache" "$target"
    echo "linked: $target -> $SHARED/$cache"
}

link_repo() {
    local repo=$1 entry
    for entry in "${WORKSPACES[@]}"; do
        link_one "$repo/${entry%%:*}" "${entry##*:}"
    done
}

if [ "${1:-}" = "--all" ]; then
    root=${WORKTREE_ROOT:-/tmp/conversation-worktrees}
    for wt in "$root"/*/dj-station; do
        [ -d "$wt" ] && link_repo "$wt"
    done
else
    link_repo "$(git rev-parse --show-toplevel)"
fi
