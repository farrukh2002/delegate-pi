import { describe, expect, it, vi } from "vitest";
import { type AskUserInput, createAskExtension, createAskUserToolDefinition } from "../src/extensions/ask/index.ts";

interface DialogCall {
	kind: "select" | "input";
	question?: string;
	options?: string[];
	placeholder?: string;
	dialogOptions?: { signal?: AbortSignal; timeout?: number };
}

function makeCtx(
	options: {
		answer?: string | undefined;
		choice?: string;
		hasUI?: boolean;
		calls?: DialogCall[];
		confirm?: boolean;
		onSelect?: () => void;
	} = {},
) {
	const hasUI = options.hasUI ?? true;
	const calls = options.calls ?? [];
	return {
		cwd: "/tmp/project",
		hasUI,
		ui: {
			select: async (
				question: string,
				choices: string[],
				dialogOptions?: { signal?: AbortSignal; timeout?: number },
			) => {
				calls.push({ kind: "select", question, options: choices, dialogOptions });
				options.onSelect?.();
				return options.choice ?? options.answer;
			},
			input: async (
				question: string,
				placeholder?: string,
				dialogOptions?: { signal?: AbortSignal; timeout?: number },
			) => {
				calls.push({ kind: "input", question, placeholder, dialogOptions });
				return options.answer;
			},
			confirm: async () => options.confirm ?? true,
			notify: () => {},
		},
	} as never;
}

function run(input: Partial<AskUserInput>, ctx: unknown, signal?: AbortSignal) {
	return createAskUserToolDefinition().execute("id", input as AskUserInput, signal, undefined, ctx as never);
}

function text(result: { content: { type: string; text?: string }[] }): string {
	return result.content.map((block) => block.text ?? "").join("");
}

describe("ask_user tool", () => {
	it("returns the user's free-text answer", async () => {
		const calls: DialogCall[] = [];
		const ctx = makeCtx({ answer: "  use option B  ", calls });
		const result = await run({ question: "Which database?" }, ctx);
		expect(text(result)).toBe("The user answered: use option B");
		expect(calls).toHaveLength(1);
		expect(calls[0].kind).toBe("input");
		expect(calls[0].question).toBe("Which database?");
		expect(result.details).toEqual({ asked: true, answer: "use option B" });
	});

	it("shows a selector when options are given", async () => {
		const calls: DialogCall[] = [];
		const ctx = makeCtx({ answer: "Postgres", calls });
		const result = await run({ question: "Which database?", options: ["SQLite", "Postgres"] }, ctx);
		expect(calls).toHaveLength(1);
		expect(calls[0].kind).toBe("select");
		expect(calls[0].options).toEqual(["SQLite", "Postgres", "Other — type your answer"]);
		expect(text(result)).toBe("The user answered: Postgres");
	});

	it("returns a typed answer after the user selects Other", async () => {
		const calls: DialogCall[] = [];
		const result = await run(
			{ question: "Which database?", options: ["SQLite", "Postgres"], placeholder: "Database name" },
			makeCtx({ choice: "Other — type your answer", answer: "  MariaDB  ", calls }),
		);
		expect(calls.map((call) => call.kind)).toEqual(["select", "input"]);
		expect(calls[1].question).toBe("Which database?");
		expect(calls[1].placeholder).toBe("Database name");
		expect(text(result)).toBe("The user answered: MariaDB");
		expect(result.details).toEqual({ asked: true, answer: "MariaDB" });
	});

	it("does not confuse a supplied option with the typed-answer control", async () => {
		const calls: DialogCall[] = [];
		const supplied = ["Other — type your answer", "Postgres"];
		const result = await run(
			{ question: "Which database?", options: supplied },
			makeCtx({ answer: supplied[0], calls }),
		);
		expect(calls).toHaveLength(1);
		expect(new Set(calls[0].options).size).toBe(3);
		expect(supplied).toEqual(["Other — type your answer", "Postgres"]);
		expect(result.details).toEqual({ asked: true, answer: supplied[0] });
	});

	it.each([undefined, "   "])("reports a dismissed typed answer: %s", async (answer) => {
		const calls: DialogCall[] = [];
		const result = await run(
			{ question: "Which database?", options: ["SQLite", "Postgres"] },
			makeCtx({ choice: "Other — type your answer", answer, calls }),
		);
		expect(calls.map((call) => call.kind)).toEqual(["select", "input"]);
		expect(result.details).toEqual({ asked: true, dismissed: true });
		expect(text(result)).not.toContain("The user answered:");
	});

	it("does not open input when the choice list is dismissed", async () => {
		const calls: DialogCall[] = [];
		const result = await run({ question: "Which database?", options: ["SQLite", "Postgres"] }, makeCtx({ calls }));
		expect(calls.map((call) => call.kind)).toEqual(["select"]);
		expect(result.details).toEqual({ asked: true, dismissed: true });
	});

	it("uses free text when the options list is empty", async () => {
		const calls: DialogCall[] = [];
		await run({ question: "Name?", options: [] }, makeCtx({ answer: "db", calls }));
		expect(calls.map((call) => call.kind)).toEqual(["input"]);
	});

	it("keeps the original timeout and signal when switching to a typed answer", async () => {
		const calls: DialogCall[] = [];
		const controller = new AbortController();
		const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
		try {
			await run(
				{ question: "Which database?", options: ["SQLite", "Postgres"], timeoutMs: 5000 },
				makeCtx({
					choice: "Other — type your answer",
					answer: "MariaDB",
					calls,
					onSelect: () => clock.mockReturnValue(2500),
				}),
				controller.signal,
			);
			expect(calls[0].dialogOptions?.timeout).toBe(5000);
			expect(calls[1].dialogOptions?.timeout).toBe(3500);
			expect(calls[1].dialogOptions?.signal).toBe(controller.signal);
		} finally {
			clock.mockRestore();
		}
	});

	it("does not open input after the question deadline", async () => {
		const calls: DialogCall[] = [];
		const clock = vi.spyOn(Date, "now").mockReturnValue(1000);
		try {
			const result = await run(
				{ question: "Which database?", options: ["SQLite", "Postgres"], timeoutMs: 5000 },
				makeCtx({ choice: "Other — type your answer", calls, onSelect: () => clock.mockReturnValue(6000) }),
			);
			expect(calls.map((call) => call.kind)).toEqual(["select"]);
			expect(result.details).toEqual({ asked: true, dismissed: true });
		} finally {
			clock.mockRestore();
		}
	});

	it("does not open input after cancellation during selection", async () => {
		const calls: DialogCall[] = [];
		const controller = new AbortController();
		const result = await run(
			{ question: "Which database?", options: ["SQLite", "Postgres"] },
			makeCtx({ choice: "Other — type your answer", calls, onSelect: () => controller.abort() }),
			controller.signal,
		);
		expect(calls.map((call) => call.kind)).toEqual(["select"]);
		expect(text(result)).toBe("Cancelled.");
	});

	it("tells the model to use ask_user instead of a question in chat", () => {
		const definition = createAskUserToolDefinition();
		expect(definition.promptGuidelines?.join(" ")).toContain("instead of asking in a normal chat reply");
		expect(definition.description).toContain("Other");
	});

	it("passes placeholder and timeout to the dialog", async () => {
		const calls: DialogCall[] = [];
		const ctx = makeCtx({ answer: "db-name", calls });
		await run({ question: "Name?", placeholder: "my-db", timeoutMs: 5000 }, ctx);
		expect(calls[0].placeholder).toBe("my-db");
		expect(calls[0].dialogOptions?.timeout).toBe(5000);
	});

	it("treats timeoutMs of 0 as no timeout", async () => {
		const calls: DialogCall[] = [];
		const ctx = makeCtx({ answer: "x", calls });
		await run({ question: "Name?", timeoutMs: 0 }, ctx);
		expect(calls[0].dialogOptions?.timeout).toBeUndefined();
	});

	it("reports a dismissed question", async () => {
		const ctx = makeCtx({ answer: undefined });
		const result = await run({ question: "Continue?" }, ctx);
		expect(text(result)).toContain("dismissed");
		expect(result.details).toEqual({ asked: true, dismissed: true });
	});

	it("reports an empty answer as dismissed", async () => {
		const ctx = makeCtx({ answer: "   " });
		const result = await run({ question: "Continue?" }, ctx);
		expect(text(result)).toContain("dismissed");
	});

	it("degrades without a UI and does not open a dialog", async () => {
		const calls: DialogCall[] = [];
		const ctx = makeCtx({ answer: "x", hasUI: false, calls });
		const result = await run({ question: "Continue?" }, ctx);
		expect(text(result)).toContain("No interactive user");
		expect(result.details).toEqual({ asked: false });
		expect(calls).toHaveLength(0);
	});

	it("reports cancellation when the run is aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const ctx = makeCtx({ answer: "ignored" });
		const result = await run({ question: "Continue?" }, ctx, controller.signal);
		expect(text(result)).toBe("Cancelled.");
		expect(result.details).toEqual({ asked: true, dismissed: true });
	});
});

describe("ask extension registration", () => {
	const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
		const saved: Record<string, string | undefined> = {};
		for (const key of Object.keys(env)) {
			saved[key] = process.env[key];
			if (env[key] === undefined) delete process.env[key];
			else process.env[key] = env[key];
		}
		try {
			fn();
		} finally {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	};

	it("registers the tool in a normal session", () => {
		withEnv({ DELEGATE_DATA: undefined, DELEGATE_PI_ENTRY: undefined }, () => {
			const registered: string[] = [];
			createAskExtension()({ registerTool: (tool: { name: string }) => registered.push(tool.name) } as never);
			expect(registered).toEqual(["ask_user"]);
		});
	});

	it("does not register the tool inside delegate children", () => {
		withEnv({ DELEGATE_DATA: "/tmp/delegate-data" }, () => {
			const registered: string[] = [];
			createAskExtension()({ registerTool: (tool: { name: string }) => registered.push(tool.name) } as never);
			expect(registered).toEqual([]);
		});
	});
});
