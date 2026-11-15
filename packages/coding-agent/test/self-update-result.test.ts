import { describe, expect, it } from "vitest";
import { selfUpdateOutcome } from "../src/utils/self-update-result.ts";

const base = {
	appName: "delegate-pi",
	command: "sh /app/install.sh --channel dev",
	previousVersion: "1.5.2-dev.f51ed46",
	plannedVersion: "1.5.2",
};

describe("self update outcome", () => {
	it("accepts an unchanged version on a channel install", () => {
		expect(selfUpdateOutcome({ ...base, installedVersion: "1.5.2-dev.f51ed46", channel: "dev" })).toEqual({
			ok: true,
			text: "delegate-pi is already at 1.5.2-dev.f51ed46",
		});
	});

	it("accepts a new channel build", () => {
		expect(selfUpdateOutcome({ ...base, installedVersion: "1.5.2-dev.abc1234", channel: "dev" })).toEqual({
			ok: true,
			text: "Updated delegate-pi from 1.5.2-dev.f51ed46 to 1.5.2-dev.abc1234",
		});
	});

	it("accepts the planned stable version", () => {
		expect(
			selfUpdateOutcome({ ...base, installedVersion: "1.5.2", plannedVersion: "1.5.2", channel: "stable" }),
		).toEqual({ ok: true, text: "Updated delegate-pi from 1.5.2-dev.f51ed46 to 1.5.2" });
	});

	it("warns when a stable install did not change", () => {
		expect(
			selfUpdateOutcome({
				...base,
				installedVersion: "1.5.2-dev.f51ed46",
				plannedVersion: "1.5.2",
				channel: "stable",
			}),
		).toEqual({
			ok: false,
			text: "Ran sh /app/install.sh --channel dev, but `delegate-pi --version` reports 1.5.2-dev.f51ed46, not 1.5.2.",
		});
	});

	it("warns when no version is reported", () => {
		expect(selfUpdateOutcome({ ...base, installedVersion: undefined, channel: "dev" })).toEqual({
			ok: false,
			text: "Ran sh /app/install.sh --channel dev, but `delegate-pi --version` reports no version.",
		});
	});
});
