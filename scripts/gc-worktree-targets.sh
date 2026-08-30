#!/usr/bin/env bash
# Delete stale cargo target/ directories under the agent worktree root.
#
# A finished ticket leaves a multi-GB target/ behind and nothing ever collects
# it (60 worktrees held 133 GB when this was written). Only build output is
# removed — never a source tree, never git metadata.
#
# A target/ is kept when any of these hold:
#   * a live process is sitting in that worktree (cwd under it),
#   * anything under target/ was touched less than AGE_HOURS ago,
#   * its worktree id is listed in KEEP.
#
# Usage:
#   scripts/gc-worktree-targets.sh              # dry run, prints what it would free
#   scripts/gc-worktree-targets.sh --apply      # actually delete
#   AGE_HOURS=48 scripts/gc-worktree-targets.sh --apply
#   KEEP="id-a id-b" scripts/gc-worktree-targets.sh --apply
set -euo pipefail

ROOT=${WORKTREE_ROOT:-/tmp/conversation-worktrees}
AGE_HOURS=${AGE_HOURS:-24}
KEEP=${KEEP:-}
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

[ -d "$ROOT" ] || { echo "no worktree root at $ROOT"; exit 0; }

worktree_id() {  # /tmp/conversation-worktrees/<id>/dj-station/… -> <id>
    local rest=${1#"$ROOT"/}
    printf '%s' "${rest%%/*}"
}

# Worktrees a process is currently sitting in.
live=$(for p in /proc/[0-9]*; do readlink "$p/cwd" 2>/dev/null; done \
    | grep "^$ROOT/" | while IFS= read -r cwd; do worktree_id "$cwd"; echo; done \
    | sort -u || true)

freed=0
kept=0
while IFS= read -r target; do
    id=$(worktree_id "$target")
    reason=""
    case " $KEEP " in *" $id "*) reason="listed in KEEP";; esac
    case " $live " in *" $id "*) reason="${reason:-worktree in use}";; esac
    # -mmin on the tree itself: a build in flight touches files deep inside.
    if [ -z "$reason" ] && [ -n "$(find "$target" -mmin "-$((AGE_HOURS * 60))" -print -quit 2>/dev/null)" ]; then
        reason="touched in the last ${AGE_HOURS}h"
    fi

    size=$(du -sm "$target" 2>/dev/null | cut -f1)
    size=${size:-0}
    if [ -n "$reason" ]; then
        kept=$((kept + size))
        echo "keep   ${size}M  $target  ($reason)"
        continue
    fi

    freed=$((freed + size))
    if [ "$APPLY" = 1 ]; then
        echo "delete ${size}M  $target"
        rm -rf -- "$target"
    else
        echo "would  ${size}M  $target"
    fi
done < <(find "$ROOT" -maxdepth 5 -type d -name target -not -path '*/target/*' 2>/dev/null | sort)

verb=$([ "$APPLY" = 1 ] && echo freed || echo reclaimable)
echo "--- $verb: ${freed}M, kept: ${kept}M (threshold ${AGE_HOURS}h)"
