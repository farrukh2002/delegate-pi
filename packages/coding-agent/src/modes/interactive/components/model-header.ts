import {
	backgroundAnsi,
	type Component,
	foregroundAnsi,
	type RgbColorValue,
	rgbColor,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";

export type ProviderLogo = "anthropic" | "openai" | "zai" | "deepseek";

export interface ModelHeaderInfo {
	modelId: string;
	provider: string;
	thinking: string | undefined;
	contextWindow: number | undefined;
	inputCost: number | undefined;
	outputCost: number | undefined;
	version: string;
}

export interface ModelHeaderOptions {
	getInfo: () => ModelHeaderInfo | undefined;
	isWorking: () => boolean;
	canAnimate: () => boolean;
	requestRender: () => void;
	collapsedHints: () => string;
	expandedHints: () => string;
	expanded: boolean;
}

const LOGOS: Record<ProviderLogo, [string, string, string]> = {
	anthropic: [" 🬦🬱🬦🬓 ", "🬞🬴🬸🬓🬬🬏", "🬎🬀 🬊 🬎"],
	openai: ["🬞🬜🬙🬪🬖🬓", "🬣🬛🬴🬸🬫🬧", "🬉🬅🬪🬳🬜🬀"],
	zai: ["🬇🬋🬃🬵🬹🬃", " 🬞🬻🬝🬀 ", "🬇🬎🬆🬇🬋🬃"],
	deepseek: ["🬞🬵🬹🬏🬱🬭", "🬴🬂🬬█🬝 ", "🬁🬈🬎🬆🬀 "],
};

const PROVIDER_NAMES: Record<string, string> = {
	anthropic: "Anthropic",
	openai: "OpenAI",
	"openai-codex": "OpenAI Codex",
	zai: "Z.ai",
	deepseek: "DeepSeek",
	commandcode: "Command Code",
};

const DEEPSEEK_BLUE = rgbColor(77, 107, 254);
const RESET = "\x1b[0m";
const FRAME_MS = 140;
const PET_WIDTH = 8;

const BODY = ["..gggg..", ".ghgggg.", "gggggggg", "gggggggg", "gggggggg", ".gggggg."];
const HOP = ["..gggg..", ".ghgggg.", "gggggggg", "gggggggg", ".gggggg.", "........"];
const SQUASH = ["........", "..gggg..", ".ghgggg.", "gggggggg", "gggggggg", "gggggggg"];

interface PetPose {
	shape: string[];
	eyeRow: number;
	look: number;
	closed: boolean;
}

export function providerLogo(provider: string, modelId: string): ProviderLogo | undefined {
	const id = modelId.toLowerCase();
	if (provider === "anthropic" || id.includes("claude")) return "anthropic";
	if (provider === "zai" || id.startsWith("glm") || id.includes("/glm")) return "zai";
	if (provider === "deepseek" || id.includes("deepseek")) return "deepseek";
	if (provider.startsWith("openai") || /(^|\/)(gpt|o\d|codex)/.test(id)) return "openai";
	return undefined;
}

function formatTokens(count: number): string {
	if (count >= 1_000_000) return `${Number((count / 1_000_000).toFixed(1))}M`;
	if (count >= 1_000) return `${Math.round(count / 1_000)}K`;
	return String(count);
}

function formatPrice(value: number): string {
	return value >= 10 ? value.toFixed(0) : Number(value.toFixed(2)).toString();
}

export function petPose(elapsedMs: number, working: boolean): PetPose {
	const frame = Math.floor(elapsedMs / FRAME_MS);
	if (working) {
		const shapes = [BODY, HOP, BODY, SQUASH];
		const shape = shapes[frame % shapes.length]!;
		const looks = [0, 0, -1, 0, 0, 1];
		return {
			shape,
			eyeRow: shape === SQUASH ? 3 : 2,
			look: looks[Math.floor(frame / 8) % looks.length]!,
			closed: false,
		};
	}
	const cycle = elapsedMs % 4200;
	const round = Math.floor(elapsedMs / 4200);
	const look = round % 5 === 2 && cycle > 1200 && cycle < 2600 ? (round % 2 === 0 ? -1 : 1) : 0;
	return { shape: BODY, eyeRow: 2, look, closed: cycle < 160 || (round % 3 === 1 && cycle > 300 && cycle < 440) };
}

function petPixels(pose: PetPose): string[] {
	return pose.shape.map((row, y) => {
		if (y !== pose.eyeRow || pose.closed) return row;
		const cells = row.split("");
		cells[2 + pose.look] = "e";
		cells[5 + pose.look] = "e";
		return cells.join("");
	});
}

function petColors(): Record<string, RgbColorValue> {
	return theme.appearance === "light"
		? { g: rgbColor(45, 164, 78), h: rgbColor(116, 210, 140), e: rgbColor(31, 35, 40) }
		: { g: rgbColor(63, 185, 80), h: rgbColor(126, 231, 135), e: rgbColor(13, 17, 23) };
}

export function renderPet(pose: PetPose): string[] {
	const mode = theme.getColorMode();
	const colors = petColors();
	const pixels = petPixels(pose);
	const lines: string[] = [];
	for (let y = 0; y < pixels.length; y += 2) {
		let line = "";
		for (let x = 0; x < PET_WIDTH; x++) {
			const top = colors[pixels[y]![x]!];
			const bottom = colors[pixels[y + 1]![x]!];
			if (!top && !bottom) line += " ";
			else if (!top) line += `${foregroundAnsi(bottom!, mode)}▄${RESET}`;
			else if (!bottom) line += `${foregroundAnsi(top, mode)}▀${RESET}`;
			else if (top === bottom) line += `${foregroundAnsi(top, mode)}█${RESET}`;
			else line += `${foregroundAnsi(top, mode)}${backgroundAnsi(bottom, mode)}▀${RESET}`;
		}
		lines.push(line);
	}
	return lines;
}

function logoLines(logo: ProviderLogo | undefined): string[] {
	if (!logo) return [];
	const rows = LOGOS[logo];
	if (logo === "deepseek") {
		const blue = foregroundAnsi(DEEPSEEK_BLUE, theme.getColorMode());
		return rows.map((row) => `${blue}${row}${RESET}`);
	}
	return rows.map((row) => theme.fg("text", row));
}

function detailLines(info: ModelHeaderInfo | undefined): string[] {
	if (!info) return [theme.fg("warning", "no model selected"), theme.fg("dim", "/model to pick one"), ""];
	const provider = PROVIDER_NAMES[info.provider] ?? info.provider;
	const second = [provider, info.thinking ? `thinking ${info.thinking}` : undefined].filter(Boolean).join(" · ");
	const facts: string[] = [];
	if (info.contextWindow) facts.push(`${formatTokens(info.contextWindow)} ctx`);
	if (info.inputCost || info.outputCost) {
		facts.push(`$${formatPrice(info.inputCost ?? 0)}/$${formatPrice(info.outputCost ?? 0)} per M`);
	}
	facts.push(`v${info.version}`);
	return [theme.bold(theme.fg("text", info.modelId)), theme.fg("muted", second), theme.fg("dim", facts.join(" · "))];
}

export class ModelHeader implements Component {
	onPetClick: ((column: number, row: number) => void) | undefined;
	private readonly options: ModelHeaderOptions;
	private expanded: boolean;
	private readonly startedAt = Date.now();
	private timer: ReturnType<typeof setInterval> | undefined;
	private lastKey = "";
	private cached: { width: number; lines: string[] } | undefined;

	constructor(options: ModelHeaderOptions) {
		this.options = options;
		this.expanded = options.expanded;
		this.timer = setInterval(() => this.tick(), FRAME_MS);
		this.timer.unref?.();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.cached = undefined;
	}

	invalidate(): void {
		this.cached = undefined;
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (event.type !== "click" || event.y > 2 || event.x < 1 || event.x > PET_WIDTH || !this.onPetClick) {
			return undefined;
		}
		this.onPetClick(event.screenX - event.x + 1, event.screenY - event.y);
		return { handled: true };
	}

	render(width: number): string[] {
		if (this.cached && this.cached.width === width && !this.options.canAnimate()) return this.cached.lines;
		const lines = this.build(width);
		this.cached = { width, lines };
		return lines;
	}

	private pose(): PetPose {
		return petPose(Date.now() - this.startedAt, this.options.isWorking());
	}

	private tick(): void {
		if (!this.options.canAnimate()) return;
		const pose = this.pose();
		const info = this.options.getInfo();
		const key = `${petPixels(pose).join("")}|${JSON.stringify(info)}`;
		if (key === this.lastKey) return;
		this.lastKey = key;
		this.cached = undefined;
		this.options.requestRender();
	}

	private build(width: number): string[] {
		const info = this.options.getInfo();
		const pet = renderPet(this.pose());
		const logo = logoLines(info ? providerLogo(info.provider, info.modelId) : undefined);
		const details = detailLines(info);
		const top = pet.map((petLine, row) => {
			const parts = [` ${petLine}`];
			if (logo.length > 0) parts.push(logo[row]!);
			parts.push(details[row]!);
			return truncateToWidth(parts.join("  "), width);
		});
		const hints = (this.expanded ? this.options.expandedHints() : this.options.collapsedHints())
			.split("\n")
			.map((line) => truncateToWidth(` ${line}`, width));
		return [...top, "", ...hints];
	}
}
