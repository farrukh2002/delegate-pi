import { type Component, getKeybindings, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { DelegateManager } from "../../core/delegate/manager.ts";
import { clock, elapsed, MARKS, statusText, TERMINAL } from "../../core/delegate/view.ts";
import { type DelegateStyle, resolveDelegateStyle } from "../../modes/interactive/components/delegate-style.ts";
import type { Theme, ThemeColor } from "../../modes/interactive/theme/theme.ts";

export interface DelegateTasksScreenOptions {
	tui?: TUI;
	style?: Partial<DelegateStyle>;
}

export function createTasksScreen(
	manager: DelegateManager,
	theme: Theme,
	done: () => void,
	options: DelegateTasksScreenOptions = {},
): Component & { dispose?(): void } {
	let closed = false;
	let cursor = 0;
	const style = resolveDelegateStyle(options.style);

	return {
		render(width: number): string[] {
			const rows = manager.allTasks();
			const height = Math.max(3, options.tui?.terminal.rows ?? 24);
			const lines = [truncateToWidth(theme.fg(style.accent, "Delegate tasks"), width, "…")];
			const footer = "esc to close · up/down to move";

			if (rows.length === 0) {
				lines.push(truncateToWidth(theme.fg(style.subtle, "No child tasks yet."), width, "…"));
			} else {
				if (cursor >= rows.length) cursor = rows.length - 1;
				const perTask = 2;
				const visibleCount = Math.max(1, Math.floor((height - 3) / perTask));
				let start = 0;
				if (cursor >= visibleCount) start = cursor - visibleCount + 1;

				for (let index = start; index < rows.length && lines.length < height - 1; index++) {
					const task = rows[index]!;
					const [mark, markColor] = MARKS[task.status] ?? ["·", "muted"];
					const meta = `${statusText(task)} · ${clock(elapsed(task))}${task.scope.length ? ` · ${task.scope.join(", ")}` : " · read-only"}`;
					const body = `${theme.fg(markColor as ThemeColor, mark)} ${theme.fg(style.text, task.agent)} ${theme.fg(style.muted, meta)}`;
					lines.push(
						truncateToWidth(index === cursor ? theme.style(body, { underline: true }) : body, width, "…"),
					);
					if (lines.length >= height - 1) break;
					const suffix = TERMINAL.includes(task.status) ? "" : " (running)";
					lines.push(
						truncateToWidth(theme.fg(style.subtle, `  ${task.taskId}${suffix} ${task.task}`), width, "…"),
					);
				}
			}

			lines.push(truncateToWidth(theme.fg(style.muted, footer), width, "…"));
			return lines.slice(0, height).map((line) => truncateToWidth(line, width, "…"));
		},
		handleInput(data: string): void {
			if (closed) return;
			const keybindings = getKeybindings();
			const rows = manager.allTasks();
			if (keybindings.matches(data, "app.delegate.escape")) {
				closed = true;
				done();
				return;
			}
			if (keybindings.matches(data, "app.delegate.down") && rows.length > 0) {
				cursor = Math.min(cursor + 1, rows.length - 1);
				options.tui?.requestRender();
			} else if (keybindings.matches(data, "app.delegate.up")) {
				cursor = Math.max(cursor - 1, 0);
				options.tui?.requestRender();
			}
		},
		invalidate(): void {},
		dispose(): void {
			closed = true;
		},
	};
}
