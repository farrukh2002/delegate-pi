import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { arch } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImageResizeOptions, ResizedImage } from "./image-resize-types.ts";

const BINARY_NAME = "pi-image-resize";
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const TIMEOUT_MS = 120_000;

interface NativeReply {
	ok: boolean;
	error?: string;
	result?: {
		mimeType: string;
		originalWidth: number;
		originalHeight: number;
		width: number;
		height: number;
		wasResized: boolean;
		bytes: number;
	};
}

let cachedBinary: string | null | undefined;

function candidateDirs(): string[] {
	const moduleDir = dirname(fileURLToPath(import.meta.url));
	const dirs = [moduleDir];
	for (let depth = 1; depth <= 3; depth += 1) {
		let current = moduleDir;
		for (let step = 0; step < depth; step += 1) current = dirname(current);
		dirs.push(current);
	}
	return dirs;
}

function candidates(): string[] {
	const names = [`${BINARY_NAME}-${arch()}`, BINARY_NAME];
	const list: string[] = [];
	const override = process.env.PI_IMAGE_RESIZE_BIN?.trim();
	if (override) list.push(override);

	const executableDir = dirname(process.execPath);
	for (const name of names) list.push(join(executableDir, name));

	for (const dir of candidateDirs()) {
		for (const name of names) {
			list.push(join(dir, "bin", name));
			list.push(join(dir, "dist", "bin", name));
			// Development checkout: packages/coding-agent/{src,dist}/..., crate at packages/image-resize-rs.
			list.push(join(dir, "image-resize-rs", "target", "release", BINARY_NAME));
			list.push(join(dir, "..", "image-resize-rs", "target", "release", BINARY_NAME));
		}
	}
	return list;
}

function resolveBinary(): string | null {
	if (cachedBinary !== undefined) return cachedBinary;
	for (const candidate of candidates()) {
		try {
			if (existsSync(candidate)) {
				cachedBinary = candidate;
				return candidate;
			}
		} catch {}
	}
	cachedBinary = null;
	return null;
}

interface RunResult {
	reply: NativeReply;
	body: Buffer;
}

function header(bytes: Uint8Array, mimeType: string, options?: ImageResizeOptions): string {
	return JSON.stringify({
		maxWidth: options?.maxWidth,
		maxHeight: options?.maxHeight,
		maxBytes: options?.maxBytes,
		jpegQuality: options?.jpegQuality,
		mimeType,
		bytes: bytes.byteLength,
	});
}

function run(
	binary: string,
	bytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
	mode = "resize",
): Promise<RunResult> {
	const line = header(bytes, mimeType, options);
	return new Promise((resolve, reject) => {
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(binary, [mode], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
		} catch (error) {
			reject(error);
			return;
		}
		const chunks: Buffer[] = [];
		let size = 0;
		let settled = false;
		const finish = (error: Error | undefined, value?: RunResult): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else if (value) resolve(value);
		};
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish(new Error("image resize helper timed out"));
		}, TIMEOUT_MS);
		timer.unref?.();

		child.stdout.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_OUTPUT_BYTES) {
				child.kill("SIGKILL");
				finish(new Error("image resize helper produced too much output"));
				return;
			}
			chunks.push(chunk);
		});
		child.stderr.resume();
		child.once("error", (error) => finish(error));
		child.once("close", (code) => {
			if (settled) return;
			const output = Buffer.concat(chunks);
			const newline = output.indexOf(0x0a);
			if (newline < 0) {
				finish(new Error(`image resize helper exited with code ${code}`));
				return;
			}
			let reply: NativeReply;
			try {
				reply = JSON.parse(output.subarray(0, newline).toString("utf8")) as NativeReply;
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			finish(undefined, { reply, body: output.subarray(newline + 1) });
		});
		child.stdin.on("error", () => {});
		child.stdin.write(`${line}\n`);
		child.stdin.end(bytes);
	});
}

/**
 * Resize through the packaged Rust helper.
 *
 * Returns `undefined` when the helper is not installed, so the caller can use the
 * in-process fallback. Returns `null` when the helper ran but the image cannot be
 * resized, which matches the previous behaviour.
 */
export async function resizeImageNative(
	bytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null | undefined> {
	const binary = resolveBinary();
	if (!binary) return undefined;

	let result: RunResult;
	try {
		result = await run(binary, bytes, mimeType, options);
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "EACCES") {
			cachedBinary = null;
			return undefined;
		}
		return null;
	}

	const { reply, body } = result;
	if (!reply.ok || !reply.result) return null;
	if (reply.result.bytes !== body.length) return null;

	return {
		data: body.toString("base64"),
		mimeType: reply.result.mimeType,
		originalWidth: reply.result.originalWidth,
		originalHeight: reply.result.originalHeight,
		width: reply.result.width,
		height: reply.result.height,
		wasResized: reply.result.wasResized,
	};
}

/** True when a usable helper binary exists on this machine. */
export function hasImageHelper(): boolean {
	return resolveBinary() !== null;
}

/**
 * Convert any supported image format to PNG for terminals and clipboards that
 * accept only PNG. Returns null when the helper is missing or cannot decode.
 */
export async function transcodeImageNative(bytes: Uint8Array, mimeType: string): Promise<Uint8Array | null> {
	const binary = resolveBinary();
	if (!binary) return null;
	try {
		const { reply, body } = await run(binary, bytes, mimeType, undefined, "transcode");
		if (!reply.ok || !reply.result) return null;
		if (reply.result.bytes !== body.length) return null;
		return new Uint8Array(body);
	} catch {
		return null;
	}
}

/** Synchronous variant for renderers that cannot await. */
export function transcodeImageNativeSync(bytes: Uint8Array): Uint8Array | null {
	const binary = resolveBinary();
	if (!binary) return null;
	const result = spawnSync(binary, ["transcode"], {
		input: Buffer.concat([Buffer.from(`${header(bytes, "", undefined)}\n`, "utf8"), bytes]),
		maxBuffer: MAX_OUTPUT_BYTES,
		timeout: TIMEOUT_MS,
	});
	if (result.error || result.status !== 0 || !result.stdout) return null;
	const newline = result.stdout.indexOf(0x0a);
	if (newline < 0) return null;
	let reply: NativeReply;
	try {
		reply = JSON.parse(result.stdout.subarray(0, newline).toString("utf8")) as NativeReply;
	} catch {
		return null;
	}
	const body = result.stdout.subarray(newline + 1);
	if (!reply.ok || !reply.result || reply.result.bytes !== body.length) return null;
	return new Uint8Array(body);
}

/** Test hook: forget the cached helper path. */
export function resetImageResizeNativeCache(): void {
	cachedBinary = undefined;
}
