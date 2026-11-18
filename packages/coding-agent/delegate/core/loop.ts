/**
 * A child-side loop guard: repeated tool calls with no file change are a stuck child, not work.
 *
 * The guard steers once at the first threshold (the provider must support steering), then stops
 * the child at the second. A file change clears the evidence: editing between repeated test runs
 * is progress, not a loop.
 */
export type LoopVerdict =
	| { action: "none" }
	| { action: "steer" | "stop"; count: number; message: string };

export interface LoopOptions {
	steerAt?: number;
	stopAt?: number;
	window?: number;
}

function orderedJson(value: unknown): string {
	return JSON.stringify(value, (_key, item) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: item,
	);
}

export function createLoopGuard(options: LoopOptions = {}) {
	const steerAt = options.steerAt ?? 3;
	const stopAt = options.stopAt ?? 5;
	const window = options.window ?? 20;
	let recent: string[] = [];
	const steered = new Set<string>();
	const seenIds = new Set<string>();

	const label = (name: string, args: Record<string, unknown>) => {
		const command = typeof args?.command === "string" ? `: ${args.command.slice(0, 120)}` : "";
		return `${name || "tool"}${command}`;
	};

	return {
		observe(name: string, args: Record<string, unknown>, id?: string): LoopVerdict {
			if (id) {
				if (seenIds.has(id)) return { action: "none" };
				seenIds.add(id);
			}
			const fingerprint = `${name || "tool"}\0${orderedJson(args)}`;
			recent.push(fingerprint);
			if (recent.length > window) recent.shift();
			const count = recent.filter((item) => item === fingerprint).length;
			if (count >= stopAt) {
				return {
					action: "stop",
					count,
					message: `Loop detected: the child repeated ${label(name, args)} ${count} times without changing files. Its changes stay in the project; continue with a new child after accept.`,
				};
			}
			if (count >= steerAt && !steered.has(fingerprint)) {
				steered.add(fingerprint);
				return {
					action: "steer",
					count,
					message: `The parent guard saw ${label(name, args)} repeated ${count} times with no file change. Change approach, ask the parent user, or stop and report BLOCKED. Do not repeat it again.`,
				};
			}
			return { action: "none" };
		},
		progress() {
			recent = [];
			steered.clear();
		},
	};
}

export type LoopGuard = ReturnType<typeof createLoopGuard>;
