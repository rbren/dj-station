#!/usr/bin/env bash
# dj-station — single entry point (PRD M0 acceptance #1).
#
# From a fresh clone this script:
#   1. checks the toolchain (Rust, wasm32 target, Node),
#   2. builds the WASM extensions, the Rust workspace, and the frontend,
#   3. runs the full test suite (Rust + frontend),
#   4. launches the app:
#        - with a display + webkit2gtk: the Tauri GUI,
#        - headless (CI/servers): the engine in headless mode via dj-cli
#          (documented behavior on headless Linux; use --smoke to render a
#          short demo WAV and exit instead of streaming).
#
# Exits nonzero on any failure. Flags:
#   --no-launch   build + test only
#   --smoke       headless: render 2s of the demo patch to /tmp and exit
set -o pipefail
cd "$(dirname "$0")"

fail() { echo "run.sh: $*" >&2; exit 1; }

NO_LAUNCH=0
SMOKE=0
for arg in "$@"; do
  case "$arg" in
    --no-launch) NO_LAUNCH=1 ;;
    --smoke) SMOKE=1 ;;
    *) fail "unknown flag: $arg" ;;
  esac
done

echo "==> toolchain"
command -v cargo >/dev/null || fail "Rust toolchain not found (install via rustup)"
command -v npm >/dev/null || fail "Node/npm not found"
rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown \
  || rustup target add wasm32-unknown-unknown || fail "cannot install wasm32 target"

echo "==> building WASM extensions"
./scripts/build-extensions.sh || fail "extension build failed"

echo "==> building Rust workspace"
cargo build --workspace --release || fail "Rust build failed"

echo "==> installing frontend deps"
(cd app && npm ci --no-audit --no-fund) || fail "npm ci failed"

echo "==> building frontend (tsc + vite + extension UIs)"
(cd app && npm run build) || fail "frontend build failed"

echo "==> running Rust tests"
cargo test --workspace --release || fail "Rust tests failed"

echo "==> running frontend tests"
(cd app && npm test) || fail "frontend tests failed"

echo "==> running lint"
cargo clippy --workspace --all-targets -- -D warnings || fail "clippy failed"
cargo fmt --all --check || fail "rustfmt failed"
(cd app && npm run lint) || fail "frontend lint failed"

[ "$NO_LAUNCH" = "1" ] && { echo "==> build + tests OK (launch skipped)"; exit 0; }

# GUI is available on macOS (always has a display; Tauri uses WKWebView) or
# on Linux when a display server is reachable.
HAVE_GUI=0
if [ "$(uname -s)" = "Darwin" ] || [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  HAVE_GUI=1
fi

if [ "$SMOKE" = "1" ] || [ "$HAVE_GUI" = "0" ]; then
  echo "==> headless mode (no display detected)"
  ./target/release/dj-cli demo /tmp/dj-demo-patch --extensions extensions \
    || fail "demo patch creation failed"
  if [ "$SMOKE" = "1" ]; then
    ./target/release/dj-cli render /tmp/dj-demo-patch /tmp/dj-demo.wav \
      --seconds 2 --extensions extensions || fail "offline render failed"
    echo "==> smoke OK: rendered /tmp/dj-demo.wav"
    exit 0
  fi
  echo "==> launching engine headless (null backend, Ctrl-C to stop)"
  exec ./target/release/dj-cli run /tmp/dj-demo-patch --backend null --extensions extensions
else
  echo "==> launching Tauri GUI"
  if [ "$(uname -s)" = "Linux" ] && ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    fail "webkit2gtk-4.1 not found — install libwebkit2gtk-4.1-dev (Linux) or run headless"
  fi
  cargo build --manifest-path app/src-tauri/Cargo.toml --release || fail "Tauri build failed"
  exec ./app/src-tauri/target/release/dj-station
fi
