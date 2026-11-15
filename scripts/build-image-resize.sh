#!/bin/sh
# Build the Rust image resize helper for both released Linux architectures and
# place the binaries where the CLI looks for them (dist/bin).
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
crate="$here/../packages/image-resize-rs"
out="$here/../packages/coding-agent/dist/bin"

if ! command -v cargo >/dev/null 2>&1; then
	echo "build-image-resize: cargo not found; install the Rust toolchain" >&2
	exit 1
fi

mkdir -p "$out"

build() {
	target="$1"
	suffix="$2"
	if ! rustup target list --installed 2>/dev/null | grep -qx "$target"; then
		echo "build-image-resize: adding rust target $target"
		rustup target add "$target"
	fi
	(cd "$crate" && cargo build --release --target "$target")
	cp "$crate/target/$target/release/pi-image-resize" "$out/pi-image-resize-$suffix"
	chmod 755 "$out/pi-image-resize-$suffix"
	echo "built $out/pi-image-resize-$suffix"
}

case "${1:-all}" in
	x64) build x86_64-unknown-linux-musl x64 ;;
	arm64) build aarch64-unknown-linux-musl arm64 ;;
	all)
		build x86_64-unknown-linux-musl x64
		build aarch64-unknown-linux-musl arm64
		;;
	*)
		echo "usage: build-image-resize.sh [all|x64|arm64]" >&2
		exit 2
		;;
esac
