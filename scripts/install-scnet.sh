#!/usr/bin/env bash
# Provision the stem separation model: SCNet XL IHF (MUSDB18 SDR 10.09),
# run through MSST's `inference` module (crates/dj-analysis/src/scnet.rs).
#
# Everything lands under the app's data dir — `custom/scnet/` in a repo
# checkout, `$DJ_STATION_DATA_DIR/scnet` when that is set:
#
#   venv/          MSST + torch (CPU wheels; pass --cuda for CUDA ones)
#   config.yaml    model config    (~6 KB)
#   model.ckpt     model weights   (~214 MB)
#
# Optional tooling, exactly like yt-dlp and beat_this: without it the app
# reports that stems are unavailable and keeps running. Re-running is
# cheap — every step is skipped when it is already done.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="${DJ_STATION_DATA_DIR:-${DJ_STATION_DATA:-$REPO_ROOT/custom}}"
HOME_DIR="$DATA_DIR/scnet"
RELEASE=https://github.com/ZFTurbo/Music-Source-Separation-Training/releases/download/v1.0.15
CONFIG_URL="$RELEASE/config_musdb18_scnet_xl_more_wide_v5.yaml"
WEIGHTS_URL="$RELEASE/model_scnet_ep_36_sdr_10.0891.ckpt"
TORCH_INDEX=https://download.pytorch.org/whl/cpu

while [ $# -gt 0 ]; do
  case "$1" in
    --cuda) TORCH_INDEX="" ;;
    -h|--help) sed -n '2,14p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

mkdir -p "$HOME_DIR"
PY="$HOME_DIR/venv/bin/python"
if [ ! -x "$PY" ]; then
  echo "==> creating $HOME_DIR/venv"
  "${DJ_SCNET_BOOTSTRAP_PYTHON:-python3}" -m venv "$HOME_DIR/venv"
fi

if ! "$PY" -c "import torch" 2>/dev/null; then
  echo "==> installing torch"
  if [ -n "$TORCH_INDEX" ]; then
    "$PY" -m pip install -q --index-url "$TORCH_INDEX" torch torchaudio
  else
    "$PY" -m pip install -q torch torchaudio
  fi
fi

# MSST is not on PyPI; `inference` is a top-level module of its repo.
# Installed --no-deps with the inference-time requirements named here on
# purpose: its declared dependency set drags in wxPython (its GUI), which
# has no Linux wheel and builds for hours.
if ! "$PY" -c "import inference" 2>/dev/null; then
  echo "==> installing MSST (music-source-separation-training)"
  "$PY" -m pip install -q \
    PyYAML librosa ml-collections "numpy>=2.0.0" omegaconf pandas requests soundfile tqdm matplotlib
  "$PY" -m pip install -q --no-deps \
    "music-source-separation-training @ git+https://github.com/ZFTurbo/Music-Source-Separation-Training"
fi

fetch() {
  local url="$1" out="$2"
  if [ -s "$out" ]; then return; fi
  echo "==> downloading $(basename "$out")"
  curl -fL --progress-bar -o "$out.part" "$url"
  mv "$out.part" "$out"
}
fetch "$CONFIG_URL" "$HOME_DIR/config.yaml"
fetch "$WEIGHTS_URL" "$HOME_DIR/model.ckpt"

echo "==> SCNet XL IHF is installed in $HOME_DIR"
echo "    (override with DJ_SCNET_PYTHON / DJ_SCNET_CONFIG / DJ_SCNET_CKPT)"
