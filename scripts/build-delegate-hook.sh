#!/bin/sh
# Build the Claude PreToolUse hook for both released Linux architectures and
# place the binaries where the sandbox binds them (delegate/bin).
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
crate="$here/../packages/delegate-hook-rs"
out="$here/../packages/coding-agent/delegate/bin"

if ! command -v cargo >/dev/null 2>&1; then
	echo "build-delegate-hook: cargo not found; install the Rust toolchain" >&2
	exit 1
fi

mkdir -p "$out"

build() {
	target="$1"
	suffix="$2"
	if ! rustup target list --installed 2>/dev/null | grep -qx "$target"; then
		echo "build-delegate-hook: adding rust target $target"
		rustup target add "$target"
	fi
	(cd "$crate" && cargo build --release --target "$target")
	cp "$crate/target/$target/release/child-claude" "$out/child-claude-$suffix"
	chmod 755 "$out/child-claude-$suffix"
	echo "built $out/child-claude-$suffix"
}

case "${1:-all}" in
	x64) build x86_64-unknown-linux-musl x64 ;;
	arm64) build aarch64-unknown-linux-musl arm64 ;;
	all)
		build x86_64-unknown-linux-musl x64
		build aarch64-unknown-linux-musl arm64
		;;
	*)
		echo "usage: build-delegate-hook.sh [all|x64|arm64]" >&2
		exit 2
		;;
esac
