import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dataDir, HEARTBEAT_STALE_MS, STOPPED } from "./view.ts";

export { HEARTBEAT_STALE_MS };

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
	return dataDir({ ...env, DELEGATE_DATA: undefined }, os.homedir());
}

export const DATA = dataDir(process.env, os.homedir());
export const TASKS = path.join(DATA, "tasks");
export const PROJECTS = path.join(DATA, "projects");
const DEFAULT_SCRATCH = [".cache", "coverage", "node_modules/.cache"];
const GIT_ENV = {
	GIT_LITERAL_PATHSPECS: "1",
	GIT_AUTHOR_NAME: "delegate",
	GIT_AUTHOR_EMAIL: "delegate@localhost",
	GIT_COMMITTER_NAME: "delegate",
	GIT_COMMITTER_EMAIL: "delegate@localhost",
};

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const TERMINAL_STATES = new Set(STOPPED);

export function pidAlive(pid: number): boolean {
	try { process.kill(pid, 0); return true; } catch { return false; }
}

export function workerGone(state: any): boolean {
	if (TERMINAL_STATES.has(state.status)) return false;
	if (typeof state.heartbeat === "number" && Date.now() - state.heartbeat < HEARTBEAT_STALE_MS) return false;
	if (typeof state.workerPid === "number") return !pidAlive(state.workerPid);
	if (typeof state.createdAt === "number") return Date.now() - state.createdAt >= HEARTBEAT_STALE_MS;
	return false;
}

export function markWorkerGone(file: string, state: any): void {
	state.status = "failed";
	state.summary = "Task supervisor stopped. The changes stay in the project. Use diff, then accept or undo.";
	state.pending = [];
	const temp = `${file}.${randomUUID()}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
	fs.renameSync(temp, file);
}

function holderStale(held: any): boolean {
	if (typeof held?.taskDir !== "string") return true;
	const file = path.join(held.taskDir, "state.json");
	if (!fs.existsSync(file)) return true;
	let state: any;
	try { state = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return true; }
	return TERMINAL_STATES.has(state.status) || workerGone(state);
}

export function git(cwd: string, args: string[], env: Record<string, string> = {}, input?: string): string {
	return execFileSync("git", ["-C", cwd, ...args], {
		encoding: "utf8",
		input,
		stdio: ["pipe", "pipe", "pipe"],
		env: { ...process.env, ...GIT_ENV, ...env },
		maxBuffer: 256 * 1024 * 1024,
		timeout: 120000,
	}).trim();
}

function tryGit(cwd: string, args: string[]): string | undefined {
	try { return git(cwd, args); } catch { return undefined; }
}

function inside(root: string, target: string): boolean {
	return target === root || target.startsWith(root + "/");
}

function isDirectory(full: string): boolean {
	try { return fs.statSync(full).isDirectory(); } catch { return false; }
}

function relativePath(cwd: string, raw: unknown, label: string): string {
	if (typeof raw !== "string" || !raw.trim() || raw.length > 1024 || raw.includes("\0")) throw new Error(`Invalid ${label} path`);
	if (path.isAbsolute(raw)) throw new Error(`${label} paths must be relative to the project: ${raw}`);
	const target = path.resolve(cwd, raw);
	const missing: string[] = [];
	let probe = target;
	while (!fs.existsSync(probe)) {
		missing.unshift(path.basename(probe));
		probe = path.dirname(probe);
	}
	if (missing.length && !isDirectory(probe)) throw new Error(`Invalid ${label} path: ${raw}`);
	const real = path.resolve(fs.realpathSync(probe), ...missing);
	if (!inside(cwd, real)) throw new Error(`${label} path leaves the project: ${raw}`);
	return path.relative(cwd, real) || ".";
}

export function overlaps(a: string, b: string): boolean {
	return a === "." || b === "." || a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
}

export function normalizeScope(cwd: string, value: unknown): string[] {
	if (value === undefined || value === null) return [];
	const list = typeof value === "string" ? value.split(",") : value;
	if (!Array.isArray(list) || list.length > 64) throw new Error("scope must be a list of at most 64 paths");
	const paths = [...new Set(list.map(item => relativePath(cwd, typeof item === "string" ? item.trim() : item, "scope")))];
	for (const rel of paths) {
		if (rel === ".git" || rel.startsWith(".git/")) throw new Error("scope cannot contain .git");
	}
	if (paths.includes(".")) return ["."];
	return paths.filter(rel => !paths.some(other => other !== rel && rel.startsWith(other + "/"))).sort();
}

export function prepareScope(cwd: string, scope: string[]): void {
	for (const rel of scope) {
		if (rel === ".") continue;
		const full = path.join(cwd, rel);
		if (!fs.existsSync(full)) fs.mkdirSync(path.dirname(full), { recursive: true });
	}
}

export interface ScopeLayout {
	parents: string[];
	siblings: string[];
	folders: string[];
}

export function scopeLayout(cwd: string, scope: string[]): ScopeLayout {
	if (scope.includes(".")) return { parents: [], siblings: [], folders: ["."] };
	const folders = scope.filter(rel => isDirectory(path.join(cwd, rel)));
	const files = scope.filter(rel => !folders.includes(rel));
	const parents = [...new Set(files.map(rel => path.dirname(rel)))].sort((a, b) => a.split("/").length - b.split("/").length);
	const siblings: string[] = [];
	for (const parent of parents) {
		for (const name of fs.readdirSync(path.join(cwd, parent))) {
			const rel = parent === "." ? name : `${parent}/${name}`;
			if (!files.includes(rel) && !folders.includes(rel) && !parents.includes(rel)) siblings.push(rel);
		}
	}
	return { parents, siblings, folders };
}

export function listParents(cwd: string, layout: ScopeLayout): Record<string, string[]> {
	return Object.fromEntries(layout.parents.map(parent => [parent, fs.readdirSync(path.join(cwd, parent))]));
}

export function strayFiles(cwd: string, scope: string[], before: Record<string, string[]>, taskId?: string): string[] {
	const claims = taskId === undefined ? [] : listClaims(cwd);
	const held: { taskId: string; scope: string[] }[] = [];
	if (taskId !== undefined) {
		const dir = path.join(projectDir(cwd), "scopes");
		let names: string[] = [];
		try { names = fs.readdirSync(dir); } catch {}
		for (const name of names) {
			let entry: { taskId?: string; scope?: string[] };
			try { entry = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8")); } catch { continue; }
			if (entry.taskId && entry.taskId !== taskId && Array.isArray(entry.scope)) held.push({ taskId: entry.taskId, scope: entry.scope });
		}
	}
	const stray: string[] = [];
	for (const [parent, names] of Object.entries(before)) {
		let now: string[];
		try { now = fs.readdirSync(path.join(cwd, parent)); } catch { continue; }
		for (const name of now) {
			const rel = parent === "." ? name : `${parent}/${name}`;
			if (names.includes(name) || scope.some(s => inside(s, rel))) continue;
			if (claims.some(claim => claim.path === rel && claim.taskId !== taskId)) continue;
			if (held.some(item => item.scope.some(s => inside(s, rel)))) continue;
			stray.push(rel);
		}
	}
	return stray.sort();
}

export function scratchPaths(cwd: string, scope: string[], extra: unknown): string[] {
	const wanted = [...DEFAULT_SCRATCH, ...(Array.isArray(extra) ? extra : [])];
	const result: string[] = [];
	for (const raw of wanted) {
		let rel: string;
		try { rel = relativePath(cwd, raw, "scratch"); } catch { continue; }
		if (rel === "." || rel === ".git" || rel.startsWith(".git/")) continue;
		if (!isDirectory(path.join(cwd, rel))) continue;
		if (scope.some(s => s === "." || inside(s, rel))) continue;
		if (!result.includes(rel)) result.push(rel);
	}
	return result;
}

export interface GitMounts {
	inside: string[];
	outside: string[];
}

export function gitMounts(cwd: string): GitMounts {
	const mounts: GitMounts = { inside: [], outside: [] };
	const gitDir = tryGit(cwd, ["rev-parse", "--absolute-git-dir"]);
	if (!gitDir) return mounts;
	const common = path.resolve(cwd, tryGit(cwd, ["rev-parse", "--git-common-dir"]) ?? gitDir);
	for (const dir of new Set([gitDir, common].map(dir => fs.realpathSync(dir)))) {
		if (inside(cwd, dir)) mounts.inside.push(path.relative(cwd, dir));
		else mounts.outside.push(dir);
	}
	const dotGit = path.join(cwd, ".git");
	if (fs.existsSync(dotGit) && !mounts.inside.includes(".git")) mounts.inside.push(".git");
	return mounts;
}

export function requireRepository(cwd: string): void {
	if (!tryGit(cwd, ["rev-parse", "--absolute-git-dir"])) throw new Error("A task with a write scope needs a git repository for its snapshot. Use git init, or give no scope for a read-only task.");
}

const MAX_IGNORED_FILES = 1000;
const MAX_IGNORED_BYTES = 1024 * 1024;
const PLAIN_PATHS = { GIT_LITERAL_PATHSPECS: "0" };

export function checkScopeTracked(cwd: string, scope: string[]): void {
	for (const rel of scope) {
		if (rel === ".") continue;
		try {
			const stat = fs.lstatSync(path.join(cwd, rel));
			if (stat.isFile() && stat.size <= MAX_IGNORED_BYTES) continue;
		} catch {}
		try {
			git(cwd, ["check-ignore", "-q", "--", rel], PLAIN_PATHS);
		} catch {
			continue;
		}
		throw new Error(`scope path is ignored by git, so undo cannot restore it: ${rel}`);
	}
}

export function ignoredPaths(cwd: string, scope: string[]): { files: string[]; skipped: string[] } {
	const present = scope.filter(rel => fs.existsSync(path.join(cwd, rel)));
	if (!present.length) return { files: [], skipped: [] };
	const entries = git(cwd, ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory", "--", ...present]).split("\0").filter(Boolean);
	const dirs = entries.filter(rel => rel.endsWith("/"));
	let ignoredDirs: string[] = [];
	if (dirs.length) {
		try { ignoredDirs = git(cwd, ["check-ignore", "-z", "--stdin"], PLAIN_PATHS, dirs.join("\0")).split("\0").filter(Boolean); } catch {}
	}
	const skipped = [...ignoredDirs];
	const files: string[] = [];
	for (const rel of entries) {
		if (rel.endsWith("/") || ignoredDirs.some(dir => rel.startsWith(dir))) continue;
		let stat: fs.Stats;
		try { stat = fs.lstatSync(path.join(cwd, rel)); } catch { continue; }
		if (stat.isFile() && stat.size > MAX_IGNORED_BYTES) skipped.push(rel);
		else files.push(rel);
	}
	if (files.length > MAX_IGNORED_FILES) return { files: [], skipped: [...skipped, ...files].sort() };
	return { files, skipped: skipped.sort() };
}

function refName(id: string, name: string): string {
	return `refs/delegate/${id}/${name}`;
}

export function snapshot(cwd: string, scope: string[], id: string, name: string, tempDir: string): string {
	const index = path.join(tempDir, `index-${name}-${process.pid}`);
	try {
		const realIndex = path.resolve(cwd, git(cwd, ["rev-parse", "--git-path", "index"]));
		const head = tryGit(cwd, ["rev-parse", "--verify", "-q", "HEAD"]);
		const env = { GIT_INDEX_FILE: index };
		if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, index);
		else if (head) git(cwd, ["read-tree", head], env);
		const present = scope.filter(rel => fs.existsSync(path.join(cwd, rel)));
		if (present.length) {
			git(cwd, ["add", "-A", "--", ...present], env);
			const { files } = ignoredPaths(cwd, present);
			if (files.length) git(cwd, ["add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"], env, files.join("\0"));
		}
		const tree = git(cwd, ["write-tree"], env);
		const commit = git(cwd, ["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", `delegate ${id} ${name}`]);
		git(cwd, ["update-ref", refName(id, name), commit]);
		return commit;
	} finally {
		fs.rmSync(index, { force: true });
	}
}

function hasRef(cwd: string, id: string, name: string): boolean {
	return tryGit(cwd, ["rev-parse", "--verify", "-q", refName(id, name)]) !== undefined;
}

function names(cwd: string, from: string, to: string, scope: string[], filter?: string): string[] {
	const args = ["diff", "--name-only", "-z", "--no-renames", "--relative", ...(filter ? [`--diff-filter=${filter}`] : []), from, to, "--", ...scope];
	return git(cwd, args).split("\0").filter(Boolean);
}

export function diffstat(cwd: string, id: string, scope: string[]): string {
	if (!hasRef(cwd, id, "before") || !hasRef(cwd, id, "after")) return "";
	return git(cwd, ["diff", "--stat", "--relative", refName(id, "before"), refName(id, "after"), "--", ...scope]).slice(0, 4000);
}

export function diff(cwd: string, id: string, scope: string[]): string {
	if (!hasRef(cwd, id, "before")) throw new Error("This task has no snapshot");
	const to = hasRef(cwd, id, "after") ? refName(id, "after") : undefined;
	return git(cwd, ["diff", "--relative", "--binary", refName(id, "before"), ...(to ? [to] : []), "--", ...scope]);
}

export function dropRefs(cwd: string, id: string): void {
	for (const name of ["before", "after", "now"]) tryGit(cwd, ["update-ref", "-d", refName(id, name)]);
}

function removeEmptyParents(cwd: string, files: string[], scope: string[]): void {
	const dirs = new Set<string>();
	for (const rel of files) {
		const root = scope.find(item => item === "." || rel === item || rel.startsWith(item + "/"));
		if (root === undefined) continue;
		for (let dir = path.dirname(rel); dir !== "." && dir !== root && (root === "." || dir.startsWith(root + "/")); dir = path.dirname(dir)) dirs.add(dir);
	}
	for (const dir of [...dirs].sort((a, b) => b.length - a.length)) {
		try { fs.rmdirSync(path.join(cwd, dir)); } catch {}
	}
}

export function undo(cwd: string, id: string, scope: string[], tempDir: string, force: boolean): string[] {
	if (!hasRef(cwd, id, "before")) throw new Error("This task has no snapshot to restore");
	const before = refName(id, "before");
	const now = refName(id, "now");
	snapshot(cwd, scope, id, "now", tempDir);
	try {
		if (hasRef(cwd, id, "after")) {
			const later = names(cwd, refName(id, "after"), now, scope);
			if (later.length && !force) throw new Error(`These files changed after the task stopped. Check them, then undo with --force: ${later.slice(0, 20).join(", ")}`);
		}
		const added = names(cwd, before, now, scope, "A");
		const restored = names(cwd, before, now, scope, "DMT");
		for (const rel of added) fs.rmSync(path.join(cwd, rel), { force: true });
		if (restored.length) {
			const index = path.join(tempDir, `index-undo-${process.pid}`);
			try {
				git(cwd, ["read-tree", before], { GIT_INDEX_FILE: index });
				git(cwd, ["checkout-index", "-f", "-z", "--stdin"], { GIT_INDEX_FILE: index }, restored.join("\0"));
			} finally {
				fs.rmSync(index, { force: true });
			}
		}
		removeEmptyParents(cwd, added, scope);
		dropRefs(cwd, id);
		return [...added, ...restored].sort();
	} finally {
		tryGit(cwd, ["update-ref", "-d", now]);
	}
}

function projectDir(cwd: string): string {
	const dir = path.join(PROJECTS, createHash("sha256").update(cwd).digest("hex").slice(0, 16));
	fs.mkdirSync(path.join(dir, "scopes"), { recursive: true, mode: 0o700 });
	const meta = path.join(dir, "project.json");
	if (!fs.existsSync(meta)) fs.writeFileSync(meta, JSON.stringify({ cwd }), { mode: 0o600 });
	return dir;
}

async function withMutex<T>(dir: string, fn: () => T): Promise<T> {
	const mutex = path.join(dir, ".mutex");
	for (let attempt = 0; ; attempt++) {
		try {
			fs.mkdirSync(mutex);
			break;
		} catch (error: any) {
			if (error.code !== "EEXIST") throw error;
			try { if (Date.now() - fs.statSync(mutex).mtimeMs > 10000) fs.rmdirSync(mutex); } catch {}
			if (attempt > 500) throw new Error("Scope registry is busy");
			await sleep(20);
		}
	}
	try { return fn(); } finally { fs.rmdirSync(mutex); }
}

export async function acquireScope(cwd: string, id: string, scope: string[], taskDir: string): Promise<string[]> {
	const dir = projectDir(cwd);
	return withMutex(dir, () => {
		const blocking: string[] = [];
		for (const name of fs.readdirSync(path.join(dir, "scopes"))) {
			const file = path.join(dir, "scopes", name);
			let held: any;
			try { held = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
			if (held.taskId === id) return [];
			const stateFile = path.join(held.taskDir, "state.json");
			if (!fs.existsSync(stateFile)) { fs.rmSync(file, { force: true }); continue; }
			let state: any;
			try { state = JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch {}
			if (state && workerGone(state)) {
				if (!state.snapshot) { fs.rmSync(file, { force: true }); continue; }
				markWorkerGone(stateFile, state);
			}
			if (held.scope.some((a: string) => scope.some(b => overlaps(a, b)))) blocking.push(held.taskId);
		}
		if (!blocking.length) fs.writeFileSync(path.join(dir, "scopes", `${id}.json`), JSON.stringify({ taskId: id, scope, taskDir, since: Date.now() }), { mode: 0o600 });
		return blocking;
	});
}

export function releaseScope(cwd: string, id: string): void {
	fs.rmSync(path.join(projectDir(cwd), "scopes", `${id}.json`), { force: true });
}

export async function acquireSlot(cwd: string, id: string, taskDir: string, max = 4): Promise<string[]> {
	const project = projectDir(cwd);
	return withMutex(project, () => {
		const dir = path.join(project, "slots");
		fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
		const holders: string[] = [];
		for (const name of fs.readdirSync(dir)) {
			const file = path.join(dir, name);
			let held: any;
			try { held = JSON.parse(fs.readFileSync(file, "utf8")); } catch { fs.rmSync(file, { force: true }); continue; }
			if (held.taskId === id) return [];
			if (holderStale(held)) { fs.rmSync(file, { force: true }); continue; }
			holders.push(held.taskId);
		}
		if (holders.length >= max) return holders;
		fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ taskId: id, taskDir, since: Date.now() }), { mode: 0o600 });
		return [];
	});
}

export function releaseSlot(cwd: string, id: string): void {
	fs.rmSync(path.join(projectDir(cwd), "slots", `${id}.json`), { force: true });
}

export interface Claim {
	path: string;
	taskId: string;
	agent: string;
	since: number;
	baseHash: string | null;
}

export interface ClaimOwner {
	path: string;
	taskId: string;
	agent: string;
}

function claimsDir(cwd: string): string {
	const dir = path.join(projectDir(cwd), "claims");
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

function claimFile(cwd: string, rel: string): string {
	return path.join(claimsDir(cwd), `${createHash("sha256").update(rel).digest("hex").slice(0, 16)}.json`);
}

function readClaim(file: string): Claim | undefined {
	let claim: Claim;
	try { claim = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return undefined; }
	if (!fs.existsSync(path.join(DATA, "tasks", claim.taskId, "state.json"))) {
		fs.rmSync(file, { force: true });
		return undefined;
	}
	return claim;
}

function baseHash(cwd: string, rel: string): string | null {
	if (!fs.existsSync(path.join(cwd, rel))) return null;
	return tryGit(cwd, ["hash-object", "--", rel]) ?? null;
}

export function claimPaths(cwd: string, taskId: string, agent: string, paths: string[]): ClaimOwner[] {
	const denied: ClaimOwner[] = [];
	for (const rel of paths) {
		const file = claimFile(cwd, rel);
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				fs.writeFileSync(file, JSON.stringify({ path: rel, taskId, agent, since: Date.now(), baseHash: baseHash(cwd, rel) }), { mode: 0o600, flag: "wx" });
				break;
			} catch (error: any) {
				if (error.code !== "EEXIST") throw error;
			}
			const held = readClaim(file);
			if (!held) continue;
			if (held.taskId !== taskId) denied.push({ path: rel, taskId: held.taskId, agent: held.agent });
			break;
		}
	}
	return denied;
}

export function releaseClaims(cwd: string, taskId: string, paths?: string[]): string[] {
	const released: string[] = [];
	if (paths) {
		for (const rel of paths) {
			const file = claimFile(cwd, rel);
			let held: Claim;
			try { held = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
			if (held.taskId !== taskId) continue;
			fs.rmSync(file, { force: true });
			released.push(rel);
		}
		return released;
	}
	const dir = claimsDir(cwd);
	for (const name of fs.readdirSync(dir)) {
		const file = path.join(dir, name);
		let held: Claim;
		try { held = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
		if (held.taskId !== taskId) continue;
		fs.rmSync(file, { force: true });
		released.push(held.path);
	}
	return released.sort();
}

export function claimNotes(cwd: string, taskId: string, paths: string[]): ClaimOwner[] {
	const notes: ClaimOwner[] = [];
	for (const rel of paths) {
		const held = readClaim(claimFile(cwd, rel));
		if (held && held.taskId !== taskId) notes.push({ path: rel, taskId: held.taskId, agent: held.agent });
	}
	return notes;
}

export function listClaims(cwd: string): Claim[] {
	const dir = claimsDir(cwd);
	const claims: Claim[] = [];
	for (const name of fs.readdirSync(dir)) {
		const held = readClaim(path.join(dir, name));
		if (held) claims.push(held);
	}
	return claims.sort((a, b) => a.path.localeCompare(b.path));
}

function projectPaths(raw: unknown): string[] {
	if (!Array.isArray(raw)) return [];
	const result: string[] = [];
	for (const item of raw.slice(0, 64)) {
		if (typeof item !== "string" || !item || item.length > 1024 || item.includes("\0")) continue;
		const rel = path.posix.relative("/workspace", path.posix.resolve("/workspace", item));
		if (!rel || rel === ".." || rel.startsWith("../")) continue;
		if (rel === ".git" || rel.startsWith(".git/")) continue;
		if (!result.includes(rel)) result.push(rel);
	}
	return result;
}

export function claimMessage(cwd: string, taskId: string, agent: string, message: any): any {
	const paths = projectPaths(message?.paths);
	if (message?.kind === "claim") return { denied: claimPaths(cwd, taskId, agent, paths) };
	if (message?.kind === "release") return { released: releaseClaims(cwd, taskId, paths) };
	if (message?.kind === "notify") return { notes: claimNotes(cwd, taskId, paths) };
	throw new Error("Invalid claim message");
}
