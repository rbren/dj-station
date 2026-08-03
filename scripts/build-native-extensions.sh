#!/usr/bin/env bash
# Build the native-1 sample extension(s) as cdylibs for the host platform
# and copy each artifact into its extension folder as dsp.dylib / dsp.so /
# dsp.dll (whichever the platform produces).
#
# Native modules are UNSANDBOXED, trusted code (PRD §2 / §5) — this script
# only builds the in-repo sample.
set -u
cd "$(dirname "$0")/.."

build_one() {
  folder="$1"   # extension folder under extensions/
  lib="$2"      # cargo lib name (lib prefix/suffix added per platform)

  cargo build --release --manifest-path "extensions/${folder}/Cargo.toml" || exit 1

  target="extensions/${folder}/target/release"
  if [ -f "${target}/lib${lib}.dylib" ]; then
    src="${target}/lib${lib}.dylib"; dst="extensions/${folder}/dsp.dylib"
  elif [ -f "${target}/lib${lib}.so" ]; then
    src="${target}/lib${lib}.so"; dst="extensions/${folder}/dsp.so"
  elif [ -f "${target}/${lib}.dll" ]; then
    src="${target}/${lib}.dll"; dst="extensions/${folder}/dsp.dll"
  else
    echo "no cdylib artifact for ${lib} in ${target}" >&2
    exit 1
  fi
  cp "$src" "$dst"
  echo "built ${dst} ($(wc -c < "$dst" | tr -d ' ') bytes)"
}

build_one gain-native dj_ext_gain_native
