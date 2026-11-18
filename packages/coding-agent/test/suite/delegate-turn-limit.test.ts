import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { installDelegateTurnLimit } from "../../src/core/delegate/turn-limit.ts";
import { createHarness, getAssistantTexts, getToolResult } from "./harness.ts";

describe("Pi delegate turn limit", () => {
	it("allows the last turn to finish with an answer", async () => {
		const harness = await createHarness();
		try {
			const exceeded: number[] = [];
			installDelegateTurnLimit(harness.session.agent, 1, (turns) => exceeded.push(turns));
			harness.setResponses([fauxAssistantMessage("Finished on the last allowed turn.")]);
			await harness.session.prompt("Finish in one turn.");
			expect(harness.faux.state.callCount).toBe(1);
			expect(getAssistantTexts(harness)).toEqual(["Finished on the last allowed turn."]);
			expect(exceeded).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("finishes tool work before blocking the next provider request", async () => {
		const harness = await createHarness({
			tools: [
				{
					name: "fixture",
					label: "Fixture",
					description: "Complete fixture work",
					parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "Tool finished" }], details: {} }),
				},
			],
		});
		try {
			const exceeded: number[] = [];
			let preparedContinuation = false;
			harness.session.agent.prepareNextTurnWithContext = async () => {
				preparedContinuation = true;
			};
			installDelegateTurnLimit(harness.session.agent, 1, (turns) => exceeded.push(turns));
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("fixture", {}), { stopReason: "toolUse" }),
				fauxAssistantMessage("This request must not start."),
			]);
			await harness.session.prompt("Do the fixture work.");
			expect(harness.faux.state.callCount).toBe(1);
			expect(getToolResult(harness, "fixture").content).toEqual([{ type: "text", text: "Tool finished" }]);
			expect(preparedContinuation).toBe(false);
			expect(exceeded).toEqual([1]);
		} finally {
			harness.cleanup();
		}
	});
});
