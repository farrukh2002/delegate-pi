#!/usr/bin/env node
// Place the native helpers next to a compiled Bun executable. The Bun build
// cannot embed them, so the CLI resolves them from `dirname(process.execPath)`.
import { copyFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const binDir = join(root, "packages", "coding-agent", "dist", "bin");
const target = join(root, "packages", "coding-agent", "dist");

if (!existsSync(binDir)) {
	console.log("copy-native-helpers: no dist/bin, nothing to copy");
	process.exit(0);
}
for (const name of readdirSync(binDir)) {
	if (!name.startsWith("pi-image-resize") && !name.startsWith("pi-web")) continue;
	copyFileSync(join(binDir, name), join(target, name));
	console.log(`copied ${name}`);
}
