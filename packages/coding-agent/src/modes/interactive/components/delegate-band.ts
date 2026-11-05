import {
	type Component,
	type Focusable,
	type KeyId,
	matchesKey,
	stripTerminalSequences,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { LiveRow } from "../../../core/delegate/view.ts";
import { type ThemeColor, theme } from "../theme/theme.ts";
import { DEFAULT_DELEGATE_STYLE, type DelegateStyle, resolveDelegateStyle } from "./delegate-style.ts";

export const BAND_GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"] as const;
export const COMET_TRACK = 14;
export const FRAME_INTERVAL_MS = 90;
export const BAND_ROWS = 4;
export const MAX_RECENT_ACTIONS = 5;
const MIN_NAME_WIDTH = 6;
const MIN_PREVIEW_ROOM = 8;
const DEFAULT_HEIGHT_BUDGET = BAND_ROWS + 1 + MAX_RECENT_ACTIONS;

export interface DelegateBandKeybindings {
	up: KeyId[];
	down: KeyId[];
	toggle: KeyId[];
}

export const DEFAULT_DELEGATE_BAND_KEYBINDINGS: DelegateBandKeybindings = {
	up: ["up", "k"],
	down: ["down", "j"],
	toggle: ["enter", "return", "space"],
};

export interface DelegateBandOptions {
	maxRows?: number;
	keybindings?: Partial<DelegateBandKeybindings>;
	matchKey?: (data: string, key: KeyId) => boolean;
	now?: () => number;
	intervalMs?: number;
	autoAnimate?: boolean;
	requestRender?: () => void;
	passThroughInput?: (data: string) => void;
	onFocusRequest?: () => void;
	style?: Partial<DelegateStyle>;
	terminalRows?: () => number;
}

export interface BandGlyphCell {
	char: string;
	color: ThemeColor;
}

export function formatElapsedClock(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
}

export function shimmerCells(
	text: string,
	frame: number,
	offset: number,
	style: DelegateStyle = DEFAULT_DELEGATE_STYLE,
): BandGlyphCell[] {
	const head = ((frame + offset) % (text.length + 10)) - 3;
	return [...text].map((char, index) => {
		const distance = Math.abs(index - head);
		const color: ThemeColor = distance === 0 ? style.text : distance < 3 ? style.accent : style.inactive;
		return { char, color };
	});
}

export function cometCells(
	frame: number,
	offset: number,
	style: DelegateStyle = DEFAULT_DELEGATE_STYLE,
): BandGlyphCell[] {
	const span = COMET_TRACK * 2 - 2;
	const step = (frame + offset * 5) % span;
	const head = step < COMET_TRACK ? step : span - step;
	const cells: BandGlyphCell[] = [];
	for (let index = 0; index < COMET_TRACK; index++) {
		const distance = Math.abs(index - head);
		const color: ThemeColor = distance === 0 ? style.accent : distance < 3 ? style.subtle : style.track;
		cells.push({ char: distance < 3 ? "━" : "─", color });
	}
	return cells;
}

function paint(cells: BandGlyphCell[]): string {
	return cells.map((cell) => theme.fg(cell.color, cell.char)).join("");
}

function sanitizeLine(value: unknown): string {
	return stripTerminalSequences(String(value ?? ""))
		.replace(/\s+/g, " ")
		.trim();
}

function cutToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	return truncateToWidth(text, width, "…");
}

function padToWidth(text: string, width: number): string {
	const clipped = truncateToWidth(text, width, "");
	const pad = Math.max(0, width - visibleWidth(clipped));
	return clipped + " ".repeat(pad);
}

function dimStyle(text: string, color: ThemeColor): string {
	return theme.style(text, { fg: color, dim: true });
}

export class DelegateBand implements Component, Focusable {
	focused = false;

	private rows: LiveRow[] = [];
	private frame = 0;
	private cursor = 0;
	private open: string | undefined;
	private hitRows: Array<string | undefined> = [];
	private maxRows: number;
	private readonly keybindings: DelegateBandKeybindings;
	private readonly matchKey: (data: string, key: KeyId) => boolean;
	private readonly clockSource: () => number;
	private readonly intervalMs: number;
	private readonly requestRenderFn: () => void;
	private readonly passThroughInput: (data: string) => void;
	private readonly onFocusRequest: () => void;
	private readonly autoAnimate: boolean;
	private readonly style: DelegateStyle;
	private readonly terminalRows: (() => number) | undefined;
	private intervalId: ReturnType<typeof setInterval> | undefined;

	constructor(options: DelegateBandOptions = {}) {
		this.maxRows = Math.max(1, Math.min(BAND_ROWS, options.maxRows ?? BAND_ROWS));
		this.keybindings = {
			up: options.keybindings?.up ?? DEFAULT_DELEGATE_BAND_KEYBINDINGS.up,
			down: options.keybindings?.down ?? DEFAULT_DELEGATE_BAND_KEYBINDINGS.down,
			toggle: options.keybindings?.toggle ?? DEFAULT_DELEGATE_BAND_KEYBINDINGS.toggle,
		};
		this.matchKey = options.matchKey ?? matchesKey;
		this.clockSource = options.now ?? (() => Date.now());
		this.intervalMs =
			options.intervalMs !== undefined && options.intervalMs > 0 ? options.intervalMs : FRAME_INTERVAL_MS;
		this.requestRenderFn = options.requestRender ?? (() => {});
		this.passThroughInput = options.passThroughInput ?? (() => {});
		this.onFocusRequest = options.onFocusRequest ?? (() => {});
		this.autoAnimate = options.autoAnimate !== false;
		this.style = resolveDelegateStyle(options.style);
		this.terminalRows = options.terminalRows;
	}

	setRows(rows: LiveRow[]): void {
		this.rows = rows;
		const shown = this.displayRows();
		if (this.cursor >= shown.length) this.cursor = shown.length > 0 ? shown.length - 1 : 0;
		if (this.open !== undefined && !rows.some((row) => row.id === this.open)) this.open = undefined;
		if (this.autoAnimate) {
			if (rows.length > 0) this.startAnimation();
			else this.stopAnimation();
		}
	}

	getRows(): LiveRow[] {
		return this.rows;
	}

	getMaxRows(): number {
		return this.maxRows;
	}

	setMaxRows(rows: number): void {
		this.maxRows = Math.max(1, Math.min(BAND_ROWS, Math.floor(rows)));
	}

	moveCursor(delta: number): void {
		const shown = this.displayRows();
		if (shown.length === 0) return;
		const cursor = Math.min(this.cursor, shown.length - 1);
		this.cursor = (((cursor + delta) % shown.length) + shown.length) % shown.length;
		this.requestRenderFn();
	}

	toggleSelected(): void {
		const shown = this.displayRows();
		const row = shown[Math.min(this.cursor, shown.length - 1)];
		if (row) this.toggle(row.id);
	}

	openId(): string | undefined {
		return this.open;
	}

	hasOpen(): boolean {
		return this.open !== undefined;
	}

	getFrame(): number {
		return this.frame;
	}

	setFrame(frame: number): void {
		this.frame = Math.max(0, Math.floor(frame));
	}

	tick(count = 1): void {
		this.frame = Math.max(0, this.frame + Math.floor(count));
	}

	getCursor(): number {
		return this.cursor;
	}

	getOpenId(): string | undefined {
		return this.open;
	}

	toggle(id?: string): void {
		if (!id) return;
		this.open = this.open === id ? undefined : id;
		this.requestRenderFn();
	}

	startAnimation(): void {
		if (this.intervalId !== undefined) return;
		this.intervalId = setInterval(() => {
			this.frame += 1;
			this.requestRenderFn();
		}, this.intervalMs);
	}

	stopAnimation(): void {
		if (this.intervalId === undefined) return;
		clearInterval(this.intervalId);
		this.intervalId = undefined;
	}

	isAnimating(): boolean {
		return this.intervalId !== undefined;
	}

	dispose(): void {
		this.stopAnimation();
	}

	invalidate(): void {
		this.hitRows = [];
	}

	handleInput(data: string): void {
		if (!this.focused) return;
		const shown = this.displayRows();
		if (shown.length === 0) {
			this.passThroughInput(data);
			return;
		}
		const cursor = Math.min(this.cursor, shown.length - 1);
		if (this.matchAny(data, this.keybindings.down)) {
			this.cursor = (cursor + 1) % shown.length;
			this.requestRenderFn();
		} else if (this.matchAny(data, this.keybindings.up)) {
			this.cursor = (cursor + shown.length - 1) % shown.length;
			this.requestRenderFn();
		} else if (this.matchAny(data, this.keybindings.toggle)) {
			const row = shown[cursor];
			if (row) this.toggle(row.id);
		} else {
			this.passThroughInput(data);
		}
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.button === "right" || event.type !== "press") return undefined;
		const id = this.hitRows[event.y];
		if (!id) return undefined;
		if (!this.focused) this.onFocusRequest();
		this.toggle(id);
		return { handled: true, focus: true };
	}

	render(width: number): string[] {
		this.hitRows = [];
		const ordered = this.sortedRows();
		if (ordered.length === 0) return [];

		const viewport = width > 0 ? width : 100;
		const budget = this.heightBudget();
		const shown = ordered.slice(0, this.rowCap());
		const hidden = ordered.length - shown.length;
		const nameWidth = shown.reduce(
			(widest, row) => Math.max(widest, visibleWidth(sanitizeLine(row.agent))),
			MIN_NAME_WIDTH,
		);
		const fixed = 3 + nameWidth + COMET_TRACK + 8;
		const room = Math.max(0, viewport - fixed - 2);
		const cursor = this.cursor;
		const lines: string[] = [];
		const reserved = shown.length + (hidden > 0 ? 1 : 0);
		const activityBudget = Math.max(0, budget - reserved);
		let activityUsed = 0;

		shown.forEach((row, index) => {
			lines.push(
				cutToWidth(this.renderRow(row, index, nameWidth, room, this.focused && cursor === index), viewport),
			);
			this.hitRows.push(row.id);
			if (this.open !== row.id) return;
			const recent = (row.activity ?? []).slice(-MAX_RECENT_ACTIONS);
			if (recent.length === 0) {
				if (activityUsed < activityBudget) {
					lines.push(cutToWidth(dimStyle("  ⎿ no activity yet", this.style.subtle), viewport));
					this.hitRows.push(row.id);
					activityUsed += 1;
				}
				return;
			}
			const taken = recent.slice(0, Math.min(recent.length, activityBudget - activityUsed));
			const activityWidth = Math.max(10, viewport - 6);
			taken.forEach((action, at) => {
				const color: ThemeColor = at === taken.length - 1 ? this.style.text : this.style.subtle;
				lines.push(cutToWidth(theme.fg(color, `  ⎿ ${cutToWidth(sanitizeLine(action), activityWidth)}`), viewport));
				this.hitRows.push(row.id);
				activityUsed += 1;
			});
		});

		if (hidden > 0 && lines.length < budget) {
			lines.push(cutToWidth(theme.fg(this.style.muted, `+${hidden} more · /delegate-tasks`), viewport));
			this.hitRows.push(undefined);
		}

		return lines;
	}

	private heightBudget(): number {
		if (this.terminalRows) return Math.max(2, this.terminalRows() - 4);
		return DEFAULT_HEIGHT_BUDGET;
	}

	private rowCap(): number {
		return Math.max(1, Math.min(BAND_ROWS, this.maxRows, this.heightBudget() - 1));
	}

	private sortedRows(): LiveRow[] {
		return [...this.rows].sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0));
	}

	private displayRows(): LiveRow[] {
		return this.sortedRows().slice(0, this.rowCap());
	}

	private renderRow(row: LiveRow, index: number, nameWidth: number, room: number, selected: boolean): string {
		const asking = row.asking;
		const queued = row.status === "queued";
		const glyph = asking ? (this.frame % 10 < 6 ? "?" : " ") : queued ? "◌" : this.glyph(index * 3);
		const glyphColor: ThemeColor = asking ? this.style.warning : queued ? this.style.inactive : this.style.accent;
		const parts = [theme.fg(glyphColor, glyph)];

		const name = paint(
			shimmerCells(padToWidth(sanitizeLine(row.agent), nameWidth), this.frame, index * 4, this.style),
		);
		parts.push(selected ? theme.style(name, { underline: true }) : name);

		parts.push(
			queued
				? dimStyle("·".repeat(COMET_TRACK), this.style.inactive)
				: paint(cometCells(this.frame, index, this.style)),
		);

		const elapsed = this.clockSource() - (row.startedAt || this.clockSource());
		const status = asking ? "needs you" : queued ? "queued" : formatElapsedClock(elapsed);
		parts.push(dimStyle(status, this.style.muted));

		const activity = row.activity ?? [];
		const last = activity[activity.length - 1];
		if (this.open !== row.id && last !== undefined && room > MIN_PREVIEW_ROOM) {
			parts.push(theme.fg(this.style.subtle, cutToWidth(sanitizeLine(last), room)));
		}

		return parts.join(" ");
	}

	private glyph(offset: number): string {
		const index =
			((Math.floor(this.frame / 2 + offset) % BAND_GLYPHS.length) + BAND_GLYPHS.length) % BAND_GLYPHS.length;
		return BAND_GLYPHS[index]!;
	}

	private matchAny(data: string, keys: KeyId[]): boolean {
		return keys.some((key) => this.matchKey(data, key));
	}
}
