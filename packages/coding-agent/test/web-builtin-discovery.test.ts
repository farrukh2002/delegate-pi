import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

describe("built-in native web tool discovery", () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "pi-web-discovery-"));
		vi.stubEnv("PI_WEB_BIN", join(directory, "not-installed"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(directory, { recursive: true, force: true });
	});

	it("loads the native web tools as built-ins without starting an engine", async () => {
		const web = builtInExtensions.filter((extension) => typeof extension !== "function" && extension.name === "web");
		expect(web).toHaveLength(1);
		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			settingsManager: SettingsManager.inMemory({}),
			extensionFactories: web,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await loader.reload();
		const result = loader.getExtensions();
		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(result.extensions[0].path).toBe("builtin:web");
		const tool = result.extensions[0].tools.get("http_request");
		expect(tool?.sourceInfo.source).toBe("builtin");
		expect(tool?.definition.name).toBe("http_request");
		expect(tool?.definition.promptSnippet).toBeTruthy();
		const searchTool = result.extensions[0].tools.get("web_search");
		expect(searchTool?.sourceInfo.source).toBe("builtin");
		expect(searchTool?.definition.name).toBe("web_search");
		expect(searchTool?.definition.promptSnippet).toBeTruthy();
		const fetchTool = result.extensions[0].tools.get("web_fetch");
		expect(fetchTool?.sourceInfo.source).toBe("builtin");
		expect(fetchTool?.definition.name).toBe("web_fetch");
		expect(fetchTool?.definition.promptSnippet).toBeTruthy();
		for (const name of ["git_index", "git_search", "git_read"]) {
			const gitTool = result.extensions[0].tools.get(name);
			expect(gitTool?.sourceInfo.source).toBe("builtin");
			expect(gitTool?.definition.name).toBe(name);
			expect(gitTool?.definition.promptSnippet).toBeTruthy();
		}
	});

	it("honors the built-in extension disable setting", async () => {
		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: directory,
			settingsManager: SettingsManager.inMemory({ extensions: ["-builtin:web"] }),
			extensionFactories: builtInExtensions.filter(
				(extension) => typeof extension !== "function" && extension.name === "web",
			),
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		expect(loader.getExtensions().extensions).toEqual([]);
	});
});
