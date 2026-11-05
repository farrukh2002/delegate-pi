import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadAgentFile } from "../delegate/core/agents.ts";

describe("bundled delegate agent approval defaults", () => {
	it.each(["pi-scout", "pi-worker", "cx-worker", "cmd-worker"])("defaults %s to full-access", (name) => {
		const filePath = fileURLToPath(new URL(`../delegate/agents/${name}.md`, import.meta.url));
		const agent = loadAgentFile(filePath, "bundled");
		expect(agent?.name).toBe(name);
		expect(agent?.runtimeMode).toBe("full-access");
	});

	it("keeps the Pi scout and worker write-scope defaults unchanged", () => {
		const scout = loadAgentFile(fileURLToPath(new URL("../delegate/agents/pi-scout.md", import.meta.url)), "bundled");
		const worker = loadAgentFile(
			fileURLToPath(new URL("../delegate/agents/pi-worker.md", import.meta.url)),
			"bundled",
		);
		expect(scout?.scope).toBeUndefined();
		expect(scout?.tools).toEqual(["read", "grep", "find", "ls", "bash"]);
		expect(worker?.scope).toEqual(["."]);
	});
});
