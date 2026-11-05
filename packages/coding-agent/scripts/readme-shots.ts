import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { colorToHex, setKeybindings, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { LiveRow, TaskView } from "../src/core/delegate/view.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import type { FileEntry, SessionEntry } from "../src/core/session-manager.ts";
import { renderDelegateCall, renderDelegateResult, renderReportMessage } from "../src/extensions/delegate/renderers.ts";
import { createStatsScreen } from "../src/extensions/stats/index.ts";
import { gatherStats } from "../src/extensions/stats/stats.ts";
import { createUsageScreen } from "../src/extensions/usage/index.ts";
import { DelegateBand } from "../src/modes/interactive/components/delegate-band.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { FooterComponent } from "../src/modes/interactive/components/footer.ts";
import { ModelHeader } from "../src/modes/interactive/components/model-header.ts";
import { WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { initTheme, theme, themeBackgroundColor } from "../src/modes/interactive/theme/theme.ts";

const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", ".github", "readme");
const WIDTH = 96;
const CELL = 8.43;
const LINE = 19;
const PAD_X = 22;
const TOP = 46;

const BASIC = [
	"#484f58",
	"#ff7b72",
	"#3fb950",
	"#d29922",
	"#58a6ff",
	"#bc8cff",
	"#39c5cf",
	"#b1bac4",
	"#6e7681",
	"#ffa198",
	"#56d364",
	"#e3b341",
	"#79c0ff",
	"#d2a8ff",
	"#56d4dd",
	"#ffffff",
];

function xterm256(n: number): string {
	if (n < 16) return BASIC[n]!;
	if (n >= 232) {
		const v = 8 + (n - 232) * 10;
		return `#${v.toString(16).padStart(2, "0").repeat(3)}`;
	}
	const i = n - 16;
	const level = (x: number) => (x === 0 ? 0 : 55 + x * 40).toString(16).padStart(2, "0");
	return `#${level(Math.floor(i / 36))}${level(Math.floor(i / 6) % 6)}${level(i % 6)}`;
}

type Style = { fg?: string; bg?: string; bold?: boolean; dim?: boolean; italic?: boolean; underline?: boolean; inverse?: boolean };
type Run = { col: number; text: string; width: number; style: Style };

function applySgr(style: Style, params: number[]): Style {
	const next = { ...style };
	for (let i = 0; i < params.length; i++) {
		const p = params[i]!;
		if (p === 0) for (const key of Object.keys(next)) delete next[key as keyof Style];
		else if (p === 1) next.bold = true;
		else if (p === 2) next.dim = true;
		else if (p === 3) next.italic = true;
		else if (p === 4) next.underline = true;
		else if (p === 7) next.inverse = true;
		else if (p === 22) {
			next.bold = false;
			next.dim = false;
		} else if (p === 23) next.italic = false;
		else if (p === 24) next.underline = false;
		else if (p === 27) next.inverse = false;
		else if (p === 39) delete next.fg;
		else if (p === 49) delete next.bg;
		else if ((p >= 30 && p <= 37) || (p >= 90 && p <= 97)) next.fg = BASIC[p >= 90 ? p - 82 : p - 30];
		else if ((p >= 40 && p <= 47) || (p >= 100 && p <= 107)) next.bg = BASIC[p >= 100 ? p - 92 : p - 40];
		else if (p === 38 || p === 48) {
			const key = p === 38 ? "fg" : "bg";
			if (params[i + 1] === 2) {
				const [r, g, b] = params.slice(i + 2, i + 5);
				next[key] = `#${[r, g, b].map((v) => (v ?? 0).toString(16).padStart(2, "0")).join("")}`;
				i += 4;
			} else if (params[i + 1] === 5) {
				next[key] = xterm256(params[i + 2] ?? 0);
				i += 2;
			}
		}
	}
	return next;
}

const segmenter = new Intl.Segmenter();

function parseLine(line: string): Run[] {
	const clean = line.replace(/\x1b\]8;[^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b_[^\x07\x1b]*(\x07|\x1b\\)/g, "");
	const runs: Run[] = [];
	let style: Style = {};
	let col = 0;
	for (const part of clean.split(/(\x1b\[[0-9;:]*[A-Za-z])/)) {
		if (!part) continue;
		const sgr = /^\x1b\[([0-9;:]*)m$/.exec(part);
		if (sgr) {
			style = applySgr(
				style,
				(sgr[1] || "0").split(/[;:]/).map((v) => Number(v || 0)),
			);
			continue;
		}
		if (part.startsWith("\x1b")) continue;
		for (const { segment } of segmenter.segment(part)) {
			const width = visibleWidth(segment);
			const last = runs[runs.length - 1];
			if (last && JSON.stringify(last.style) === JSON.stringify(style) && width === 1 && last.width === last.text.length) {
				last.text += segment;
				last.width += 1;
			} else runs.push({ col, text: segment, width, style: { ...style } });
			col += width;
		}
	}
	return runs;
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function svg(title: string, lines: string[], background: string, foreground: string): string {
	const width = Math.round(PAD_X * 2 + WIDTH * CELL);
	const height = Math.round(TOP + lines.length * LINE + 20);
	const body = cells(lines, background, foreground, PAD_X, TOP);
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeXml(title)}">
<style>text{font-family:${FONT};font-size:14px;white-space:pre}</style>
<rect width="${width}" height="${height}" rx="12" fill="${background}"/>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="12" fill="none" stroke="#30363d"/>
<circle cx="22" cy="18" r="6" fill="#ff5f57"/><circle cx="42" cy="18" r="6" fill="#febc2e"/><circle cx="62" cy="18" r="6" fill="#28c840"/>
<text x="${width / 2}" y="23" fill="#7d8590" text-anchor="middle" style="font-size:12px">${escapeXml(title)}</text>
${body.join("\n")}
</svg>
`;
}

const FONT = `ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace`;

const QUADRANTS: Record<string, number> = {
	"▘": 1,
	"▝": 2,
	"▀": 3,
	"▖": 4,
	"▌": 5,
	"▞": 6,
	"▛": 7,
	"▗": 8,
	"▚": 9,
	"▐": 10,
	"▜": 11,
	"▄": 12,
	"▙": 13,
	"▟": 14,
	"█": 15,
};

function blockGrid(char: string): { rows: number; bits: number } | undefined {
	const quadrant = QUADRANTS[char];
	if (quadrant !== undefined) return { rows: 2, bits: quadrant };
	const code = char.codePointAt(0) ?? 0;
	if (code < 0x1fb00 || code > 0x1fb3b) return undefined;
	let bits = code - 0x1fb00 + 1;
	if (bits >= 21) bits += 1;
	if (bits >= 42) bits += 1;
	return { rows: 3, bits };
}

function blockRects(char: string, x: number, y: number, fill: string): string | undefined {
	const grid = blockGrid(char);
	if (!grid) return undefined;
	const h = LINE / grid.rows;
	const w = CELL / 2;
	let out = "";
	for (let i = 0; i < grid.rows * 2; i++) {
		if (!(grid.bits & (1 << i))) continue;
		const cx = x + (i % 2) * w;
		const cy = y + Math.floor(i / 2) * h;
		out += `<rect x="${cx.toFixed(2)}" y="${cy.toFixed(2)}" width="${(w + 0.7).toFixed(2)}" height="${(h + 0.7).toFixed(2)}" fill="${fill}" shape-rendering="crispEdges"/>`;
	}
	return out;
}

function textNode(text: string, width: number, x: number, y: number, fg: string, style: Style): string {
	const attrs = [
		`x="${x.toFixed(1)}"`,
		`y="${y + 14}"`,
		`fill="${fg}"`,
		width === text.length && width > 1 ? `textLength="${(width * CELL).toFixed(1)}"` : "",
		style.bold ? 'font-weight="700"' : "",
		style.dim ? 'opacity="0.6"' : "",
		style.italic ? 'font-style="italic"' : "",
		style.underline ? 'text-decoration="underline"' : "",
	].filter(Boolean);
	return `<text ${attrs.join(" ")}>${escapeXml(text)}</text>`;
}

function cells(lines: string[], background: string, foreground: string, left: number, top: number): string[] {
	const body: string[] = [];
	lines.forEach((line, row) => {
		const y = top + row * LINE;
		for (const run of parseLine(line)) {
			let fg = run.style.fg ?? foreground;
			let bg = run.style.bg;
			if (run.style.inverse) [fg, bg] = [bg ?? background, fg];
			const x = left + run.col * CELL;
			if (bg && bg !== background) {
				body.push(
					`<rect x="${x.toFixed(1)}" y="${y - 1}" width="${(run.width * CELL + 0.6).toFixed(1)}" height="${LINE + 0.5}" fill="${bg}"/>`,
				);
			}
			if (!run.text.trim()) continue;
			if (run.width !== run.text.length || ![...run.text].some((char) => blockGrid(char))) {
				body.push(textNode(run.text, run.width, x, y, fg, run.style));
				continue;
			}
			let pending = "";
			let pendingCol = 0;
			const flush = () => {
				if (pending.trim()) body.push(textNode(pending, pending.length, x + pendingCol * CELL, y, fg, run.style));
				pending = "";
			};
			[...run.text].forEach((char, i) => {
				const rects = blockRects(char, x + i * CELL, y - 1, fg);
				if (rects === undefined) {
					if (!pending) pendingCol = i;
					pending += char;
					return;
				}
				flush();
				body.push(rects);
			});
			flush();
		}
	});
	return body;
}

const BRAND_FONT_DIR = process.env.MAPLE_MONO_DIR ?? join(homedir(), ".local", "share", "fonts");
const BRAND_FONTS: Array<[number, string]> = [
	[400, "MapleMono-NF-Regular.ttf"],
	[700, "MapleMono-NF-Bold.ttf"],
];

function decodeXml(text: string): string {
	return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function withBrandFont(svg: string): string {
	const used = new Set<string>();
	for (const [, text] of svg.matchAll(/>([^<]+)</g)) for (const char of decodeXml(text!)) used.add(char);
	const unicodes = [...used].map((char) => `U+${char.codePointAt(0)!.toString(16)}`).join(",");
	const work = mkdtempSync(join(tmpdir(), "readme-font-"));
	try {
		const faces = BRAND_FONTS.map(([weight, file]) => {
			const source = join(BRAND_FONT_DIR, file);
			if (!existsSync(source)) throw new Error(`${source} is missing. Install Maple Mono NF or set MAPLE_MONO_DIR.`);
			const out = join(work, `${weight}.woff2`);
			execFileSync("pyftsubset", [source, `--unicodes=${unicodes}`, "--flavor=woff2", "--layout-features=", "--no-hinting", "--desubroutinize", `--output-file=${out}`]);
			const data = readFileSync(out).toString("base64");
			return `@font-face{font-family:"Maple Mono";font-weight:${weight};src:url(data:font/woff2;base64,${data}) format("woff2")}`;
		});
		return svg.replace("<style>", `<style>\n${faces.join("\n")}`).replaceAll(`font-family:${FONT}`, `font-family:"Maple Mono",${FONT}`);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

const PET_BODY =["..gggg..", ".ghgggg.", "gggggggg", "gggggggg", "gggggggg", ".gggggg."];

function petSvg(pixel: number): string {
	const colors: Record<string, string> = { g: "#3fb950", h: "#7ee787" };
	const rects: string[] = [];
	PET_BODY.forEach((row, y) => {
		for (let x = 0; x < row.length; x++) {
			const fill = colors[row[x]!];
			if (fill) rects.push(`<rect x="${x * pixel}" y="${y * pixel}" width="${pixel + 0.5}" height="${pixel + 0.5}" fill="${fill}"/>`);
		}
	});
	const eye = (x: number) =>
		`<rect class="eye" x="${x * pixel}" y="${2 * pixel}" width="${pixel}" height="${pixel}" fill="#0d1117"/>`;
	return `<g class="pet" shape-rendering="crispEdges">${rects.join("")}<g class="eyes">${eye(2)}${eye(5)}</g></g>`;
}

function banner(background: string): string {
	const width = Math.round(PAD_X * 2 + WIDTH * CELL);
	const height = 300;
	const pixel = 20;
	const charWidth = 7.8;
	const chips = [
		["✻", "#58a6ff", "cmd-worker", "spin"],
		["✻", "#58a6ff", "cx-worker", "spin slow"],
		["?", "#d29922", "pi-scout", "ask"],
		["✓", "#3fb950", "pi-worker", ""],
	];
	let chipX = 274;
	const chipSvg = chips
		.map(([mark, color, name, motion]) => {
			const textWidth = name!.length * charWidth;
			const w = 34 + textWidth + 18;
			const out = `<g transform="translate(${chipX.toFixed(1)},212)"><rect width="${w.toFixed(1)}" height="32" rx="16" fill="#161b22" stroke="#30363d"/><text class="${motion}" x="16" y="21" fill="${color}">${mark}</text><text x="34" y="21" fill="#c9d1d9" textLength="${textWidth.toFixed(1)}" lengthAdjust="spacingAndGlyphs">${name}</text></g>`;
			chipX += w + 10;
			return out;
		})
		.join("\n");
	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="delegate-pi">
<defs>
<radialGradient id="glow" cx="78%" cy="20%" r="70%"><stop offset="0" stop-color="#1f6feb" stop-opacity="0.35"/><stop offset="1" stop-color="#1f6feb" stop-opacity="0"/></radialGradient>
<radialGradient id="glow2" cx="8%" cy="100%" r="55%"><stop offset="0" stop-color="#3fb950" stop-opacity="0.22"/><stop offset="1" stop-color="#3fb950" stop-opacity="0"/></radialGradient>
<pattern id="dots" width="18" height="18" patternUnits="userSpaceOnUse"><circle cx="1" cy="1" r="1" fill="#30363d"/></pattern>
</defs>
<style>
text{font-family:${FONT};font-size:13px;white-space:pre}
.pet{transform-box:fill-box;transform-origin:50% 100%;animation:hop 5s ease-in-out infinite}
.eyes{animation:look 10s steps(1,end) infinite}
.eye{transform-box:fill-box;transform-origin:50% 50%;animation:blink 5s infinite}
.shadow{transform-box:fill-box;transform-origin:50% 50%;animation:shadow 5s ease-in-out infinite}
.spin{transform-box:fill-box;transform-origin:50% 50%;animation:spin 2.4s linear infinite}
.slow{animation-duration:3.6s}
.ask{animation:ask 1.6s ease-in-out infinite}
.glow{animation:breathe 9s ease-in-out infinite}
@keyframes hop{0%,60%,100%{transform:translateY(0) scale(1,1)}67%{transform:translateY(0) scale(1.08,.86)}76%{transform:translateY(-26px) scale(.94,1.08)}85%{transform:translateY(0) scale(1.07,.9)}92%{transform:translateY(0) scale(1,1)}}
@keyframes shadow{0%,60%,100%{transform:scale(1);opacity:.5}76%{transform:scale(.7);opacity:.25}85%{transform:scale(1.08);opacity:.55}}
@keyframes blink{0%,30%,34%,100%{transform:scaleY(1)}32%{transform:scaleY(.12)}}
@keyframes look{0%{transform:translateX(0)}40%{transform:translateX(-${pixel}px)}52%{transform:translateX(0)}70%{transform:translateX(${pixel}px)}80%{transform:translateX(0)}}
@keyframes spin{to{transform:rotate(360deg)}}
@keyframes ask{0%,100%{opacity:1}50%{opacity:.3}}
@keyframes breathe{0%,100%{opacity:1}50%{opacity:.6}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
<rect width="${width}" height="${height}" rx="16" fill="${background}"/>
<rect width="${width}" height="${height}" rx="16" fill="url(#dots)" opacity="0.6"/>
<rect class="glow" width="${width}" height="${height}" rx="16" fill="url(#glow)"/>
<rect width="${width}" height="${height}" rx="16" fill="url(#glow2)"/>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="16" fill="none" stroke="#30363d"/>
<ellipse class="shadow" cx="${70 + 4 * pixel}" cy="${92 + 6 * pixel + 14}" rx="${3.6 * pixel}" ry="7" fill="#000"/>
<g transform="translate(70,92)">${petSvg(pixel)}</g>
<text x="270" y="122" fill="#f0f6fc" style="font-size:58px;font-weight:700;letter-spacing:-1px">delegate<tspan fill="#58a6ff">-pi</tspan></text>
<text x="274" y="162" fill="#8b949e" style="font-size:18px">pi, with sandboxed subagents built in.</text>
${chipSvg}
</svg>
`;
}

function keyframes(name: string, steps: Array<[number[], string]>): string {
	return `@keyframes ${name}{${steps.map(([at, css]) => `${at.map((p) => `${p}%`).join(",")}{${css}}`).join("")}}`;
}

function shown(name: string, from: number, to = 100): string {
	const steps: Array<[number[], string]> = [[[0, Math.max(from - 1.5, 0)], "opacity:0"]];
	if (to >= 100) steps.push([[from, 100], "opacity:1"]);
	else steps.push([[from, to], "opacity:1"], [[Math.min(to + 1.5, 100), 100], "opacity:0"]);
	return keyframes(name, steps);
}

function explainer(background: string): string {
	const width = Math.round(PAD_X * 2 + WIDTH * CELL);
	const height = 476;
	const css: string[] = [];
	const body: string[] = [];
	const anim = (cls: string, rule: string) => css.push(`.${cls}{animation:${cls} 14s linear infinite;${rule}}`);

	css.push(keyframes("scene", [[[0], "opacity:0"], [[2, 95], "opacity:1"], [[99, 100], "opacity:0"]]));
	css.push(".scene{animation:scene 14s linear infinite}");

	const steps = [
		["1", "ask", 0, 12],
		["2", "delegate", 12, 24],
		["3", "run in sandboxes", 24, 70],
		["4", "review", 70, 100],
	] as const;
	steps.forEach(([num, label, from, to], i) => {
		const x = 24 + i * 202;
		const cls = `step${i}`;
		css.push(shown(cls, from + 1, to));
		anim(cls, "");
		body.push(
			`<rect x="${x}" y="22" width="190" height="34" rx="17" fill="#161b22" stroke="#30363d"/>`,
			`<rect class="${cls}" x="${x}" y="22" width="190" height="34" rx="17" fill="#1f6feb" fill-opacity="0.18" stroke="#58a6ff"/>`,
			`<circle cx="${x + 20}" cy="39" r="10" fill="#21262d"/><text x="${x + 20}" y="43.5" fill="#58a6ff" text-anchor="middle" font-weight="700">${num}</text>`,
			`<text x="${x + 38}" y="43.5" fill="#c9d1d9">${label}</text>`,
		);
	});

	const prompt = "fix the footer, add tests";
	css.push(keyframes("type", [[[0, 2], "transform:translateX(0)"], [[10, 100], `transform:translateX(${prompt.length * 7.8 + 4}px)`]]));
	anim("type", "");
	body.push(
		`<rect x="24" y="88" width="270" height="76" rx="10" fill="#161b22" stroke="#30363d"/>`,
		`<text x="40" y="112" fill="#8b949e" style="font-size:12px">you</text>`,
		`<text x="40" y="142" fill="#e6edf3"><tspan fill="#58a6ff">› </tspan>${prompt}</text>`,
		`<clipPath id="you"><rect x="25" y="89" width="268" height="74" rx="9"/></clipPath>`,
		`<g clip-path="url(#you)"><rect class="type" x="56" y="126" width="${prompt.length * 7.8 + 8}" height="24" fill="#161b22"/></g>`,
	);

	css.push(shown("down", 10), shown("call", 12));
	anim("down", "");
	anim("call", "");
	body.push(
		`<path class="down" d="M159 164 V200" stroke="#58a6ff" stroke-width="2" stroke-dasharray="4 4"/>`,
		`<rect x="24" y="200" width="270" height="124" rx="10" fill="#161b22" stroke="#30363d"/>`,
		`<g transform="translate(42,220)">${petSvg(7)}</g>`,
		`<text x="112" y="236" fill="#e6edf3" font-weight="700">delegate-pi</text>`,
		`<text x="112" y="256" fill="#8b949e" style="font-size:12px">the model you talk to</text>`,
		`<g class="call"><rect x="40" y="280" width="238" height="28" rx="6" fill="#0d1117" stroke="#30363d"/><text x="52" y="299" fill="#d2a8ff">delegate<tspan fill="#8b949e">(</tspan><tspan fill="#e6edf3">3 tasks</tspan><tspan fill="#8b949e">)</tspan></text></g>`,
	);

	const tasks = [
		{ name: "pi-scout", harness: "pi", scope: "read-only", activity: "read 14 files", done: 52, color: "#bc8cff" },
		{ name: "cx-worker", harness: "Codex", scope: "src/core", activity: "edit src/core/footer.ts", done: 66, color: "#58a6ff" },
		{ name: "cmd-worker", harness: "Command Code", scope: "test/", activity: "write test/footer.test.ts", done: 60, color: "#39c5cf" },
	];
	tasks.forEach((task, i) => {
		const x = 352;
		const y = 88 + i * 106;
		const w = width - 24 - x;
		const appear = 14 + i * 3;
		const start = 26 + i * 2;
		const id = `t${i}`;
		css.push(
			keyframes(`${id}line`, [[[0, appear - 2], "stroke-dashoffset:1"], [[appear + 4, 100], "stroke-dashoffset:0"]]),
			shown(`${id}box`, appear),
			shown(`${id}wait`, appear, start),
			shown(`${id}work`, start + 1, task.done),
			shown(`${id}ok`, task.done + 1),
			keyframes(`${id}bar`, [[[0, start], "transform:scaleX(0)"], [[task.done, 100], "transform:scaleX(1)"]]),
		);
		anim(`${id}line`, "");
		anim(`${id}box`, "");
		anim(`${id}wait`, "");
		anim(`${id}work`, "");
		anim(`${id}ok`, "");
		anim(`${id}bar`, "transform-box:fill-box;transform-origin:0 50%");
		const cy = y + 40;
		body.push(
			`<path class="${id}line" d="M294 262 C 326 262, 318 ${cy}, ${x} ${cy}" fill="none" stroke="#30363d" stroke-width="2" pathLength="1" stroke-dasharray="1"/>`,
			`<g class="${id}box">`,
			`<rect x="${x}" y="${y}" width="${w}" height="82" rx="10" fill="#0f141a" stroke="#3fb950" stroke-opacity="0.55" stroke-dasharray="6 5"/>`,
			`<text x="${x + w - 14}" y="${y + 18}" fill="#3fb950" fill-opacity="0.8" text-anchor="end" style="font-size:11px">sandbox</text>`,
			`<text class="${id}wait" x="${x + 18}" y="${y + 32}" fill="#8b949e">◌</text>`,
			`<g class="${id}work"><text class="spin" x="${x + 18}" y="${y + 32}" fill="#58a6ff">✻</text></g>`,
			`<text class="${id}ok" x="${x + 18}" y="${y + 32}" fill="#3fb950">✓</text>`,
			`<text x="${x + 40}" y="${y + 32}" fill="#e6edf3" font-weight="700">${task.name}<tspan fill="#8b949e" font-weight="400">  ${task.harness}</tspan></text>`,
			`<rect x="${x + 18}" y="${y + 46}" width="${task.scope.length * 7.8 + 70}" height="24" rx="12" fill="#161b22" stroke="#30363d"/>`,
			`<text x="${x + 30}" y="${y + 62.5}" fill="#8b949e" style="font-size:12px">scope <tspan fill="${task.scope === "read-only" ? "#d29922" : "#3fb950"}">${task.scope}</tspan></text>`,
			`<rect x="${x + 220}" y="${y + 58}" width="${w - 240}" height="4" rx="2" fill="#21262d"/>`,
			`<rect class="${id}bar" x="${x + 220}" y="${y + 58}" width="${w - 240}" height="4" rx="2" fill="${task.color}"/>`,
			`<text class="${id}work" x="${x + 220}" y="${y + 46}" fill="#8b949e" style="font-size:12px">${task.activity}</text>`,
			`</g>`,
		);
	});

	css.push(shown("deny", 38, 50));
	anim("deny", "");
	body.push(
		`<g class="deny"><rect x="${352 + 212}" y="${88 + 106 + 31}" width="252" height="22" rx="6" fill="#2b1719" stroke="#f85149" stroke-opacity="0.6"/><text x="${352 + 222}" y="${88 + 106 + 46}" fill="#ff7b72" style="font-size:12px">✗ write README.md: outside scope</text></g>`,
	);

	css.push(
		shown("report", 72),
		keyframes("accept", [[[0, 82], "fill-opacity:0"], [[85, 100], "fill-opacity:0.25"]]),
		shown("kept", 86),
	);
	anim("report", "");
	anim("accept", "");
	anim("kept", "");
	const ry = 404;
	const rw = width - 48;
	body.push(
		`<g class="report">`,
		`<rect x="24" y="${ry}" width="${rw}" height="52" rx="10" fill="#161b22" stroke="#30363d"/>`,
		`<text x="42" y="${ry + 31}" fill="#8b949e">report</text>`,
		`<text x="104" y="${ry + 31}" fill="#e6edf3"><tspan fill="#3fb950">✓</tspan> pi-scout  <tspan fill="#3fb950">✓</tspan> cx-worker <tspan fill="#3fb950">+38 −12</tspan>  <tspan fill="#3fb950">✓</tspan> cmd-worker <tspan fill="#3fb950">+54</tspan></text>`,
		`<rect class="accept" x="${24 + rw - 170}" y="${ry + 12}" width="78" height="28" rx="14" fill="#3fb950" stroke="#3fb950"/>`,
		`<text x="${24 + rw - 131}" y="${ry + 31}" fill="#3fb950" text-anchor="middle">accept</text>`,
		`<rect x="${24 + rw - 84}" y="${ry + 12}" width="66" height="28" rx="14" fill="none" stroke="#30363d"/>`,
		`<text x="${24 + rw - 51}" y="${ry + 31}" fill="#8b949e" text-anchor="middle">undo</text>`,
		`<text class="kept" x="${24 + rw - 184}" y="${ry + 31}" fill="#3fb950" text-anchor="end" style="font-size:12px">changes kept</text>`,
		`</g>`,
	);

	return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="How delegate-pi runs agents: you ask, the model delegates tasks, each agent runs in its own sandbox and scope, then you review and accept or undo">
<style>
text{font-family:${FONT};font-size:13px;white-space:pre}
.spin{transform-box:fill-box;transform-origin:50% 50%;animation:spin 2.4s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
${css.join("\n")}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}
</style>
<rect width="${width}" height="${height}" rx="16" fill="${background}"/>
<rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" rx="16" fill="none" stroke="#30363d"/>
<g class="scene">
${body.join("\n")}
</g>
</svg>
`;
}

const fakeTui ={ requestRender: () => {}, terminal: { rows: 40, columns: WIDTH } } as unknown as TUI;
const NOW = new Date("2026-11-05T15:42:00").getTime();

function headerLines(): string[] {
	const header = new ModelHeader({
		getInfo: () => ({
			modelId: "glm-5.3",
			provider: "zai",
			thinking: "high",
			contextWindow: 272_000,
			inputCost: 0.6,
			outputCost: 2.2,
			version: "1.5.0",
		}),
		isWorking: () => true,
		canAnimate: () => false,
		requestRender: () => {},
		collapsedHints: () => "",
		expandedHints: () => "",
		expanded: false,
	});
	const lines = header.render(WIDTH);
	header.dispose();
	return lines;
}

function view(agent: string, status: string, extra: Partial<TaskView> = {}): TaskView {
	return {
		taskId: `${agent}-0000-0000-0000-000000000000`,
		agent,
		provider: "pi",
		status,
		scope: [],
		task: "",
		startedAt: NOW - 95_000,
		...extra,
	};
}

function bandLines(): string[] {
	const rows: LiveRow[] = [
		{
			id: "a",
			agent: "cmd-worker",
			status: "running",
			startedAt: NOW - 134_000,
			asking: false,
			activity: ["read src/core/footer.ts", "edit src/core/footer.ts +38 -12", "bash npm run check"],
		},
		{ id: "b", agent: "cx-worker", status: "running", startedAt: NOW - 71_000, asking: false, activity: ["ast_grep outline src/extensions/usage"] },
		{ id: "c", agent: "pi-scout", status: "waiting", startedAt: NOW - 48_000, asking: true, activity: [] },
		{ id: "d", agent: "pi-worker", status: "queued", startedAt: 0, asking: false, activity: [] },
	];
	const band = new DelegateBand({ autoAnimate: false, now: () => NOW, terminalRows: () => 40 });
	band.setRows(rows);
	band.setFrame(4);
	band.toggle("a");
	return band.render(WIDTH);
}

function callLine(): string[] {
	const views = [view("cmd-worker", "running", { scope: ["src/core"] }), view("cx-worker", "running"), view("pi-scout", "waiting", { pending: 1 }), view("pi-worker", "queued")];
	return renderDelegateCall(
		{ tasks: views.map((v) => ({ agent: v.agent, task: "" })) },
		theme,
		{ toolCallId: "call", source: { viewsFor: () => views } },
	).render(WIDTH);
}

function reportLines(): string[] {
	const views = [
		view("cmd-worker", "completed", { scope: ["src/core"], durationMs: 134_000, activity: ["edit src/core/footer.ts +38 -12", "bash npm run check"] }),
		view("cx-worker", "completed", { durationMs: 71_000, activity: ["ast_grep outline src/extensions/usage"] }),
		view("pi-scout", "blocked", { durationMs: 48_000, activity: ["asked: may I read ~/.ssh/config?"] }),
	];
	const context = { toolCallId: "call", source: { viewsFor: () => views } };
	const call = renderDelegateCall({ tasks: views.map((v) => ({ agent: v.agent, task: "" })) }, theme, context).render(WIDTH);
	const result = renderDelegateResult({ content: [] }, { expanded: true }, theme, undefined, context).render(WIDTH);
	const content = [
		"<delegate-report>",
		"✓ cmd-worker 11111111-1111-1111-1111-111111111111 completed 134s, changed src/core +38 -12, accept or undo",
		"✓ cx-worker 22222222-2222-2222-2222-222222222222 completed 71s, read-only",
		"! pi-scout 33333333-3333-3333-3333-333333333333 blocked 48s, read-only",
		"</delegate-report>",
	].join("\n");
	const report = renderReportMessage({ role: "custom", customType: "delegate-report", content, display: true, timestamp: NOW } as never, theme).render(WIDTH);
	return [...call, ...result, "", ...report];
}

function workingLine(): string[] {
	let clock = NOW - 252_000;
	const indicator = new WorkingStatusIndicator(fakeTui, "Working", undefined, undefined, () => clock);
	clock = NOW;
	indicator.setMessage("Working");
	const lines = indicator.render(WIDTH);
	indicator.dispose();
	return lines;
}

function footerLines(): string[] {
	const usage = { input: 184_220, output: 22_910, cacheRead: 1_402_000, cacheWrite: 91_300, cost: { total: 1.84 } };
	const session = {
		state: { model: { id: "glm-5.3", provider: "zai", contextWindow: 272_000, reasoning: true }, thinkingLevel: "high" },
		sessionManager: {
			getEntries: () => [{ type: "message", message: { role: "assistant", usage } }],
			getEntryCount: () => 1,
			getSessionId: () => "readme",
			getLeafId: () => null,
			getSessionName: () => "footer polish",
			getCwd: () => "/home/you/delegate-pi",
		},
		getContextUsage: () => ({ contextWindow: 272_000, percent: 41.6, tokens: 113_000 }),
		modelRuntime: { isUsingSubscription: () => true },
	} as unknown as AgentSession;
	const data: ReadonlyFooterDataProvider = {
		getGitBranch: () => "dev",
		getExtensionStatuses: () => new Map(),
		getAvailableProviderCount: () => 3,
		onBranchChange: () => () => {},
	};
	return new FooterComponent(session, data).render(WIDTH);
}

function askLines(): string[] {
	const selector = new ExtensionSelectorComponent(
		"Which storage should the session index use?",
		["SQLite (one file, fast queries)", "JSON lines (no new dependency)", "Keep the current folder scan", "Other — type your answer"],
		() => {},
		() => {},
	);
	selector.handleInput("\x1b[B");
	return selector.render(WIDTH);
}

function rand(seed: number): () => number {
	let s = seed;
	return () => {
		s = (s * 1103515245 + 12345) % 2147483648;
		return s / 2147483648;
	};
}

function statsLines(): string[] {
	const random = rand(7);
	const files: FileEntry[][] = [];
	const models = ["glm-5.3", "claude-opus-5-5", "GPT-6.1-Sol", "deepseek-v4.1"];
	for (let day = new Date(2026, 0, 3).getTime(); day < NOW; day += 86_400_000) {
		const weekday = new Date(day).getDay();
		const chance = weekday === 0 || weekday === 6 ? 0.35 : 0.85;
		if (random() > chance) continue;
		const count = 1 + Math.floor(random() * 4);
		for (let s = 0; s < count; s++) {
			const time = new Date(day + 9 * 3_600_000 + s * 7_200_000).toISOString();
			const model = models[Math.floor(random() ** 1.8 * models.length)]!;
			const input = Math.floor(80_000 + random() * 900_000);
			files.push([
				{ type: "message", id: `u${day}${s}`, parentId: null, timestamp: time, message: { role: "user" } },
				{
					type: "message",
					id: `a${day}${s}`,
					parentId: null,
					timestamp: time,
					message: { role: "assistant", provider: "x", model, usage: { input, output: Math.floor(input / 9), cacheRead: 0, cacheWrite: 0 } },
				},
			] as unknown as FileEntry[]);
		}
	}
	const screen = createStatsScreen(gatherStats(files, NOW), theme, () => {}, { tui: { terminal: { rows: 44 } } as never });
	return screen.render(WIDTH);
}

function usageLines(): string[] {
	const entries: SessionEntry[] = [];
	const add = (provider: string, model: string, n: number, input: number, cost: number) => {
		for (let i = 0; i < n; i++) {
			entries.push({ type: "message", id: `u${model}${i}`, message: { role: "user" } } as unknown as SessionEntry);
			entries.push({
				type: "message",
				id: `a${model}${i}`,
				message: {
					role: "assistant",
					provider,
					model,
					usage: {
						input,
						output: input / 8,
						cacheRead: input * 6,
						cacheWrite: input / 3,
						cost: { input: cost / 4, output: cost / 4, cacheRead: cost / 4, cacheWrite: cost / 4, total: cost },
					},
				},
			} as unknown as SessionEntry);
		}
	};
	add("zai", "glm-5.3", 14, 21_000, 0.031);
	add("anthropic", "claude-opus-5-5", 4, 18_000, 0.42);
	add("openai-codex", "GPT-6.1-Sol", 6, 15_000, 0.09);
	add("deepseek", "deepseek-v4.1", 3, 30_000, 0.012);
	const screen = createUsageScreen(entries, theme, () => {}, { sessionLabel: "footer polish" });
	return screen.render(WIDTH);
}

function squeeze(lines: string[]): string[] {
	const blank = (line: string) => visibleWidth(line.replace(/\x1b\[[0-9;:]*m/g, "").trim()) === 0;
	const kept = lines.filter((line, i) => !(blank(line) && i > 0 && blank(lines[i - 1]!)));
	while (kept.length && blank(kept[0]!)) kept.shift();
	while (kept.length && blank(kept[kept.length - 1]!)) kept.pop();
	return kept;
}

function main(): void {
	initTheme("github-dark");
	setKeybindings(KeybindingsManager.create());
	const background = theme.canvas ? colorToHex(theme.canvas) : "#0d1117";
	const foreground = colorToHex(theme.colors?.text ?? themeBackgroundColor(theme));
	mkdirSync(OUT, { recursive: true });
	const blank = [""];
	const shots: Record<string, [string, string[]]> = {
		hero: [
			"delegate-pi — ~/delegate-pi",
			[...headerLines(), ...blank, ...callLine(), ...blank, ...bandLines(), ...blank, ...workingLine(), ...blank, ...footerLines()],
		],
		report: ["delegate-pi — delegate result", reportLines()],
		ask: ["delegate-pi — ask_user", askLines()],
		stats: ["delegate-pi — /stats", statsLines()],
		usage: ["delegate-pi — /usage", usageLines()],
		footer: ["delegate-pi — footer", [...workingLine(), ...blank, ...footerLines()]],
	};
	for (const [name, [title, lines]] of Object.entries(shots)) {
		const kept = squeeze(lines);
		writeFileSync(join(OUT, `${name}.svg`), svg(title, kept, background, foreground));
	}
	writeFileSync(join(OUT, "banner.svg"), withBrandFont(banner(background)));
	writeFileSync(join(OUT, "how-it-works.svg"), withBrandFont(explainer(background)));
	console.log(`wrote ${Object.keys(shots).length} shots to ${OUT}`);
}

main();
