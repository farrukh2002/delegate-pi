import type { ThemeColor } from "../theme/theme.ts";

export interface DelegateStyle {
	accent: ThemeColor;
	inactive: ThemeColor;
	subtle: ThemeColor;
	track: ThemeColor;
	text: ThemeColor;
	muted: ThemeColor;
	warning: ThemeColor;
	success: ThemeColor;
	error: ThemeColor;
}

export const DEFAULT_DELEGATE_STYLE: DelegateStyle = {
	accent: "accent",
	inactive: "muted",
	subtle: "dim",
	track: "borderMuted",
	text: "text",
	muted: "muted",
	warning: "warning",
	success: "success",
	error: "error",
};

export function resolveDelegateStyle(overrides: Partial<DelegateStyle> = {}): DelegateStyle {
	return { ...DEFAULT_DELEGATE_STYLE, ...overrides };
}
