#!/bin/sh
# Build the Rust delegate worker for both released Linux architectures and place
# the binaries in the vendored delegate runtime (delegate/bin), which the
# TypeScript worker loader resolves through DELEGATE_WORKER=rust.
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
crate="$here/../packages/delegate-worker-rs"
out="$here/../packages/coding-agent/delegate/bin"

if ! command -v cargo >/dev/null 2>&1; then
	echo "build-delegate-worker: cargo not found; install the Rust toolchain" >&2
	exit 1
fi

mkdir -p "$out"

build() {
	target="$1"
	suffix="$2"
	if ! rustup target list --installed 2>/dev/null | grep -qx "$target"; then
		echo "build-delegate-worker: adding rust target $target"
		rustup target add "$target"
	fi
	(cd "$crate" && cargo build --release --target "$target")
	cp "$crate/target/$target/release/delegate-worker" "$out/delegate-worker-$suffix"
	chmod 755 "$out/delegate-worker-$suffix"
	echo "built $out/delegate-worker-$suffix"
}

case "${1:-all}" in
	x64) build x86_64-unknown-linux-musl x64 ;;
	arm64) build aarch64-unknown-linux-musl arm64 ;;
	all)
		build x86_64-unknown-linux-musl x64
		build aarch64-unknown-linux-musl arm64
		;;
	*)
		echo "usage: build-delegate-worker.sh [all|x64|arm64]" >&2
		exit 2
		;;
esac
