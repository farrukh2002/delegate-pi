import { describe, expect, it } from "vitest";
import {
	ACCENT_COLORS,
	ACCENT_NAMES,
	getAccentSetting,
	getAvailableThemes,
	getThemeByName,
	initTheme,
	setAccentSetting,
	theme,
} from "../src/modes/interactive/theme/theme.ts";

describe("accent setting", () => {
	it("offers yellow, green, orange and blue", () => {
		expect(ACCENT_NAMES).toEqual(["yellow", "green", "orange", "blue"]);
		expect(Object.keys(ACCENT_COLORS)).toEqual([...ACCENT_NAMES]);
	});

	it("round-trips the selected accent", () => {
		setAccentSetting("green");
		expect(getAccentSetting()).toBe("green");
		setAccentSetting("theme");
		expect(getAccentSetting()).toBe("theme");
	});

	it("paints accent tokens with the chosen color", async () => {
		initTheme("dark");
		const before = theme.fg("accent", "x");
		setAccentSetting("blue");
		const after = theme.fg("accent", "x");
		expect(after).not.toBe(before);
		expect(theme.getFgAnsi("accent")).not.toBe("");

		setAccentSetting("yellow");
		const yellow = theme.fg("accent", "x");
		expect(yellow).not.toBe(after);
	});

	it("leaves non-accent tokens alone", () => {
		initTheme("dark");
		const before = theme.fg("text", "x");
		setAccentSetting("orange");
		expect(theme.fg("text", "x")).toBe(before);
		setAccentSetting("theme");
	});
});

describe("opencode theme", () => {
	it("is available and resolves", () => {
		expect(getAvailableThemes()).toContain("opencode");
		const opencode = getThemeByName("opencode");
		expect(opencode).toBeDefined();
	});

	it("uses the opencode yellow accent and black page", () => {
		const opencode = getThemeByName("opencode");
		expect(opencode?.appearance).toBe("dark");
		const colors = opencode?.colors as Record<string, { kind: string; r?: number; g?: number; b?: number }>;
		expect(colors.accent).toMatchObject({ kind: "rgb", r: 250, g: 178, b: 131 });
		expect(colors.text).toMatchObject({ r: 238, g: 238, b: 238 });
	});
});

describe("theme canvas", () => {
	it("paints the opencode canvas and restores the terminal default elsewhere", async () => {
		const { parseColor } = await import("@earendil-works/pi-tui");
		const { canvasSequence } = await import("../src/modes/interactive/theme/theme-controller.ts");
		expect(canvasSequence(parseColor("#0a0a0a"))).toBe("\x1b]11;#0a0a0a\x1b\\");
		expect(canvasSequence(undefined)).toBe("\x1b]111\x1b\\");
	});

	it("defines a canvas in the opencode theme only", () => {
		const opencode = getThemeByName("opencode");
		expect(opencode?.canvas).toBeDefined();
		expect(opencode?.canvas && "kind" in opencode.canvas ? opencode.canvas : undefined).toMatchObject({
			r: 10,
			g: 10,
			b: 10,
		});
		expect(getThemeByName("dark")?.canvas).toBeUndefined();
	});
});
