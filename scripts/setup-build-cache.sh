#!/usr/bin/env bash
# One-time machine setup for the two build accelerations this repo expects:
#
#   1. mold, reachable as `ld` under /usr/local/lib/dj-linker — the directory
#      .cargo/config.toml hands to cc with `-B`. Without it every build simply
#      uses the default linker.
#   2. the shared cargo build directory that scripts/use-shared-target.sh links
#      worktrees at, plus a cron job that reclaims build output from worktrees
#      nobody has touched for half a day.
#
# Safe to re-run. Needs root for /usr/local and /etc/cron.d.
set -euo pipefail

LINKER_DIR=/usr/local/lib/dj-linker
SHARED=${DJ_SHARED_TARGET_DIR:-/var/cache/dj-cargo-target}
repo=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

if ! command -v mold >/dev/null 2>&1; then
    echo "installing mold"
    apt-get install -y mold
fi

mkdir -p "$LINKER_DIR"
ln -sf "$(command -v mold)" "$LINKER_DIR/ld"
echo "linker: $LINKER_DIR/ld -> $(readlink "$LINKER_DIR/ld")"

mkdir -p "$SHARED"
echo "shared build directory: $SHARED ($(du -sh "$SHARED" | cut -f1))"

install -m 0755 "$repo/scripts/gc-worktree-targets.sh" /usr/local/sbin/gc-worktree-targets.sh
cat > /etc/cron.d/dj-worktree-gc <<'EOF'
# Reclaim cargo build output from finished agent worktrees.
SHELL=/bin/bash
15 */6 * * * root AGE_HOURS=12 /usr/local/sbin/gc-worktree-targets.sh --apply >> /var/log/dj-worktree-gc.log 2>&1
EOF
chmod 644 /etc/cron.d/dj-worktree-gc
echo "gc: /etc/cron.d/dj-worktree-gc every 6h, targets idle >12h"
