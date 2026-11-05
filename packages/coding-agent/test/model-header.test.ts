import { visibleWidth } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import {
	ModelHeader,
	type ModelHeaderInfo,
	petPose,
	providerLogo,
	renderPet,
} from "../src/modes/interactive/components/model-header.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

const info: ModelHeaderInfo = {
	modelId: "glm-5.3-flash",
	provider: "zai",
	thinking: "high",
	contextWindow: 1_000_000,
	inputCost: 0.5,
	outputCost: 2,
	version: "1.4.0",
};

function header(options: { canAnimate?: () => boolean; getInfo?: () => ModelHeaderInfo | undefined } = {}) {
	const created = new ModelHeader({
		getInfo: options.getInfo ?? (() => info),
		isWorking: () => false,
		canAnimate: options.canAnimate ?? (() => true),
		requestRender: () => {},
		collapsedHints: () => "esc interrupt",
		expandedHints: () => "esc to interrupt\nctrl+c to clear",
		expanded: false,
	});
	created.dispose();
	return created;
}

describe("ModelHeader", () => {
	beforeAll(() => {
		initTheme("github-dark");
	});

	it("maps providers and model ids to logos", () => {
		expect(providerLogo("anthropic", "claude-opus-5-5")).toBe("anthropic");
		expect(providerLogo("openai-codex", "gpt-5.5")).toBe("openai");
		expect(providerLogo("zai", "glm-5.3-flash")).toBe("zai");
		expect(providerLogo("commandcode", "glm-5.3")).toBe("zai");
		expect(providerLogo("openrouter", "deepseek/deepseek-v4.1")).toBe("deepseek");
		expect(providerLogo("google", "gemini-3-pro")).toBeUndefined();
	});

	it("blinks while idle and hops while working", () => {
		expect(petPose(0, false).closed).toBe(true);
		expect(petPose(1000, false).closed).toBe(false);
		const shapes = new Set([0, 140, 280, 420].map((ms) => petPose(ms, true).shape.join("")));
		expect(shapes.size).toBe(3);
	});

	it("draws the pet in three rows of eight cells", () => {
		const pet = renderPet(petPose(1000, false));
		expect(pet).toHaveLength(3);
		for (const line of pet) expect(visibleWidth(line)).toBe(8);
	});

	it("shows the pet, the logo and the model details beside each other", () => {
		const lines = header().render(100).map(strip);
		expect(lines[0]).toContain("glm-5.3-flash");
		expect(lines[1]).toContain("Z.ai · thinking high");
		expect(lines[2]).toContain("1M ctx · $0.5/$2 per M · v1.4.0");
		expect(lines[4]).toContain("esc interrupt");
		expect(lines).toHaveLength(5);
	});

	it("shows the full key list when expanded", () => {
		const created = header();
		created.setExpanded(true);
		const lines = created.render(100).map(strip);
		expect(lines.slice(4)).toEqual([" esc to interrupt", " ctrl+c to clear"]);
	});

	it("keeps its last lines while it cannot animate", () => {
		let model = "glm-5.3-flash";
		let visible = true;
		const created = header({ canAnimate: () => visible, getInfo: () => ({ ...info, modelId: model }) });
		const first = created.render(100);
		visible = false;
		model = "glm-5.3";
		expect(created.render(100)).toBe(first);
		visible = true;
		expect(strip(created.render(100)[0]!)).toMatch(/glm-5\.3$/);
	});

	it("asks for a model when none is selected", () => {
		const lines = header({ getInfo: () => undefined })
			.render(100)
			.map(strip);
		expect(lines[0]).toContain("no model selected");
	});
});
