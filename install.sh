#!/bin/sh
set -eu

REPO="farrukh2002/delegate-pi"
NODE_MIN="22.19.0"
NODE_LINE="24"
HOME_DIR="${DELEGATE_PI_HOME:-$HOME/.delegate-pi}"
BIN_DIR="${DELEGATE_PI_BIN_DIR:-$HOME/.local/bin}"
VERSION="${DELEGATE_PI_VERSION:-latest}"
CHANNEL="${DELEGATE_PI_CHANNEL:-}"
TARBALL="${DELEGATE_PI_TARBALL:-}"
TOKEN="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
MARKER="# delegate-pi launcher (managed by install.sh)"
ALIAS="${DELEGATE_PI_ALIAS:-}"
ACTION="install"
PURGE=0

usage() {
	cat <<EOF
delegate-pi installer

usage: install.sh [--channel stable|rc|dev] [--version <x.y.z>] [--bin-dir <dir>]
                  [--alias <name> | --no-alias] [--uninstall [--purge]]

  --channel <name>    stable (default), rc (release candidates) or dev (latest main build)
  --version <x.y.z>   install this release, not the latest
  --bin-dir <dir>     put the delegate-pi command here (default ~/.local/bin)
  --alias <name>      also run delegate-pi as <name> (default: pi, or pi2 if pi exists)
  --no-alias          do not add a second command name
  --uninstall         remove delegate-pi, keep settings and sessions
  --purge             with --uninstall, also remove ~/.delegate-pi

environment: DELEGATE_PI_CHANNEL, DELEGATE_PI_VERSION, DELEGATE_PI_BIN_DIR, DELEGATE_PI_HOME, DELEGATE_PI_ALIAS,
             DELEGATE_PI_TARBALL (a local release archive), GITHUB_TOKEN
EOF
}

while [ $# -gt 0 ]; do
	case "$1" in
		--channel) CHANNEL="${2:?--channel needs a value}"; shift 2 ;;
		--channel=*) CHANNEL="${1#*=}"; shift ;;
		--version) VERSION="${2:?--version needs a value}"; shift 2 ;;
		--version=*) VERSION="${1#*=}"; shift ;;
		--bin-dir) BIN_DIR="${2:?--bin-dir needs a value}"; shift 2 ;;
		--bin-dir=*) BIN_DIR="${1#*=}"; shift ;;
		--uninstall) ACTION="uninstall"; shift ;;
		--alias) ALIAS="${2:?--alias needs a value}"; shift 2 ;;
		--alias=*) ALIAS="${1#*=}"; shift ;;
		--no-alias) ALIAS="none"; shift ;;
		--purge) PURGE=1; shift ;;
		-h|--help) usage; exit 0 ;;
		*) printf 'unknown option: %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
	esac
done
VERSION="${VERSION#v}"
[ -n "$CHANNEL" ] || CHANNEL="$(cat "$HOME_DIR/channel" 2>/dev/null || echo stable)"
case "$CHANNEL" in
	stable|rc|dev) ;;
	*) printf 'unknown channel: %s (use stable, rc or dev)\n' "$CHANNEL" >&2; exit 2 ;;
esac

if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ] && [ "${TERM:-dumb}" != "dumb" ]; then
	TTY=1
	R='\033[0m' B='\033[1m' D='\033[2m'
	G='\033[38;2;63;185;80m' HB='\033[48;2;126;231;135m' E='\033[38;2;13;17;23m' GB='\033[48;2;63;185;80m'
	ACC='\033[38;2;88;166;255m' OK='\033[38;2;63;185;80m' WARN='\033[38;2;210;153;34m' BAD='\033[38;2;248;81;73m' MUTE='\033[38;2;139;148;158m'
else
	TTY=0
	R='' B='' D='' G='' HB='' E='' GB='' ACC='' OK='' WARN='' BAD='' MUTE=''
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/delegate-pi.XXXXXX")"
LOG="$WORK/step.log"
trap 'rm -rf "$WORK"; [ "$TTY" = 1 ] && printf "\033[?25h"' EXIT INT TERM

say() { printf '%b\n' "$*"; }
tilde() {
	case "$1" in
		"$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
		*) printf '%s' "$1" ;;
	esac
}
ok() { say "  ${OK}✓${R} $1${2:+  ${MUTE}$2${R}}"; }
warn() { say "  ${WARN}!${R} $1${2:+  ${MUTE}$2${R}}"; }
fail() {
	say "  ${BAD}✗${R} $1"
	[ -s "$LOG" ] && sed 's/^/    /' "$LOG" | tail -n 12 >&2
	exit 1
}

banner() {
	say ""
	say "   ${G}▄${HB}▀${R}${G}███▄${R}    ${B}delegate${R}${ACC}${B}-pi${R}"
	say "  ${G}██${E}${GB}▀${R}${G}██${E}${GB}▀${R}${G}██${R}   ${MUTE}pi, with sandboxed subagents built in${R}"
	say "  ${G}▀██████▀${R}   ${MUTE}github.com/${REPO}${R}"
	say ""
}

frame() {
	case $(( $1 % 10 )) in
		0) printf '⠋' ;; 1) printf '⠙' ;; 2) printf '⠹' ;; 3) printf '⠸' ;; 4) printf '⠼' ;;
		5) printf '⠴' ;; 6) printf '⠦' ;; 7) printf '⠧' ;; 8) printf '⠇' ;; *) printf '⠏' ;;
	esac
}

step() {
	label="$1"
	shift
	: >"$LOG"
	if [ "$TTY" = 1 ]; then
		printf '\033[?25l'
		"$@" >"$LOG" 2>&1 &
		pid=$!
		i=0
		while kill -0 "$pid" 2>/dev/null; do
			printf '\r  %b%s%b %s' "$ACC" "$(frame "$i")" "$R" "$label"
			i=$((i + 1))
			sleep 0.08
		done
		if wait "$pid"; then rc=0; else rc=$?; fi
		printf '\r\033[2K\033[?25h'
	else
		"$@" >"$LOG" 2>&1 &
		if wait "$!"; then rc=0; else rc=$?; fi
	fi
	[ "$rc" -eq 0 ] || fail "$label"
}

need() { command -v "$1" >/dev/null 2>&1; }

fetch() {
	url="$1"
	out="$2"
	shift 2
	if need curl; then
		set -- -fsSL --retry 2 "$@"
		curl "$@" -o "$out" "$url"
	else
		header=""
		for h in "$@"; do [ "$h" = "-H" ] || header="$header --header=$h"; done
		wget -q $header -O "$out" "$url"
	fi
}

version_ge() {
	[ "$(printf '%s\n%s\n' "$2" "$1" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" = "$2" ]
}

detect_platform() {
	[ "$(uname -s)" = "Linux" ] || fail "delegate-pi runs on Linux only (found $(uname -s))"
	case "$(uname -m)" in
		x86_64|amd64) ARCH="x64" ;;
		aarch64|arm64) ARCH="arm64" ;;
		*) fail "unsupported CPU: $(uname -m)" ;;
	esac
	need curl || need wget || fail "curl or wget is required"
	need tar || fail "tar is required"
	ok "Linux $ARCH"
}

bwrap_hint() {
	if need dnf; then echo "sudo dnf install bubblewrap"
	elif need apt-get; then echo "sudo apt-get install bubblewrap"
	elif need pacman; then echo "sudo pacman -S bubblewrap"
	elif need zypper; then echo "sudo zypper install bubblewrap"
	elif need apk; then echo "sudo apk add bubblewrap"
	else echo "install bubblewrap with your package manager"
	fi
}

check_bwrap() {
	if need bwrap; then
		ok "bubblewrap" "$(tilde "$(command -v bwrap)")"
	else
		warn "bubblewrap is missing, child agents cannot start without it" "$(bwrap_hint)"
	fi
}

download_node() {
	base="https://nodejs.org/dist/latest-v${NODE_LINE}.x"
	fetch "$base/SHASUMS256.txt" "$WORK/SHASUMS256.txt"
	file="$(grep -o "node-v[0-9.]*-linux-${ARCH}\.tar\.gz" "$WORK/SHASUMS256.txt" | head -n 1)"
	[ -n "$file" ] || { echo "no Node.js build for linux-$ARCH"; return 1; }
	fetch "$base/$file" "$WORK/$file"
	expected="$(grep " $file\$" "$WORK/SHASUMS256.txt" | cut -d' ' -f1)"
	actual="$(sha256sum "$WORK/$file" | cut -d' ' -f1)"
	[ "$expected" = "$actual" ] || { echo "Node.js checksum mismatch"; return 1; }
	rm -rf "$HOME_DIR/runtime/node.new"
	mkdir -p "$HOME_DIR/runtime/node.new"
	tar -xzf "$WORK/$file" -C "$HOME_DIR/runtime/node.new" --strip-components=1
	rm -rf "$HOME_DIR/runtime/node"
	mv "$HOME_DIR/runtime/node.new" "$HOME_DIR/runtime/node"
}

ensure_node() {
	NODE=""
	if need node; then
		have="$(node -p 'process.versions.node' 2>/dev/null || echo 0)"
		if version_ge "$have" "$NODE_MIN"; then
			NODE="$(command -v node)"
			rm -rf "$HOME_DIR/runtime/node"
			ok "Node.js $have" "$(tilde "$NODE")"
			return
		fi
		warn "Node.js $have is older than $NODE_MIN" "using a private copy"
	fi
	if [ -x "$HOME_DIR/runtime/node/bin/node" ]; then
		have="$("$HOME_DIR/runtime/node/bin/node" -p 'process.versions.node')"
		if version_ge "$have" "$NODE_MIN"; then
			NODE="$HOME_DIR/runtime/node/bin/node"
			ok "Node.js $have" "private copy"
			return
		fi
	fi
	mkdir -p "$HOME_DIR/runtime"
	step "Downloading Node.js $NODE_LINE" download_node
	NODE="$HOME_DIR/runtime/node/bin/node"
	ok "Node.js $("$NODE" -p 'process.versions.node')" "private copy in $(tilde "$HOME_DIR/runtime")"
}

resolve_tag() {
	TAG=""
	if [ "$VERSION" != "latest" ]; then TAG="v$VERSION"; return; fi
	case "$CHANNEL" in
		dev) TAG="dev" ;;
		rc)
			if [ -n "$TOKEN" ]; then
				fetch "https://api.github.com/repos/$REPO/releases?per_page=50" "$WORK/releases.json" \
					-H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json"
			else
				fetch "https://api.github.com/repos/$REPO/releases?per_page=50" "$WORK/releases.json" \
					-H "Accept: application/vnd.github+json"
			fi
			TAG="$("$NODE" -e '
				const list = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
				const hit = list.find((r) => /-rc\.\d+$/.test(r.tag_name));
				if (!hit) process.exit(1);
				console.log(hit.tag_name);
			' "$WORK/releases.json")" || { echo "no release candidate is published yet"; return 1; }
			;;
	esac
}

api_asset() {
	if [ -z "$TAG" ]; then ref="latest"; else ref="tags/$TAG"; fi
	fetch "https://api.github.com/repos/$REPO/releases/$ref" "$WORK/release.json" \
		-H "Authorization: Bearer $TOKEN" -H "Accept: application/vnd.github+json"
	for name in delegate-pi.tar.gz delegate-pi.tar.gz.sha256; do
		url="$("$NODE" -e '
			const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
			const a = (r.assets || []).find((x) => x.name === process.argv[2]);
			if (!a) process.exit(1);
			console.log(a.url);
		' "$WORK/release.json" "$name")" || { echo "release has no $name"; return 1; }
		fetch "$url" "$WORK/$name" -H "Authorization: Bearer $TOKEN" -H "Accept: application/octet-stream"
	done
}

download_release() {
	if [ -n "$TARBALL" ]; then
		cp "$TARBALL" "$WORK/delegate-pi.tar.gz"
		if [ -f "$TARBALL.sha256" ]; then cp "$TARBALL.sha256" "$WORK/delegate-pi.tar.gz.sha256"; fi
	elif [ -n "$TOKEN" ]; then
		resolve_tag
		api_asset
	else
		resolve_tag
		if [ -z "$TAG" ]; then
			base="https://github.com/$REPO/releases/latest/download"
		else
			base="https://github.com/$REPO/releases/download/$TAG"
		fi
		fetch "$base/delegate-pi.tar.gz" "$WORK/delegate-pi.tar.gz"
		fetch "$base/delegate-pi.tar.gz.sha256" "$WORK/delegate-pi.tar.gz.sha256"
	fi
	if [ -f "$WORK/delegate-pi.tar.gz.sha256" ]; then
		(cd "$WORK" && sha256sum -c delegate-pi.tar.gz.sha256 >/dev/null) || { echo "checksum mismatch"; return 1; }
	elif [ -z "$TARBALL" ]; then
		echo "release has no checksum file"
		return 1
	fi
	mkdir -p "$WORK/unpack"
	tar -xzf "$WORK/delegate-pi.tar.gz" -C "$WORK/unpack"
	"$NODE" "$WORK/unpack/delegate-pi/dist/bundle/cli.js" --version
}

place_app() {
	mkdir -p "$HOME_DIR"
	rm -rf "$HOME_DIR/app.new" "$HOME_DIR/app.old"
	mv "$WORK/unpack/delegate-pi" "$HOME_DIR/app.new"
	if [ -d "$HOME_DIR/app" ]; then mv "$HOME_DIR/app" "$HOME_DIR/app.old"; fi
	mv "$HOME_DIR/app.new" "$HOME_DIR/app"
	rm -rf "$HOME_DIR/app.old"
}

write_launcher() {
	mkdir -p "$BIN_DIR"
	launcher="$BIN_DIR/delegate-pi"
	if [ -e "$launcher" ] && ! grep -q "^$MARKER\$" "$launcher" 2>/dev/null; then
		mv "$launcher" "$launcher.bak"
		warn "moved the old delegate-pi command to" "$(tilde "$launcher.bak")"
	fi
	if [ "$CHANNEL" = "stable" ]; then
		update="--version {version}"
	else
		update="--channel $CHANNEL"
	fi
	cat >"$launcher.new" <<EOF
#!/bin/sh
$MARKER
app="$HOME_DIR/app"
node="$HOME_DIR/runtime/node/bin/node"
[ -x "\$node" ] || node="\$(command -v node)" || { echo "delegate-pi: Node.js not found, run the installer again" >&2; exit 1; }
export PI_SELF_UPDATE_COMMAND="\${PI_SELF_UPDATE_COMMAND:-sh \$app/install.sh --bin-dir $BIN_DIR $update}"
exec "\$node" "\$app/dist/bundle/cli.js" "\$@"
EOF
	chmod 755 "$launcher.new"
	mv "$launcher.new" "$launcher"
}

ours() {
	[ -L "$BIN_DIR/$1" ] && [ "$(readlink "$BIN_DIR/$1")" = "$BIN_DIR/delegate-pi" ]
}

ask_yes() {
	( exec </dev/tty ) 2>/dev/null || return 1
	printf '%b' "  ${ACC}?${R} $1 ${MUTE}[Y/n]${R} "
	read -r answer </dev/tty || answer="n"
	case "$answer" in
		""|y|Y|yes|YES) return 0 ;;
		*) return 1 ;;
	esac
}

setup_alias() {
	state="$HOME_DIR/alias"
	previous="$(cat "$state" 2>/dev/null || true)"
	choice="$ALIAS"
	if [ -z "$choice" ] && [ -n "$previous" ]; then
		choice="$previous"
	elif [ -z "$choice" ]; then
		existing="$(command -v pi 2>/dev/null || true)"
		if [ -n "$existing" ] && ! ours pi; then
			choice="pi2"
			say "  ${MUTE}pi is already installed at $(tilde "$existing"), so delegate-pi also gets the name pi2${R}"
		elif ask_yes "Also run delegate-pi as ${B}pi${R}?"; then
			choice="pi"
		else
			choice="none"
		fi
	fi
	if [ -n "$previous" ] && [ "$previous" != "$choice" ] && ours "$previous"; then
		rm -f "$BIN_DIR/$previous"
	fi
	if [ "$choice" = "none" ]; then
		printf 'none\n' >"$state"
		return
	fi
	case "$choice" in
		*/*|-*|"") warn "not a valid command name: $choice"; return ;;
	esac
	target="$BIN_DIR/$choice"
	found="$(command -v "$choice" 2>/dev/null || true)"
	if { [ -e "$target" ] || [ -L "$target" ]; } && ! ours "$choice"; then
		warn "$(tilde "$target") already exists, so the name $choice was not added"
		return
	fi
	if [ -n "$found" ] && [ "$found" != "$target" ]; then
		warn "$choice already runs $(tilde "$found"), so the name $choice was not added"
		return
	fi
	ln -sfn "$BIN_DIR/delegate-pi" "$target"
	printf '%s\n' "$choice" >"$state"
	ok "alias" "$choice → delegate-pi"
	ALIAS_NAME="$choice"
}

path_hint() {
	case ":$PATH:" in
		*":$BIN_DIR:"*) return ;;
	esac
	case "${SHELL##*/}" in
		fish) line="fish_add_path $BIN_DIR" ;;
		zsh) line="echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.zshrc" ;;
		*) line="echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> ~/.bashrc" ;;
	esac
	say ""
	warn "$(tilde "$BIN_DIR") is not on your PATH. Add it with:"
	say "      ${B}$line${R}"
}

box() {
	width=0
	for line in "$@"; do
		plain="$(printf '%b' "$line" | sed 's/\x1b\[[0-9;]*m//g')"
		[ "${#plain}" -gt "$width" ] && width=${#plain}
	done
	width=$((width + 4))
	say ""
	say "  ${MUTE}╭$(printf '%*s' "$width" '' | sed 's/ /─/g')╮${R}"
	for line in "$@"; do
		plain="$(printf '%b' "$line" | sed 's/\x1b\[[0-9;]*m//g')"
		pad=$((width - 2 - ${#plain}))
		[ "$pad" -lt 0 ] && pad=0
		say "  ${MUTE}│${R}  $line$(printf '%*s' "$pad" '')${MUTE}│${R}"
	done
	say "  ${MUTE}╰$(printf '%*s' "$width" '' | sed 's/ /─/g')╯${R}"
}

uninstall() {
	banner
	launcher="$BIN_DIR/delegate-pi"
	for name in $(cat "$HOME_DIR/alias" 2>/dev/null || true) pi pi2; do
		if ours "$name"; then rm -f "$BIN_DIR/$name"; ok "removed the alias" "$name"; fi
	done
	rm -f "$HOME_DIR/alias" "$HOME_DIR/channel"
	if [ -f "$launcher" ] && grep -q "^$MARKER\$" "$launcher"; then
		rm -f "$launcher"
		ok "removed" "$(tilde "$launcher")"
		if [ -f "$launcher.bak" ]; then mv "$launcher.bak" "$launcher"; ok "restored the old command" "$(tilde "$launcher")"; fi
	fi
	rm -rf "$HOME_DIR/app" "$HOME_DIR/runtime"
	ok "removed the app" "$(tilde "$HOME_DIR/app")"
	if [ "$PURGE" = 1 ]; then
		rm -rf "$HOME_DIR"
		ok "removed settings and sessions" "$(tilde "$HOME_DIR")"
	else
		say "  ${MUTE}kept settings and sessions in $(tilde "$HOME_DIR") (use --purge to remove them)${R}"
	fi
	say ""
}

install() {
	banner
	detect_platform
	check_bwrap
	ensure_node
	label="Downloading delegate-pi"
	[ "$CHANNEL" = "stable" ] || label="Downloading delegate-pi ($CHANNEL channel)"
	[ "$VERSION" = "latest" ] || label="Downloading delegate-pi $VERSION"
	[ -z "$TARBALL" ] || label="Unpacking $TARBALL"
	step "$label" download_release
	installed="$(cat "$WORK/unpack/delegate-pi/VERSION" 2>/dev/null || tail -n 1 "$LOG")"
	ok "delegate-pi $installed" "checksum verified"
	place_app
	printf '%s\n' "$CHANNEL" >"$HOME_DIR/channel"
	write_launcher
	ok "installed" "$(tilde "$BIN_DIR/delegate-pi")"
	ALIAS_NAME=""
	setup_alias
	path_hint
	start="${ACC}delegate-pi${R}"
	[ -z "$ALIAS_NAME" ] || start="${ACC}delegate-pi${R} ${MUTE}or${R} ${ACC}$ALIAS_NAME${R}"
	box \
		"${OK}${B}delegate-pi $installed is ready${R}" \
		"" \
		"${ACC}cd${R} your-project ${D}&&${R} $start" \
		"${MUTE}then${R} /login ${MUTE}to sign in to a model provider${R}" \
		"" \
		"${MUTE}update${R}     delegate-pi update" \
		"${MUTE}uninstall${R}  sh $(tilde "$HOME_DIR")/app/install.sh --uninstall"
	say ""
}

"$ACTION"
