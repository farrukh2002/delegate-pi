import { setKeybindings, visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function makeSession(id: string): SessionInfo {
	return {
		path: `/tmp/${id}.jsonl`,
		id,
		cwd: "",
		created: new Date(0),
		modified: new Date(0),
		messageCount: 1,
		firstMessage: "hello",
		allMessagesText: "hello",
	};
}

async function createSelector(): Promise<SessionSelectorComponent> {
	const sessions = [makeSession("a")];
	const selector = new SessionSelectorComponent(
		async () => sessions,
		async () => sessions,
		() => {},
		() => {},
		() => {},
		() => {},
		{ keybindings: new KeybindingsManager() },
	);
	await new Promise<void>((resolve) => setImmediate(resolve));
	return selector;
}

function headerLines(selector: SessionSelectorComponent, width: number): string[] {
	return selector.render(width).map((line) => stripAnsi(line));
}

describe("session selector header", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("names the scope once, in the scope switch only", async () => {
		const text = headerLines(await createSelector(), 100).join("\n");

		expect(text).toContain("Resume Session");
		expect(text).not.toContain("Resume Session (");
		expect(text.match(/Current Folder/g)).toHaveLength(1);
		expect(text).toContain("◉ Current Folder | ○ All");
	});

	it("keeps title and controls on one row when they fit", async () => {
		const lines = headerLines(await createSelector(), 80);
		const row = lines.find((line) => line.includes("Resume Session"));

		expect(row).toContain("Name: All");
		expect(row).toContain("Sort: Threaded");
	});

	it("moves the controls to their own row instead of cutting the sort label", async () => {
		const lines = headerLines(await createSelector(), 60);
		const titleRow = lines.findIndex((line) => line.includes("Resume Session"));

		expect(lines[titleRow]).not.toContain("Sort:");
		expect(lines[titleRow + 1]).toContain("◉ Current Folder | ○ All");
		expect(lines[titleRow + 1]).toContain("Name: All");
		expect(lines[titleRow + 1]).toContain("Sort: Threaded");
	});

	it("shortens the folder label when the controls do not fit in a narrow terminal", async () => {
		const lines = headerLines(await createSelector(), 46);
		const text = lines.join("\n");

		expect(text).toContain("Resume Session");
		expect(text).toContain("◉ Folder | ○ All");
		expect(text).toContain("Name: All");
		expect(text).toContain("Sort: Threaded");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(46);
	});
});
