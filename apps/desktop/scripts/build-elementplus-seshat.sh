#!/bin/bash

set -euo pipefail

SESHAT_REPOSITORY="https://github.com/matrix-org/seshat.git"
SESHAT_REVISION="2343872cf6d003a572dbb719850e35bf482a3c9c"
SESHAT_VERSION="6.0.1"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PATCH="$SCRIPT_DIR/elementplus-seshat-cadence.patch"
# Keeps copies of the stock and optimized binaries for verify-elementplus-seshat.sh.
EVIDENCE_DIR="${ELEMENTPLUS_SESHAT_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/elementplus-seshat}"
SOURCE_DIR="$(mktemp -d)"

cleanup() {
    rm -rf "$SOURCE_DIR"
}
trap cleanup EXIT

# Print the native binary that @matrix-org/seshat loads for a platform package. pnpm installs the platform
# packages as optional dependencies of @matrix-org/seshat, so they are only resolvable from that package.
resolve_native() {
    node - "$DESKTOP_DIR" "$1" "$SESHAT_VERSION" <<'EOF'
const fs = require("fs");
const path = require("path");
const [desktopDir, pkg, version] = process.argv.slice(2);
const fail = (message) => {
    console.error(message);
    process.exit(1);
};
const seshatManifest = require.resolve("@matrix-org/seshat/package.json", { paths: [desktopDir] });
const seshatDir = path.dirname(seshatManifest);
if (require(seshatManifest).version !== version) fail(`@matrix-org/seshat is not ${version}`);
const pkgManifest = require.resolve(`${pkg}/package.json`, { paths: [seshatDir] });
if (require(pkgManifest).version !== version) fail(`${pkg} is not ${version}`);
// seshat's loader does require(pkg), which resolves through the package's main (index.node when unset).
const loaded = fs.realpathSync(require.resolve(pkg, { paths: [seshatDir] }));
const main = require(pkgManifest).main || "index.node";
if (loaded !== fs.realpathSync(path.join(path.dirname(pkgManifest), main))) fail(`${pkg} loads ${loaded}`);
if (path.extname(loaded) !== ".node") fail(`${pkg} loads ${loaded}, which is not a native module`);
console.log(loaded);
EOF
}

git clone --quiet --no-checkout "$SESHAT_REPOSITORY" "$SOURCE_DIR"
git -C "$SOURCE_DIR" checkout --quiet --detach "$SESHAT_REVISION"
test "$(git -C "$SOURCE_DIR" rev-parse HEAD)" = "$SESHAT_REVISION"
git -C "$SOURCE_DIR" apply --unidiff-zero --check "$PATCH"
git -C "$SOURCE_DIR" apply --unidiff-zero "$PATCH"

grep -q 'const COMMIT_RATE: usize = 20000;' "$SOURCE_DIR/src/index/mod.rs"
grep -q 'const COMMIT_TIME: Duration = Duration::from_secs(60);' "$SOURCE_DIR/src/index/mod.rs"

# Resolve both destinations before the slow builds so a missing package fails fast.
X64_DESTINATION="$(resolve_native @matrix-org/seshat-darwin-x64)"
ARM64_DESTINATION="$(resolve_native @matrix-org/seshat-darwin-arm64)"

rm -rf "$EVIDENCE_DIR"
mkdir -p "$EVIDENCE_DIR"

pushd "$SOURCE_DIR/seshat-node" >/dev/null
yarn install --frozen-lockfile

build_seshat() {
    local target="$1"
    local arch="$2"
    local destination="$3"
    local rustflags="${4:-}"

    rustup target add "$target"
    rm -f index.node
    RUSTFLAGS="$rustflags" yarn run build-bundled --target "$target"
    test -f index.node
    cmp -s index.node "$destination" && {
        echo "Optimized seshat-darwin-$arch is identical to the stock binary" >&2
        exit 1
    }
    cp "$destination" "$EVIDENCE_DIR/$arch.stock.node"
    cp index.node "$EVIDENCE_DIR/$arch.built.node"
    # Replace by rename so the pnpm store file hard-linked to the destination is left untouched.
    install -m 0644 index.node "$destination.elementplus"
    mv -f "$destination.elementplus" "$destination"
    cmp "$destination" "$EVIDENCE_DIR/$arch.built.node"
    echo "seshat-darwin-$arch: stock $(shasum -a 256 "$EVIDENCE_DIR/$arch.stock.node" | cut -d' ' -f1)" \
        "-> optimized $(shasum -a 256 "$destination" | cut -d' ' -f1)"
}

build_seshat x86_64-apple-darwin x64 "$X64_DESTINATION"
build_seshat aarch64-apple-darwin arm64 "$ARM64_DESTINATION" "--cfg aes_armv8"
popd >/dev/null
