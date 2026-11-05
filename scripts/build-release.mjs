#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const agentDir = join(repoRoot, "packages", "coding-agent");
const outDir = resolve(process.argv[2] ?? join(repoRoot, "release"));
const stage = join(outDir, "delegate-pi");
const archive = join(outDir, "delegate-pi.tar.gz");
const externals = ["jiti", "@silvia-odwyer/photon-node"];

function run(command, args, cwd) {
	return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
}

if (!existsSync(join(agentDir, "dist", "bundle", "cli.js"))) {
	console.error("dist/bundle/cli.js is missing. Run npm run build first.");
	process.exit(1);
}

const version = JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8")).version;
const [pack] = JSON.parse(run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], agentDir));

rmSync(outDir, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

for (const { path } of pack.files) {
	const target = join(stage, path);
	mkdirSync(dirname(target), { recursive: true });
	cpSync(join(agentDir, path), target);
}
chmodSync(join(stage, "dist", "bundle", "cli.js"), 0o755);
chmodSync(join(stage, "delegate", "core", "delegate.mjs"), 0o755);

for (const name of externals) {
	cpSync(join(repoRoot, "node_modules", name), join(stage, "node_modules", name), { recursive: true, dereference: true });
}

cpSync(join(repoRoot, "install.sh"), join(stage, "install.sh"));
chmodSync(join(stage, "install.sh"), 0o755);
cpSync(join(repoRoot, "LICENSE"), join(stage, "LICENSE"));
writeFileSync(join(stage, "VERSION"), `${version}\n`);

run("tar", ["--owner=0", "--group=0", "--numeric-owner", "-czf", archive, "-C", outDir, "delegate-pi"], outDir);
const sum = createHash("sha256").update(readFileSync(archive)).digest("hex");
writeFileSync(`${archive}.sha256`, `${sum}  delegate-pi.tar.gz\n`);

console.log(`delegate-pi ${version}`);
console.log(`files:   ${pack.files.length} from the package, plus ${externals.join(", ")}`);
console.log(`archive: ${archive}`);
console.log(`sha256:  ${sum}`);
