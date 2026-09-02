#!/usr/bin/env bash
# Provision the default stem separation model: `htdemucs_ft` (MUSDB18 SDR
# 9.0), run through the demucs CLI (crates/dj-analysis/src/demucs.rs).
#
# Everything lands under the app's data dir — `custom/demucs/` in a repo
# checkout, `$DJ_STATION_DATA_DIR/demucs` when that is set:
#
#   venv/          demucs + torch (CPU wheels; pass --cuda for CUDA ones)
#
# The weights (four ~80 MB checkpoints) are not fetched here: the package
# downloads and caches them itself on the first separation.
#
# Optional tooling, exactly like SCNet and yt-dlp: without it the app
# reports that stems are unavailable and keeps running. Re-running is
# cheap — every step is skipped when it is already done.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DJ_STATION_DATA_DIR:-${DJ_STATION_DATA:-$REPO_ROOT/custom}}"
HOME_DIR="$DATA_DIR/demucs"
TORCH_INDEX=https://download.pytorch.org/whl/cpu

while [ $# -gt 0 ]; do
  case "$1" in
    --cuda) TORCH_INDEX="" ;;
    -h|--help) sed -n '2,15p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

mkdir -p "$HOME_DIR"
PY="$HOME_DIR/venv/bin/python"
if [ ! -x "$PY" ]; then
  echo "==> creating $HOME_DIR/venv"
  "${DJ_DEMUCS_BOOTSTRAP_PYTHON:-python3}" -m venv "$HOME_DIR/venv"
fi

if ! "$PY" -c "import torch" 2>/dev/null; then
  echo "==> installing torch"
  if [ -n "$TORCH_INDEX" ]; then
    "$PY" -m pip install -q --index-url "$TORCH_INDEX" torch torchaudio
  else
    "$PY" -m pip install -q torch torchaudio
  fi
fi

if [ ! -x "$HOME_DIR/venv/bin/demucs" ]; then
  echo "==> installing demucs"
  # numpy is named explicitly: demucs uses it but does not declare it, and
  # torch stopped pulling it in, so a bare install imports and dies.
  "$PY" -m pip install -q numpy demucs
fi

echo "==> demucs is installed in $HOME_DIR"
echo "    (override with DJ_DEMUCS_BIN / DJ_DEMUCS_MODEL / DJ_DEMUCS_ARGS)"
