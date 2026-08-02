#!/usr/bin/env bash
# Build all WASM extensions (wasm-1 ABI, SIMD enabled) and copy each
# dsp.wasm into its extension folder.
set -u
cd "$(dirname "$0")/.."

rustup target add wasm32-unknown-unknown >/dev/null 2>&1

export RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=+simd128"

cargo build --release --target wasm32-unknown-unknown \
  --manifest-path extensions/Cargo.toml || exit 1

TARGET=extensions/target/wasm32-unknown-unknown/release
declare -A MAP=(
  [dj_ext_oscillator]=oscillator
  [dj_ext_vca]=vca
  [dj_ext_adsr]=adsr
)
for lib in "${!MAP[@]}"; do
  src="$TARGET/${lib}.wasm"
  dst="extensions/${MAP[$lib]}/dsp.wasm"
  if [ ! -f "$src" ]; then
    echo "missing $src" >&2
    exit 1
  fi
  cp "$src" "$dst"
  echo "built ${MAP[$lib]}/dsp.wasm ($(stat -c%s "$dst") bytes)"
done
