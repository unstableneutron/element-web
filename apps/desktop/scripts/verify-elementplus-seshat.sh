#!/bin/bash

# Fail unless each packaged app (in every DMG and macOS ZIP in dist) ships the optimized Seshat binaries
# built by build-elementplus-seshat.sh for both x64 and arm64, rather than the stock prebuilt ones.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DIST_DIR="${1:-$SCRIPT_DIR/../dist}"
EVIDENCE_DIR="${ELEMENTPLUS_SESHAT_DIR:-${RUNNER_TEMP:-${TMPDIR:-/tmp}}/elementplus-seshat}"
WORK_DIR="$(mktemp -d)"
MOUNT_POINT="$WORK_DIR/dmg"

cleanup() {
    hdiutil detach "$MOUNT_POINT" -quiet 2>/dev/null || true
    rm -rf "$WORK_DIR"
}
trap cleanup EXIT

sha256() {
    shasum -a 256 "$1" | cut -d' ' -f1
}

# Signing rewrites each Mach-O signature, so when the bytes differ compare copies with signatures removed.
same_binary() {
    [ "$(sha256 "$1")" = "$(sha256 "$2")" ] && return 0
    cp "$1" "$WORK_DIR/a.node"
    cp "$2" "$WORK_DIR/b.node"
    codesign --remove-signature "$WORK_DIR/a.node" 2>/dev/null || true
    codesign --remove-signature "$WORK_DIR/b.node" 2>/dev/null || true
    [ "$(sha256 "$WORK_DIR/a.node")" = "$(sha256 "$WORK_DIR/b.node")" ]
}

check_app() {
    local apps=("$1"/*.app)
    test "${#apps[@]}" -eq 1
    local arch packaged
    for arch in x64 arm64; do
        packaged="${apps[0]}/Contents/Resources/app.asar.unpacked/node_modules/@matrix-org/seshat-darwin-$arch/index.node"
        test -f "$packaged"
        if same_binary "$packaged" "$EVIDENCE_DIR/$arch.stock.node"; then
            echo "::error::$2 ships the stock seshat-darwin-$arch binary"
            exit 1
        fi
        if ! same_binary "$packaged" "$EVIDENCE_DIR/$arch.built.node"; then
            echo "::error::$2 seshat-darwin-$arch ($(sha256 "$packaged")) is not the optimized build"
            exit 1
        fi
        echo "$2: seshat-darwin-$arch $(sha256 "$packaged") matches optimized build" \
            "$(sha256 "$EVIDENCE_DIR/$arch.built.node")"
    done
}

for arch in x64 arm64; do
    test -f "$EVIDENCE_DIR/$arch.stock.node"
    test -f "$EVIDENCE_DIR/$arch.built.node"
done

shopt -s nullglob
dmgs=("$DIST_DIR"/*.dmg)
zips=("$DIST_DIR"/*-mac.zip)
test $((${#dmgs[@]} + ${#zips[@]})) -gt 0

for dmg in "${dmgs[@]}"; do
    mkdir -p "$MOUNT_POINT"
    hdiutil attach "$dmg" -nobrowse -readonly -mountpoint "$MOUNT_POINT" -quiet
    check_app "$MOUNT_POINT" "$(basename "$dmg")"
    hdiutil detach "$MOUNT_POINT" -quiet
done

for zip in "${zips[@]}"; do
    rm -rf "$WORK_DIR/zip"
    ditto -x -k "$zip" "$WORK_DIR/zip"
    check_app "$WORK_DIR/zip" "$(basename "$zip")"
done
