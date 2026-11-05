import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolveOnPath, type Invocation } from "./providers.ts";
import type { ProviderId } from "./types.ts";
import { DATA, PROJECTS, TASKS, type GitMounts, type ScopeLayout } from "./workspace.ts";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUNTIME = path.resolve(ROOT, "..");
const HOME = os.homedir();
export const PI_PACKAGE_MOUNT = "/delegate-pi-package";
export const PI_ENTRY_MOUNT = "/delegate-pi-entry.mjs";
export const PI_DEPS_MOUNT = "/delegate-pi-deps";

function realPath(value: string | undefined): string | undefined {
	if (!value) return undefined;
	try { return fs.realpathSync(value); } catch { return undefined; }
}

function piDependencyDir(): string | undefined {
	for (const anchor of [realPath(process.env.DELEGATE_PI_ENTRY), realPath(process.env.DELEGATE_PI_PACKAGE_DIR)]) {
		if (!anchor) continue;
		try {
			const base = fs.statSync(anchor).isDirectory() ? anchor : path.dirname(anchor);
			const requireFrom = createRequire(path.join(base, "index.js"));
			return path.dirname(requireFrom.resolve("jiti/package.json"));
		} catch {}
	}
	return undefined;
}

function mountedPiEntry(): string | undefined {
	const pkg = realPath(process.env.DELEGATE_PI_PACKAGE_DIR);
	const entry = realPath(process.env.DELEGATE_PI_ENTRY);
	if (!entry) return undefined;
	if (pkg && entry.startsWith(pkg + "/")) return path.join(PI_PACKAGE_MOUNT, path.relative(pkg, entry));
	return PI_ENTRY_MOUNT;
}

function piConfigDir(): string {
	return process.env.DELEGATE_PI_CONFIG_DIR || ".pi";
}

export function executable(name: string): string {
	for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
		const candidate = path.resolve(dir, name);
		try {
			fs.accessSync(candidate, fs.constants.X_OK);
			return fs.realpathSync(candidate);
		} catch {}
	}
	throw new Error(`Required executable is missing: ${name}`);
}

interface CredentialCopy {
	rel: string;
	from: string;
	hash: string;
}

const CREDENTIALS_FILE = "credentials.json";
const IDENTITY_KEYS = new Set(["account_id", "accountId", "accountUuid", "organizationUuid", "email", "user_id", "userId"]);

function sha256(data: Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

function copyPrivate(home: string, rel: string, from = path.join(HOME, rel)): CredentialCopy | undefined {
	if (!fs.existsSync(from)) return undefined;
	const to = path.join(home, rel);
	fs.mkdirSync(path.dirname(to), { recursive: true, mode: 0o700 });
	const data = fs.readFileSync(from);
	fs.writeFileSync(to, data, { mode: 0o600 });
	fs.chmodSync(to, 0o600);
	return { rel, from, hash: sha256(data) };
}

function readChildFile(home: string, rel: string): Buffer | undefined {
	const file = path.join(home, rel);
	const root = fs.realpathSync(home);
	const parent = fs.realpathSync(path.dirname(file));
	if (parent !== root && !parent.startsWith(root + path.sep)) return undefined;
	const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
	try {
		const stat = fs.fstatSync(fd);
		if (!stat.isFile() || stat.size > 1024 * 1024) return undefined;
		return fs.readFileSync(fd);
	} finally {
		fs.closeSync(fd);
	}
}

function identities(value: unknown, depth = 0, found = new Map<string, unknown>(), prefix = ""): Map<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value) || depth > 3) return found;
	for (const [key, item] of Object.entries(value)) {
		if (IDENTITY_KEYS.has(key) && (typeof item === "string" || typeof item === "number")) found.set(`${prefix}${key}`, item);
		else identities(item, depth + 1, found, `${prefix}${key}.`);
	}
	return found;
}

function sameAccount(host: Buffer, child: Buffer): boolean {
	let before: any;
	let after: any;
	try {
		before = JSON.parse(host.toString("utf8"));
		after = JSON.parse(child.toString("utf8"));
	} catch {
		return false;
	}
	if (!before || !after || typeof before !== "object" || typeof after !== "object" || Array.isArray(before) || Array.isArray(after)) return false;
	if (Object.keys(before).sort().join("\0") !== Object.keys(after).sort().join("\0")) return false;
	const expected = identities(before);
	const actual = identities(after);
	for (const [key, value] of expected) if (actual.get(key) !== value) return false;
	return true;
}

export function returnCredentials(taskDir: string): string[] {
	let copies: CredentialCopy[];
	try { copies = JSON.parse(fs.readFileSync(path.join(taskDir, CREDENTIALS_FILE), "utf8")); } catch { return []; }
	const home = path.join(taskDir, "home");
	const returned: string[] = [];
	for (const copy of Array.isArray(copies) ? copies : []) {
		try {
			const child = readChildFile(home, copy.rel);
			if (!child || sha256(child) === copy.hash) continue;
			const host = fs.readFileSync(copy.from);
			if (sha256(host) !== copy.hash || !sameAccount(host, child)) continue;
			const temp = `${copy.from}.delegate-${process.pid}-${Date.now()}.tmp`;
			fs.writeFileSync(temp, child, { mode: 0o600, flag: "wx" });
			fs.renameSync(temp, copy.from);
			returned.push(copy.from);
		} catch {}
	}
	return returned;
}

export function closeHome(taskDir: string): void {
	returnCredentials(taskDir);
	fs.rmSync(path.join(taskDir, "home"), { recursive: true, force: true });
	fs.rmSync(path.join(taskDir, CREDENTIALS_FILE), { force: true });
}

function piAgentSource(config: string): string {
	const override = process.env.DELEGATE_PI_CODING_AGENT_DIR?.trim();
	if (override) return override.startsWith("~/") ? path.join(HOME, override.slice(2)) : override;
	return path.join(HOME, config, "agent");
}

export function hostGitConfig(key: string): string | undefined {
	try {
		const value = execFileSync("git", ["config", "--global", "--get", key], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME, ...(process.env.XDG_CONFIG_HOME ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME } : {}) },
			timeout: 5000,
		}).trim();
		return value && !/[\0\n\r]/.test(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function gitValue(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function prepareHome(home: string, provider: ProviderId): void {
	fs.mkdirSync(home, { recursive: true, mode: 0o700 });
	const name = hostGitConfig("user.name") ?? "delegate child";
	const email = hostGitConfig("user.email") ?? "delegate@localhost";
	fs.writeFileSync(path.join(home, ".gitconfig"), `[user]\n\tname = ${gitValue(name)}\n\temail = ${gitValue(email)}\n[init]\n\tdefaultBranch = main\n`, { mode: 0o600 });
	const config = piConfigDir();
	const files: Record<ProviderId, string[]> = {
		pi: [],
		claude: [".claude/.credentials.json"],
		codex: [".codex/auth.json"],
		commandcode: [".commandcode/auth.json", ".commandcode/providers.json"],
	};
	const credentials: CredentialCopy[] = [];
	for (const rel of files[provider]) {
		const copy = copyPrivate(home, rel);
		if (copy && !rel.endsWith("providers.json")) credentials.push(copy);
	}
	if (provider === "pi") {
		const source = piAgentSource(config);
		const dir = path.join(home, config, "agent");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const auth = copyPrivate(home, path.join(config, "agent", "auth.json"), path.join(source, "auth.json"));
		if (auth) credentials.push(auth);
		copyPrivate(home, path.join(config, "agent", "models.json"), path.join(source, "models.json"));
		let settings: Record<string, unknown> = {};
		try { settings = JSON.parse(fs.readFileSync(path.join(source, "settings.json"), "utf8")); } catch {}
		fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({
			defaultProvider: settings.defaultProvider, defaultModel: settings.defaultModel,
		}), { mode: 0o600 });
	}
	if (provider === "claude") {
		fs.writeFileSync(path.join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 });
		fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
		fs.writeFileSync(path.join(home, ".claude/settings.json"), JSON.stringify({
			hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "node /delegate/child-claude.mjs", timeout: 86400 }] }] },
		}), { mode: 0o600 });
	}
	if (provider === "commandcode") {
		const mods = path.join(home, ".commandcode/mods");
		fs.mkdirSync(mods, { recursive: true });
		fs.copyFileSync(path.join(ROOT, "bridge/child-commandcode.ts"), path.join(mods, "delegate-child.ts"));
	}
	fs.writeFileSync(path.join(path.dirname(home), CREDENTIALS_FILE), JSON.stringify(credentials), { mode: 0o600 });
}

export interface WorkspaceMounts {
	project: string;
	layout: ScopeLayout;
	scratch: string[];
	git: GitMounts;
}

const depth = (rel: string) => rel === "." ? 0 : rel.split("/").length;

function workspaceArgs(mounts: WorkspaceMounts): string[] {
	const { parents, siblings, folders } = mounts.layout;
	const binds: Array<[string, string]> = [
		...parents.map(rel => [rel, "--bind"] as [string, string]),
		...siblings.map(rel => [rel, "--ro-bind"] as [string, string]),
		...folders.map(rel => [rel, "--bind"] as [string, string]),
	].sort((a, b) => depth(a[0]) - depth(b[0]));
	const args = ["--ro-bind", mounts.project, "/workspace"];
	for (const [rel, kind] of binds) args.push(kind, path.join(mounts.project, rel), path.join("/workspace", rel));
	for (const rel of mounts.git.inside) args.push("--ro-bind", path.join(mounts.project, rel), path.join("/workspace", rel));
	for (const dir of mounts.git.outside) args.push("--ro-bind", dir, dir);
	for (const rel of mounts.scratch) args.push("--tmpfs", path.join("/workspace", rel));
	args.push("--chdir", "/workspace");
	return args;
}

function protectRuntime(args: string[], project: string): void {
	const seen = new Set<string>();
	const bind = (source: string, target: string): void => {
		const key = `${source}\0${target}`;
		if (seen.has(key)) return;
		seen.add(key);
		args.push("--ro-bind", source, target);
	};
	const pkg = realPath(process.env.DELEGATE_PI_PACKAGE_DIR);
	const entry = realPath(process.env.DELEGATE_PI_ENTRY);
	if (pkg) bind(pkg, PI_PACKAGE_MOUNT);
	if (entry && (!pkg || !entry.startsWith(pkg + "/"))) bind(entry, PI_ENTRY_MOUNT);
	for (const asset of [RUNTIME, entry, realPath(TASKS), realPath(PROJECTS)]) {
		if (!asset || asset === project) continue;
		if (asset.startsWith(project + "/")) bind(asset, path.join("/workspace", path.relative(project, asset)));
	}
}

const SYSTEM_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];
const PROVIDER_KEYS: Record<ProviderId, string[]> = {
	pi: ["ZAI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "DEEPSEEK_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY", "XAI_API_KEY", "CEREBRAS_API_KEY"],
	claude: ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"],
	codex: ["OPENAI_API_KEY"],
	commandcode: ["COMMANDCODE_API_KEY"],
};

function under(child: string, parent: string): boolean {
	return child === parent || child.startsWith(parent === "/" ? "/" : parent + "/");
}

function tooBroad(dir: string): boolean {
	const broad = [HOME, path.dirname(HOME), "/", "/home", "/opt", "/srv", "/var", "/tmp", ...[".local", ".config", ".cache", ".local/share", ".local/state", ".local/lib"].map(rel => path.join(HOME, rel))];
	if (broad.includes(dir)) return true;
	const secrets = [...secretFolders(), path.join(HOME, ".netrc"), path.join(HOME, ".git-credentials")];
	return [...secrets, DATA, TASKS, PROJECTS].some(secret => under(secret, dir));
}

function secretFolders(): string[] {
	return [".ssh", ".gnupg", ".claude", ".codex", ".commandcode", ".pi", piConfigDir(), ".aws", ".docker", ".kube"].map(rel => path.join(HOME, rel));
}

export function toolMount(file: string): string | undefined {
	if (!path.isAbsolute(file) || SYSTEM_DIRS.some(dir => under(file, dir))) return undefined;
	if ([...secretFolders(), DATA].some(secret => under(file, secret))) return undefined;
	const dir = path.dirname(file);
	const prefix = path.basename(dir) === "bin" ? path.dirname(dir) : dir;
	for (const candidate of [prefix, dir]) if (!tooBroad(candidate)) return candidate;
	return file;
}

export function passEnvNames(provider: ProviderId, fixed: Record<string, string>): string[] {
	const extra = (process.env.DELEGATE_PASS_ENV ?? "").split(/[\s,]+/).filter(name => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
	return [...new Set([...PROVIDER_KEYS[provider], ...extra])].filter(name => !(name in fixed) && !name.startsWith("DELEGATE_"));
}

export function sandboxInvocation(invocation: Invocation, mounts: WorkspaceMounts, taskDir: string, provider: ProviderId, mode: string): Invocation & { env: Record<string, string> } {
	const bwrap = executable("bwrap");
	const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--cap-drop", "ALL"];
	for (const dir of ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"]) {
		if (fs.existsSync(dir)) args.push("--ro-bind", dir, dir);
	}
	args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/run");
	for (const dir of ["/run/systemd/resolve"]) if (fs.existsSync(dir)) args.push("--ro-bind", dir, dir);
	args.push("--bind", path.join(taskDir, "home"), HOME);
	const tools = provider === "pi"
		? [`${piConfigDir()}/agent/install`, `${piConfigDir()}/agent/bin`]
		: provider === "claude"
			? [".local/share/claude/versions", ".local/bin/claude"]
			: [".npm-global"];
	for (const rel of tools) {
		const target = path.join(HOME, rel);
		if (fs.existsSync(target)) args.push("--ro-bind", fs.realpathSync(target), target);
	}
	const command = invocation.command.includes("/") ? invocation.command : resolveOnPath(invocation.command) ?? invocation.command;
	const binDirs: string[] = [];
	const mounted = new Set<string>();
	for (const file of [command, process.execPath]) {
		if (!path.isAbsolute(file)) continue;
		binDirs.push(path.dirname(file));
		for (const target of [file, realPath(file)]) {
			const mount = target ? toolMount(target) : undefined;
			if (!mount || mounted.has(mount) || under(mount, mounts.project) || under(mounts.project, mount)) continue;
			mounted.add(mount);
			args.push("--ro-bind", mount, mount);
		}
	}
	args.push("--ro-bind", path.join(ROOT, "bridge"), "/delegate");
	args.push("--ro-bind", path.join(taskDir, "ipc"), "/delegate-ipc");
	args.push(...workspaceArgs(mounts));
	protectRuntime(args, mounts.project);
	const jiti = provider === "pi" ? piDependencyDir() : undefined;
	if (jiti) args.push("--ro-bind", jiti, path.join(PI_DEPS_MOUNT, "node_modules/jiti"));
	let childArgs = invocation.args;
	const entry = mountedPiEntry();
	if (provider === "pi" && entry && childArgs[0] === process.env.DELEGATE_PI_ENTRY?.trim()) {
		childArgs = [entry, ...childArgs.slice(1)];
	}
	const env: Record<string, string> = {
		HOME,
		USER: os.userInfo().username,
		PATH: [...new Set([...binDirs, `${HOME}/${piConfigDir()}/agent/bin`, `${HOME}/.local/bin`, `${HOME}/.npm-global/bin`, "/usr/local/bin", "/usr/bin", "/bin"])].join(":"),
		LANG: "C.UTF-8",
		TERM: "dumb",
		TMPDIR: "/tmp",
		DELEGATE_DEPTH: "1",
		DELEGATE_PERMISSION_MODE: mode,
		DELEGATE_SOCKET: "/delegate-ipc/control.sock",
		DISABLE_AUTOUPDATER: "1",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		GIT_CONFIG_NOSYSTEM: "1",
	};
	if (provider === "pi") env.DELEGATE_PI_CODING_AGENT_DIR = path.join(HOME, piConfigDir(), "agent");
	if (jiti) env.NODE_PATH = path.join(PI_DEPS_MOUNT, "node_modules");
	for (const key of passEnvNames(provider, env)) if (process.env[key]) env[key] = process.env[key]!;
	return { command: bwrap, args: [...args, "--", command, ...childArgs], env };
}
