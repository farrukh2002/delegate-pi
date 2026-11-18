import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptsDir = dirname(fileURLToPath(import.meta.url));

function fixture(script) {
	const root = mkdtempSync(join(tmpdir(), "pi-web-packaging-"));
	mkdirSync(join(root, "scripts"));
	copyFileSync(join(scriptsDir, script), join(root, "scripts", script));
	return root;
}

function createFile(path, content = "") {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

test("web builds use Zig for both static Linux targets", { skip: process.platform !== "linux" }, () => {
	const root = fixture("build-web.sh");
	try {
		const commands = join(root, "commands");
		const log = join(root, "build.log");
		const crate = join(root, "packages", "web-rs");
		for (const target of ["x86_64-unknown-linux-musl", "aarch64-unknown-linux-musl"]) {
			createFile(join(crate, "target", target, "release", "pi-web"), target);
		}
		createFile(join(commands, "cargo"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$PI_WEB_TEST_BUILD_LOG"\n');
		createFile(
			join(commands, "rustup"),
			'#!/bin/sh\nprintf "%s\\n" x86_64-unknown-linux-musl aarch64-unknown-linux-musl\n',
		);
		createFile(join(commands, "cargo-zigbuild"), "#!/bin/sh\nexit 0\n");
		for (const name of ["cargo", "rustup", "cargo-zigbuild"]) chmodSync(join(commands, name), 0o755);
		const result = spawnSync("/bin/sh", [join(root, "scripts", "build-web.sh")], {
			encoding: "utf8",
			env: { ...process.env, PATH: `${commands}:${process.env.PATH}`, PI_WEB_TEST_BUILD_LOG: log },
		});
		assert.equal(result.status, 0, result.stderr);
		const lines = readFileSync(log, "utf8").trim().split("\n");
		assert.equal(lines.length, 2);
		assert.match(lines[0], /^zigbuild --release --locked --target x86_64-unknown-linux-musl --target-dir /);
		assert.match(lines[1], /^zigbuild --release --locked --target aarch64-unknown-linux-musl --target-dir /);
		const output = join(root, "packages", "coding-agent", "dist", "bin");
		assert.equal(readFileSync(join(output, "pi-web-x64"), "utf8"), "x86_64-unknown-linux-musl");
		assert.equal(readFileSync(join(output, "pi-web-arm64"), "utf8"), "aarch64-unknown-linux-musl");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("compiled Pi assets include web helpers without copying unrelated files", () => {
	const root = fixture("copy-native-helpers.mjs");
	try {
		const dist = join(root, "packages", "coding-agent", "dist");
		for (const name of ["pi-web-x64", "pi-web-arm64", "pi-image-resize-x64", "unrelated"]) {
			createFile(join(dist, "bin", name), name);
		}
		const result = spawnSync(process.execPath, [join(root, "scripts", "copy-native-helpers.mjs")], {
			encoding: "utf8",
		});
		assert.equal(result.status, 0, result.stderr);
		for (const name of ["pi-web-x64", "pi-web-arm64", "pi-image-resize-x64"]) {
			assert.equal(readFileSync(join(dist, name), "utf8"), name);
		}
		assert.equal(existsSync(join(dist, "unrelated")), false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("release validation rejects a missing web helper before changing output", () => {
	const root = fixture("build-release.mjs");
	try {
		const agent = join(root, "packages", "coding-agent");
		createFile(join(agent, "dist", "bundle", "cli.js"));
		createFile(join(agent, "dist", "bin", "pi-image-resize-x64"));
		const marker = join(root, "release", "keep");
		createFile(marker, "unchanged");
		const result = spawnSync(process.execPath, [join(root, "scripts", "build-release.mjs")], {
			encoding: "utf8",
		});
		assert.equal(result.status, 1);
		assert.match(result.stderr, /pi-web-x64 is missing/);
		assert.equal(readFileSync(marker, "utf8"), "unchanged");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
