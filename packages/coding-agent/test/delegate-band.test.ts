import { type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { LiveRow } from "../src/core/delegate/view.ts";
import {
	BAND_GLYPHS,
	BAND_ROWS,
	COMET_TRACK,
	cometCells,
	DEFAULT_DELEGATE_BAND_KEYBINDINGS,
	DelegateBand,
	FRAME_INTERVAL_MS,
	formatElapsedClock,
	shimmerCells,
} from "../src/modes/interactive/components/delegate-band.ts";
import { DEFAULT_DELEGATE_STYLE } from "../src/modes/interactive/components/delegate-style.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function makeRow(overrides: Partial<LiveRow> & { id: string }): LiveRow {
	return {
		agent: "worker",
		status: "running",
		startedAt: 0,
		asking: false,
		activity: [],
		...overrides,
	};
}

function makeBand(options: ConstructorParameters<typeof DelegateBand>[0] = {}): DelegateBand {
	return new DelegateBand({ autoAnimate: false, now: () => 0, ...options });
}

function mouse(
	y: number,
	button: TuiMouseEvent["button"] = "left",
	type: TuiMouseEvent["type"] = "press",
): TuiMouseEvent {
	return {
		type,
		button,
		x: 0,
		y,
		screenX: 0,
		screenY: y,
		width: 120,
		height: 10,
		shift: false,
		alt: false,
		ctrl: false,
	};
}

function cometLength(line: string): number {
	return (line.match(/[─━]/g) ?? []).length;
}

describe("delegate band", () => {
	beforeAll(() => initTheme("dark"));

	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders nothing when there are no open tasks", () => {
		const band = makeBand();
		expect(band.render(120)).toEqual([]);
		band.setRows([]);
		expect(band.render(120)).toEqual([]);
	});

	it("renders the glyph frame, aligned name, 14-column comet, and elapsed clock", () => {
		const band = makeBand({ now: () => 6000 });
		band.setRows([makeRow({ id: "a", agent: "worker", startedAt: 1000 })]);
		const line = stripAnsi(band.render(120)[0]!);
		expect(line).toMatch(new RegExp(`^${BAND_GLYPHS[0]} worker [─━]{${COMET_TRACK}} 5s`));
		expect(cometLength(line)).toBe(COMET_TRACK);
	});

	it("advances the glyph every two frames", () => {
		const band = makeBand();
		band.setRows([makeRow({ id: "a", agent: "worker", startedAt: 1 })]);
		const glyphAt = (frame: number): string => {
			band.setFrame(frame);
			return stripAnsi(band.render(120)[0]!)[0]!;
		};
		expect(glyphAt(0)).toBe(BAND_GLYPHS[0]);
		expect(glyphAt(2)).toBe(BAND_GLYPHS[1]);
		expect(glyphAt(4)).toBe(BAND_GLYPHS[2]);
	});

	it("renders the queued placeholder with a dotted track", () => {
		const band = makeBand();
		band.setRows([makeRow({ id: "a", status: "queued", startedAt: 1 })]);
		const line = stripAnsi(band.render(120)[0]!);
		expect(line).toContain("◌");
		expect(line).toContain("·".repeat(COMET_TRACK));
		expect(line).toContain("queued");
		expect(cometLength(line)).toBe(0);
	});

	it("blinks the asking marker and shows needs you", () => {
		const band = makeBand();
		band.setRows([makeRow({ id: "a", asking: true, status: "waiting", startedAt: 1 })]);
		band.setFrame(0);
		const asked = stripAnsi(band.render(120)[0]!);
		expect(asked.startsWith("?")).toBe(true);
		expect(asked).toContain("needs you");
		band.setFrame(6);
		const blinked = stripAnsi(band.render(120)[0]!);
		expect(blinked.startsWith(" ")).toBe(true);
		expect(blinked).toContain("needs you");
	});

	it("maps the reference palette to theme tokens", () => {
		expect(shimmerCells("worker", 0, 0).map((cell) => cell.color)).toEqual([
			DEFAULT_DELEGATE_STYLE.inactive,
			DEFAULT_DELEGATE_STYLE.inactive,
			DEFAULT_DELEGATE_STYLE.inactive,
			DEFAULT_DELEGATE_STYLE.inactive,
			DEFAULT_DELEGATE_STYLE.inactive,
			DEFAULT_DELEGATE_STYLE.inactive,
		]);
		expect(shimmerCells("worker", 5, 0).map((cell) => cell.color)).toEqual([
			"accent",
			"accent",
			"text",
			"accent",
			"accent",
			"muted",
		]);
	});

	it("builds a 14-column comet that bounces across the track", () => {
		const cells = cometCells(0, 0);
		expect(cells).toHaveLength(COMET_TRACK);
		expect(cells[0]).toEqual({ char: "━", color: "accent" });
		expect(cells[3]).toEqual({ char: "─", color: "borderMuted" });
		expect(cometCells(COMET_TRACK, 0)[12]).toEqual({ char: "━", color: "accent" });
	});

	it("honors a delegate style override", () => {
		const band = makeBand({ style: { accent: "warning", inactive: "error", subtle: "border", track: "text" } });
		band.setRows([makeRow({ id: "a", startedAt: 0 })]);
		const line = band.render(120)[0]!;
		expect(line).toContain(theme.getFgAnsi("warning"));
		expect(line).not.toContain(theme.getFgAnsi("accent"));
		expect(
			shimmerCells("ab", 0, 0, { ...DEFAULT_DELEGATE_STYLE, inactive: "error" }).map((cell) => cell.color),
		).toEqual(["error", "error"]);
	});

	it("aligns names to the widest agent in the band", () => {
		const band = makeBand();
		band.setRows([
			makeRow({ id: "a", agent: "a", startedAt: 0 }),
			makeRow({ id: "b", agent: "worker", startedAt: 1 }),
		]);
		const lines = band.render(120).map((line) => stripAnsi(line));
		expect(lines).toHaveLength(2);
		const cometStarts = lines.map((line) => line.search(/[─━]/));
		expect(cometStarts[0]).toBe(cometStarts[1]);
		expect(cometStarts[0]).toBeGreaterThan(-1);
	});

	it("shows at most four rows and an overflow line", () => {
		const band = makeBand();
		band.setRows(Array.from({ length: 6 }, (_, index) => makeRow({ id: `t${index}`, startedAt: index })));
		const lines = band.render(120).map((line) => stripAnsi(line));
		expect(lines).toHaveLength(5);
		expect(lines[4]).toBe("+2 more · /delegate-tasks");
		expect(BAND_ROWS).toBe(4);
	});

	it("clamps rows and actions to the terminal height", () => {
		let height = 40;
		const band = makeBand({ terminalRows: () => height });
		band.setRows(
			Array.from({ length: 6 }, (_, index) =>
				makeRow({ id: `t${index}`, startedAt: index, activity: ["a", "b", "c", "d", "e", "f", "g"] }),
			),
		);
		band.toggle("t0");
		const tall = band.render(120).map((line) => stripAnsi(line));
		expect(tall.length).toBeLessThanOrEqual(4 + 5 + 1);
		height = 7;
		const short = band.render(120).map((line) => stripAnsi(line));
		expect(short.length).toBeLessThanOrEqual(3);
	});

	it("reserves base rows and overflow before expanded activity", () => {
		for (const rows of [8, 9, 10]) {
			const band = makeBand({ terminalRows: () => rows });
			band.setRows(
				Array.from({ length: 4 }, (_, index) =>
					makeRow({ id: `t${index}`, startedAt: index, activity: ["a0", "a1", "a2", "a3"] }),
				),
			);
			band.toggle("t0");
			const budget = Math.max(2, rows - 4);
			expect(band.render(120).length).toBeLessThanOrEqual(budget);
		}
	});

	it("keeps the output within budget after a resize", () => {
		let height = 10;
		const band = makeBand({ terminalRows: () => height });
		band.setRows(
			Array.from({ length: 4 }, (_, index) =>
				makeRow({ id: `t${index}`, startedAt: index, activity: ["a", "b", "c"] }),
			),
		);
		band.toggle("t0");
		expect(band.render(120).length).toBeLessThanOrEqual(6);
		height = 8;
		expect(band.render(120).length).toBeLessThanOrEqual(4);
		height = 40;
		expect(band.render(120).length).toBeLessThanOrEqual(4 + 5 + 1);
	});

	it("requests focus before toggling on an unfocused mouse press", () => {
		const onFocusRequest = vi.fn();
		const band = makeBand({ onFocusRequest });
		band.setRows([makeRow({ id: "a", startedAt: 0 })]);
		band.render(120);
		expect(band.handleMouse(mouse(0))).toEqual({ handled: true, focus: true });
		expect(onFocusRequest).toHaveBeenCalledTimes(1);
		band.render(120);
		band.focused = true;
		expect(band.handleMouse(mouse(0))).toEqual({ handled: true, focus: true });
		expect(onFocusRequest).toHaveBeenCalledTimes(1);
	});

	it("expands a row to its last five actions, or a placeholder", () => {
		const band = makeBand();
		band.setRows([
			makeRow({ id: "a", startedAt: 0, activity: ["a0", "a1", "a2", "a3", "a4", "a5", "a6"] }),
			makeRow({ id: "b", startedAt: 1 }),
		]);
		band.toggle("a");
		const lines = band.render(120).map((line) => stripAnsi(line));
		expect(lines).toHaveLength(7);
		expect(lines[1]).toContain("⎿ a2");
		expect(lines[5]).toContain("⎿ a6");
		expect(lines.join("\n")).not.toContain("a0");
		band.toggle("a");
		band.toggle("b");
		const placeholder = band.render(120).map((line) => stripAnsi(line));
		expect(placeholder.some((line) => line.includes("no activity yet"))).toBe(true);
	});

	it("maps clicks to rows and focuses the band", () => {
		const band = makeBand();
		band.setRows([makeRow({ id: "a", startedAt: 0, activity: ["one", "two"] }), makeRow({ id: "b", startedAt: 1 })]);
		band.render(120);
		expect(band.handleMouse(mouse(0))).toEqual({ handled: true, focus: true });
		expect(band.getOpenId()).toBe("a");
		band.render(120);
		expect(band.handleMouse(mouse(2))).toEqual({ handled: true, focus: true });
		expect(band.getOpenId()).toBeUndefined();
		band.render(120);
		expect(band.handleMouse(mouse(1))).toEqual({ handled: true, focus: true });
		expect(band.getOpenId()).toBe("b");
		expect(band.handleMouse(mouse(1, "right"))).toBeUndefined();
		expect(band.handleMouse(mouse(9))).toBeUndefined();
	});

	it("gates keyboard navigation behind explicit focus", () => {
		const passThrough = vi.fn();
		const requestRender = vi.fn();
		const band = makeBand({ passThroughInput: passThrough, requestRender });
		band.setRows([makeRow({ id: "a", startedAt: 0 }), makeRow({ id: "b", startedAt: 1 })]);

		band.handleInput("j");
		expect(band.getCursor()).toBe(0);
		expect(passThrough).not.toHaveBeenCalled();

		band.focused = true;
		band.handleInput("j");
		expect(band.getCursor()).toBe(1);
		band.handleInput("\x1b[B");
		expect(band.getCursor()).toBe(0);
		band.handleInput("k");
		expect(band.getCursor()).toBe(1);
		band.handleInput(" ");
		expect(band.getOpenId()).toBe("b");
		band.handleInput("x");
		expect(passThrough).toHaveBeenCalledWith("x");
		expect(requestRender).toHaveBeenCalled();
	});

	it("honors injected keybindings and key matcher", () => {
		const injected = makeBand({
			keybindings: { down: ["x"], up: ["y"], toggle: ["z"] },
		});
		injected.setRows([makeRow({ id: "a", startedAt: 0 }), makeRow({ id: "b", startedAt: 1 })]);
		injected.focused = true;
		injected.handleInput("x");
		expect(injected.getCursor()).toBe(1);
		injected.handleInput("j");
		expect(injected.getCursor()).toBe(1);
		injected.handleInput("z");
		expect(injected.getOpenId()).toBe("b");

		const matched = makeBand({ matchKey: (data, key) => data === `key:${key}` });
		matched.setRows([makeRow({ id: "a", startedAt: 0 }), makeRow({ id: "b", startedAt: 1 })]);
		matched.focused = true;
		matched.handleInput("key:down");
		expect(matched.getCursor()).toBe(1);
		expect(DEFAULT_DELEGATE_BAND_KEYBINDINGS.down).toContain("j");
	});

	it("uses the injected clock for the elapsed time", () => {
		const band = makeBand({ now: () => 126000 });
		band.setRows([makeRow({ id: "a", startedAt: 1000 })]);
		expect(stripAnsi(band.render(120)[0]!)).toContain("2m05s");
	});

	it("sanitizes child agent and activity text", () => {
		const band = makeBand();
		band.setRows([
			makeRow({ id: "a", startedAt: 0, agent: "wo\nrker\u001b[31m", activity: ["step\u001b[0m one\n\ntwo"] }),
		]);
		band.toggle("a");
		const raw = band.render(120).join("\n");
		expect(raw).not.toContain("\u001b[31m");
		const lines = band.render(120).map((line) => stripAnsi(line));
		expect(lines[0]).toContain("wo rker");
		expect(lines[1]).toContain("step one two");
	});

	it("bounds wide and combining text to the viewport width", () => {
		const band = makeBand();
		band.setRows([
			makeRow({
				id: "a",
				agent: "汉字😀e\u0301-very-long-name",
				startedAt: 0,
				activity: ["汉字😀 combining e\u0301 activity that should truncate to fit"],
			}),
		]);
		band.toggle("a");
		for (const width of [1, 4, 10, 20, 40, 120]) {
			for (const line of band.render(width)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("does not animate while idle and disposes the timer safely", () => {
		vi.useFakeTimers();
		const requestRender = vi.fn();
		const band = new DelegateBand({ now: () => 0, requestRender });
		expect(band.isAnimating()).toBe(false);
		vi.advanceTimersByTime(FRAME_INTERVAL_MS * 3);
		expect(band.getFrame()).toBe(0);

		band.setRows([makeRow({ id: "a", startedAt: 0 })]);
		expect(band.isAnimating()).toBe(true);
		vi.advanceTimersByTime(FRAME_INTERVAL_MS);
		expect(band.getFrame()).toBe(1);

		band.setRows([]);
		expect(band.isAnimating()).toBe(false);
		vi.advanceTimersByTime(FRAME_INTERVAL_MS * 5);
		expect(band.getFrame()).toBe(1);

		band.dispose();
		band.dispose();
		expect(requestRender).toHaveBeenCalledTimes(1);
	});

	it("honors an injected animation interval", () => {
		vi.useFakeTimers();
		const band = new DelegateBand({ now: () => 0, intervalMs: 30 });
		band.setRows([makeRow({ id: "a", startedAt: 0 })]);
		vi.advanceTimersByTime(30);
		expect(band.getFrame()).toBe(1);
		band.dispose();
	});

	it("formats the elapsed clock like the reference", () => {
		expect(formatElapsedClock(0)).toBe("0s");
		expect(formatElapsedClock(59000)).toBe("59s");
		expect(formatElapsedClock(60000)).toBe("1m00s");
		expect(formatElapsedClock(125000)).toBe("2m05s");
	});
});
