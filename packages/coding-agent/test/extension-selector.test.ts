import { setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function render(selector: ExtensionSelectorComponent): string {
	return stripAnsi(selector.render(80).join("\n"));
}

function visibleOptions(output: string): string[] {
	return output
		.split("\n")
		.filter((line) => line.includes("option-"))
		.map((line) =>
			line
				.trim()
				.replace(/^→ /, "")
				.replace(/^\d\. /, ""),
		);
}

function createSelector(options = ["SQLite", "Postgres", "Other — type your answer"]) {
	const onSelect = vi.fn();
	const onCancel = vi.fn();
	const selector = new ExtensionSelectorComponent("Which database?", options, onSelect, onCancel);
	return { selector, onSelect, onCancel };
}

describe("extension selector", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));
	afterEach(() => {
		vi.useRealTimers();
		setKeybindings(new KeybindingsManager());
	});

	it("shows numbered choices including the typed-answer entry", () => {
		const { selector } = createSelector();
		const output = stripAnsi(selector.render(80).join("\n"));
		expect(output).toContain("1. SQLite");
		expect(output).toContain("2. Postgres");
		expect(output).toContain("3. Other — type your answer");
	});

	it.each([1, 2, 3, 4, 5, 6, 7, 8, 9])("selects option %i immediately with its number key", (number) => {
		const options = Array.from({ length: 9 }, (_, index) => `Option ${index + 1}`);
		const { selector, onSelect, onCancel } = createSelector(options);
		selector.handleInput(String(number));
		expect(onSelect).toHaveBeenCalledExactlyOnceWith(`Option ${number}`);
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("selects the typed-answer entry by number", () => {
		const { selector, onSelect } = createSelector();
		selector.handleInput("3");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith("Other — type your answer");
	});

	it("ignores numbers that do not map to an available option", () => {
		const { selector, onSelect, onCancel } = createSelector();
		for (const input of ["0", "4", "9", "12", "abc"]) selector.handleInput(input);
		expect(onSelect).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();
	});

	it("uses a remapped option key and shows the new binding", () => {
		setKeybindings(new KeybindingsManager({ "app.dialog.select2": "x" }));
		const { selector, onSelect } = createSelector();
		expect(stripAnsi(selector.render(80).join("\n"))).toContain("x. Postgres");
		selector.handleInput("2");
		expect(onSelect).not.toHaveBeenCalled();
		selector.handleInput("x");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith("Postgres");
	});

	it("supports disabling an option shortcut", () => {
		setKeybindings(new KeybindingsManager({ "app.dialog.select1": [] }));
		const { selector, onSelect } = createSelector();
		selector.handleInput("1");
		expect(onSelect).not.toHaveBeenCalled();
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith("SQLite");
	});

	it("keeps arrow keys and Enter for choices beyond the first nine", () => {
		const options = Array.from({ length: 11 }, (_, index) => `Option ${index + 1}`);
		const { selector, onSelect } = createSelector(options);
		for (let index = 0; index < 10; index++) selector.handleInput("\x1b[B");
		selector.handleInput("\x1b[A");
		selector.handleInput("\r");
		expect(onSelect).toHaveBeenCalledExactlyOnceWith("Option 10");
	});

	it("keeps Escape cancellation", () => {
		const { selector, onSelect, onCancel } = createSelector();
		selector.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledOnce();
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("renders narrow choices within the terminal width", () => {
		const { selector } = createSelector(["A long database name that must wrap", "Other — type your answer"]);
		for (const line of selector.render(24)) expect(visibleWidth(line)).toBeLessThanOrEqual(24);
	});

	it("keeps the visible countdown and expires the dialog", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const onSelect = vi.fn();
		const onCancel = vi.fn();
		const selector = new ExtensionSelectorComponent("Choose", ["Yes", "No"], onSelect, onCancel, {
			tui: { requestRender } as unknown as TUI,
			timeout: 3000,
		});
		try {
			expect(stripAnsi(selector.render(80).join("\n"))).toContain("Choose (3s)");
			vi.advanceTimersByTime(1000);
			expect(stripAnsi(selector.render(80).join("\n"))).toContain("Choose (2s)");
			vi.advanceTimersByTime(2000);
			expect(onCancel).toHaveBeenCalledOnce();
			expect(onSelect).not.toHaveBeenCalled();
			expect(requestRender).toHaveBeenCalled();
		} finally {
			selector.dispose();
		}
	});

	it("stops the countdown when the selector is disposed after a number choice", () => {
		vi.useFakeTimers();
		const onCancel = vi.fn();
		const onSelect = vi.fn(() => selector.dispose());
		const selector = new ExtensionSelectorComponent("Choose", ["Yes", "No"], onSelect, onCancel, {
			tui: { requestRender: vi.fn() } as unknown as TUI,
			timeout: 1000,
		});
		try {
			selector.handleInput("2");
			expect(onSelect).toHaveBeenCalledExactlyOnceWith("No");
			vi.advanceTimersByTime(2000);
			expect(onCancel).not.toHaveBeenCalled();
		} finally {
			selector.dispose();
		}
	});

	// #6688: long extension selectors must keep the selected option visible.
	it("windows long option lists around the selection", () => {
		const options = Array.from({ length: 15 }, (_, index) => `option-${index + 1}`);
		const selector = new ExtensionSelectorComponent(
			"Choose",
			options,
			() => {},
			() => {},
		);

		let output = render(selector);
		expect(visibleOptions(output)).toEqual(options.slice(0, 10));
		expect(output).toContain("→ 1. option-1");
		expect(output).toContain("  (1/15)");

		for (let i = 0; i < 7; i++) selector.handleInput("\x1b[B");
		output = render(selector);
		expect(visibleOptions(output)).toEqual(options.slice(2, 12));
		expect(output).toContain("→ 8. option-8");
		expect(output).toContain("  (8/15)");

		for (let i = 0; i < 7; i++) selector.handleInput("\x1b[B");
		output = render(selector);
		expect(visibleOptions(output)).toEqual(options.slice(5, 15));
		expect(output).toContain("→ option-15");
		expect(output).toContain("  (15/15)");
	});

	it("renders short and empty option lists without a scroll indicator", () => {
		const shortOptions = ["option-1", "option-2", "option-3"];
		const shortOutput = render(
			new ExtensionSelectorComponent(
				"Choose",
				shortOptions,
				() => {},
				() => {},
			),
		);
		expect(visibleOptions(shortOutput)).toEqual(shortOptions);
		expect(shortOutput).toContain("→ 1. option-1");
		expect(shortOutput).not.toContain("(1/3)");

		const emptyOutput = render(
			new ExtensionSelectorComponent(
				"Choose",
				[],
				() => {},
				() => {},
			),
		);
		expect(emptyOutput).toContain("Choose");
		expect(emptyOutput).toContain("↑↓ navigate");
		expect(emptyOutput).not.toContain("→");
	});
});
