#!/bin/bash

set -euo pipefail

SESHAT_REPOSITORY="https://github.com/matrix-org/seshat.git"
SESHAT_REVISION="2343872cf6d003a572dbb719850e35bf482a3c9c"
SESHAT_VERSION="6.0.1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PATCH="$SCRIPT_DIR/elementplus-seshat-cadence.patch"
SOURCE_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "$SOURCE_DIR"
}
trap cleanup EXIT

git clone --quiet --no-checkout "$SESHAT_REPOSITORY" "$SOURCE_DIR"
git -C "$SOURCE_DIR" checkout --quiet --detach "$SESHAT_REVISION"
test "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$SESHAT_REVISION"
git -C "$SOURCE_DIR" apply --unidiff-zero --check "$PATCH"
git -C "$SOURCE_DIR" apply --unidiff-zero "$PATCH"

grep -q 'const COMMIT_RATE: usize = 20000;' "$SOURCE_DIR/src/index/mod.rs"
grep -q 'const COMMIT_TIME: Duration = Duration::from_secs(60);' "$SOURCE_DIR/src/index/mod.rs"

pushd "$SOURCE_DIR/seshat-node" >/dev/null
yarn install --frozen-lockfile

build_seshat() {
    local target="$1"
    local package="$2"
    local rustflags="${3:-}"
    local destination="$DESKTOP_DIR/node_modules/@matrix-org/$package"

    test "$(node -p "require('$destination/package.json').version")" = "$SESHAT_VERSION"
    rustup target add "$target"
    rm -f index.node
    RUSTFLAGS="$rustflags" yarn run build-bundled --target "$target"
    test -f index.node
    install -m 0644 index.node "$destination/index.node"
}

build_seshat x86_64-apple-darwin seshat-darwin-x64
build_seshat aarch64-apple-darwin seshat-darwin-arm64 "--cfg aes_armv8"
popd >/dev/null
