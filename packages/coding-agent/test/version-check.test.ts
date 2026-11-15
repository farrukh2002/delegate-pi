import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewPiVersion,
	comparePackageVersions,
	formatVersionCheckError,
	getLatestPiRelease,
	getLatestPiVersion,
	installedChannel,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";
import { allowNetwork } from "./test-network-env.ts";

const release = vi.hoisted(() => ({ repository: undefined as string | undefined }));

vi.mock("../src/config.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/config.ts")>()),
	get RELEASE_REPOSITORY() {
		return release.repository;
	},
}));

const originalSkipVersionCheck = process.env.PI_SKIP_VERSION_CHECK;
const originalInstallHome = process.env.DELEGATE_PI_HOME;
let channelHome: string;

beforeEach(() => {
	allowNetwork();
	channelHome = mkdtempSync(join(tmpdir(), "pi-version-check-"));
	process.env.DELEGATE_PI_HOME = channelHome;
});

afterEach(() => {
	release.repository = undefined;
	vi.unstubAllGlobals();
	rmSync(channelHome, { recursive: true, force: true });
	if (originalInstallHome === undefined) delete process.env.DELEGATE_PI_HOME;
	else process.env.DELEGATE_PI_HOME = originalInstallHome;
	if (originalSkipVersionCheck === undefined) {
		delete process.env.PI_SKIP_VERSION_CHECK;
	} else {
		process.env.PI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toEqual({ version: "1.2.3" });
	});

	it("uses the pi.dev version check api with a pi user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://pi.dev/api/latest-version",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^pi\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("retries a transient version request when explicitly requested", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3", { retry: true })).resolves.toEqual({ version: "1.2.4" });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("keeps automatic version checks to one request", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("formats nested network error details", () => {
		const error = new Error("fetch failed", {
			cause: new AggregateError([
				Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }),
				Object.assign(new Error("network unreachable"), { code: "ENETUNREACH" }),
			]),
		});

		expect(formatVersionCheckError(error)).toBe("fetch failed (ETIMEDOUT, ENETUNREACH)");
	});

	it("returns the active package metadata from the version check api", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				packageName: "@new-scope/pi",
				version: "1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			packageName: "@new-scope/pi",
			version: "1.2.4",
		});
	});

	it("returns update notes from the version check api", async () => {
		const fetchMock = vi.fn(async () => Response.json({ note: " **Read this** ", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({ note: "**Read this**", version: "1.2.4" });
	});

	it("skips automatic api calls when version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows direct api calls when automatic version checks are disabled", async () => {
		process.env.PI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("reads the latest GitHub release of a fork with a release repository", async () => {
		release.repository = "owner/fork";
		const fetchMock = vi.fn(async () => Response.json({ tag_name: "v1.3.0" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toEqual({ version: "1.3.0" });
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/owner/fork/releases/latest",
			expect.objectContaining({
				headers: expect.objectContaining({ accept: "application/vnd.github+json" }),
			}),
		);
	});

	it("reports no fork update when the release repository has no release", async () => {
		release.repository = "owner/fork";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("Not Found", { status: 404 })),
		);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
	});
});

describe("channel-aware version checks", () => {
	it("reads the installed channel", () => {
		writeFileSync(join(channelHome, "channel"), "dev\n");
		expect(installedChannel()).toBe("dev");
		writeFileSync(join(channelHome, "channel"), "rc\n");
		expect(installedChannel()).toBe("rc");
		writeFileSync(join(channelHome, "channel"), "stable\n");
		expect(installedChannel()).toBe("stable");
	});

	it("keeps a dev build quiet when the dev release is the same commit", async () => {
		release.repository = "owner/fork";
		writeFileSync(join(channelHome, "channel"), "dev\n");
		const fetchMock = vi.fn(async () =>
			Response.json({
				tag_name: "dev",
				name: "delegate-pi 1.5.2-dev.3d12572",
				target_commitish: "3d1257234b05d2e22572b61fd6995c0ad2bf0182",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.5.2-dev.3d12572")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/owner/fork/releases/tags/dev",
			expect.anything(),
		);
	});

	it("reports a newer dev build", async () => {
		release.repository = "owner/fork";
		writeFileSync(join(channelHome, "channel"), "dev\n");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					tag_name: "dev",
					name: "delegate-pi 1.5.2-dev.9999999",
					target_commitish: "9999999aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				}),
			),
		);

		await expect(checkForNewPiVersion("1.5.2-dev.3d12572")).resolves.toEqual({ version: "1.5.2-dev.9999999" });
	});

	it("compares rc builds with the newest release candidate", async () => {
		release.repository = "owner/fork";
		writeFileSync(join(channelHome, "channel"), "rc\n");
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json([{ tag_name: "v1.5.2-rc.2" }, { tag_name: "v1.5.2-rc.1" }])),
		);

		await expect(checkForNewPiVersion("1.5.2-rc.1")).resolves.toEqual({ version: "1.5.2-rc.2" });
	});
});
