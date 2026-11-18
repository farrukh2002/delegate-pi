#!/bin/sh
set -eu

if [ "$(uname -s)" != "Linux" ]; then
	echo "build-web: only Linux is supported" >&2
	exit 1
fi

here="$(cd "$(dirname "$0")" && pwd)"
crate="$here/../packages/web-rs"
out="$here/../packages/coding-agent/dist/bin"

for tool in cargo rustup cargo-zigbuild; do
	if ! command -v "$tool" >/dev/null 2>&1; then
		echo "build-web: $tool not found; see packages/coding-agent/docs/web-engine.md" >&2
		exit 1
	fi
done

mkdir -p "$out"

build() {
	target="$1"
	suffix="$2"
	if ! rustup target list --installed | grep -qx "$target"; then
		rustup target add "$target"
	fi
	(cd "$crate" && cargo zigbuild --release --locked --target "$target" --target-dir "$crate/target")
	cp "$crate/target/$target/release/pi-web" "$out/pi-web-$suffix"
	chmod 755 "$out/pi-web-$suffix"
	echo "built $out/pi-web-$suffix"
}

case "${1:-all}" in
	x64) build x86_64-unknown-linux-musl x64 ;;
	arm64) build aarch64-unknown-linux-musl arm64 ;;
	all)
		build x86_64-unknown-linux-musl x64
		build aarch64-unknown-linux-musl arm64
		;;
	*)
		echo "usage: build-web.sh [all|x64|arm64]" >&2
		exit 2
		;;
esac
