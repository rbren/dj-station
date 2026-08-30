#!/usr/bin/env bash
# Build all WASM extensions (wasm-1 ABI, SIMD enabled) and copy each
# dsp.wasm into its extension folder.
set -u
cd "$(dirname "$0")/.."

rustup target add wasm32-unknown-unknown >/dev/null 2>&1

export RUSTFLAGS="${RUSTFLAGS:-} -C target-feature=+simd128"

cargo build --release --target wasm32-unknown-unknown \
  --manifest-path extensions/Cargo.toml || exit 1

# Every extension folder with a Cargo.toml maps to <folder>/dsp.wasm; the
# artifact name is the package name with dashes turned into underscores.
TARGET=extensions/target/wasm32-unknown-unknown/release
for cargo_toml in extensions/*/Cargo.toml; do
  folder="$(dirname "$cargo_toml")"
  name="$(basename "$folder")"
  # gain-native is a separate workspace built by build-native-extensions.sh.
  [ "$name" = "gain-native" ] && continue
  # Library-only crates (shared DSP, e.g. mixer_core) build no cdylib and
  # ship no module of their own.
  grep -q '^crate-type *=.*cdylib' "$cargo_toml" || continue
  pkg="$(sed -n 's/^name *= *"\(.*\)"/\1/p' "$cargo_toml" | head -1)"
  lib="$(echo "$pkg" | tr '-' '_')"
  src="$TARGET/${lib}.wasm"
  dst="${folder}/dsp.wasm"
  if [ ! -f "$src" ]; then
    echo "missing $src" >&2
    exit 1
  fi
  cp "$src" "$dst"
  echo "built ${name}/dsp.wasm ($(wc -c < "$dst" | tr -d ' ') bytes)"
done
