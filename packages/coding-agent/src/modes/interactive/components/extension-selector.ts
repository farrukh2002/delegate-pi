/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import { Container, getKeybindings, Spacer, Text, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, keyText, rawKeyHint } from "./keybinding-hints.ts";

const OPTION_KEYBINDINGS = [
	"app.dialog.select1",
	"app.dialog.select2",
	"app.dialog.select3",
	"app.dialog.select4",
	"app.dialog.select5",
	"app.dialog.select6",
	"app.dialog.select7",
	"app.dialog.select8",
	"app.dialog.select9",
] as const;

const MAX_VISIBLE = 10;
const RESERVED_ROWS = 3;
const MIN_BODY_ROWS = 2;

export interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
	description?: string;
}

export class ExtensionSelectorComponent extends Container {
	readonly capturesViewportInput: boolean = true;
	private options: string[];
	private selectedIndex = 0;
	private tui: TUI | undefined;
	private top: Container;
	private body: Container;
	private bottom: Container;
	private maxVisible = MAX_VISIBLE;
	private bodyScroll = 0;
	private bodyWindow = 0;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private titleText: Text;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private onToggleToolsExpanded: (() => void) | undefined;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.options = options;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;
		this.baseTitle = title;
		this.tui = opts?.tui;

		this.top = new Container();
		this.top.addChild(new DynamicBorder());
		this.top.addChild(new Spacer(1));

		this.body = new Container();
		this.titleText = new Text(theme.fg("accent", theme.bold(title)), 1, 0);
		this.body.addChild(this.titleText);
		if (opts?.description) {
			this.body.addChild(new Spacer(1));
			this.body.addChild(new Text(theme.fg("text", opts.description), 1, 0));
		}

		this.bottom = new Container();
		this.bottom.addChild(new Spacer(1));
		this.bottom.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.bottom.addChild(new Spacer(1));
		this.bottom.addChild(new DynamicBorder());

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", theme.bold(`${this.baseTitle} (${s}s)`))),
				() => this.onCancelCallback(),
			);
		}

		this.listContainer = new Container();
		this.addChild(this.top);
		this.addChild(this.body);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(this.bottom);

		this.updateList();
	}

	render(width: number): readonly string[] {
		const rows = this.tui?.terminal.rows;
		if (rows === undefined) return super.render(width);

		const top = this.top.render(width);
		const bottom = this.bottom.render(width);
		const body = this.body.render(width);
		const room = Math.max(1, rows - RESERVED_ROWS) - top.length - bottom.length - 1;
		const listBudget = Math.max(1, room - Math.min(body.length, MIN_BODY_ROWS));
		const fitsAll = this.options.length <= listBudget;
		const maxVisible = Math.max(1, Math.min(MAX_VISIBLE, fitsAll ? this.options.length : listBudget - 1));
		if (maxVisible !== this.maxVisible) {
			this.maxVisible = maxVisible;
			this.updateList();
		}
		const list = this.listContainer.render(width);
		return [...top, ...this.windowBody(body, Math.max(1, room - list.length), width), "", ...list, ...bottom];
	}

	private windowBody(body: readonly string[], room: number, width: number): readonly string[] {
		if (body.length <= room) {
			this.bodyScroll = 0;
			this.bodyWindow = body.length;
			return body;
		}
		this.bodyWindow = Math.max(1, room - 1);
		this.bodyScroll = Math.min(this.bodyScroll, body.length - this.bodyWindow);
		const start = this.bodyScroll;
		const end = start + this.bodyWindow;
		const position = `  (${start + 1}-${end}/${body.length}) ${keyText("tui.select.pageUp")}/${keyText("tui.select.pageDown")} scroll`;
		return [...body.slice(start, end), truncateToWidth(theme.fg("muted", position), width)];
	}

	private scrollBody(direction: -1 | 1): void {
		this.bodyScroll = Math.max(0, this.bodyScroll + direction * Math.max(1, this.bodyWindow - 1));
		this.tui?.requestRender();
	}

	private updateList(): void {
		this.listContainer.clear();

		const maxVisible = this.maxVisible;
		// Center the window on the selection, then clamp it to the list boundaries.
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.options.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.options.length);

		for (let i = startIndex; i < endIndex; i++) {
			const isSelected = i === this.selectedIndex;
			const binding = OPTION_KEYBINDINGS[i];
			const shortcut = binding ? keyText(binding) : "";
			const label = `${shortcut ? `${shortcut}. ` : ""}${this.options[i]}`;
			const text = isSelected
				? theme.fg("accent", "→ ") + theme.fg("accent", label)
				: `  ${theme.fg("text", label)}`;
			this.listContainer.addChild(new Text(text, 1, 0));
		}

		if (startIndex > 0 || endIndex < this.options.length) {
			const scrollInfo = theme.fg("muted", `  (${this.selectedIndex + 1}/${this.options.length})`);
			this.listContainer.addChild(new Text(scrollInfo, 0, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.pageUp")) {
			this.scrollBody(-1);
		} else if (kb.matches(keyData, "tui.select.pageDown")) {
			this.scrollBody(1);
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		} else {
			const index = OPTION_KEYBINDINGS.findIndex((binding) => kb.matches(keyData, binding));
			const selected = this.options[index];
			if (selected !== undefined) this.onSelectCallback(selected);
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
