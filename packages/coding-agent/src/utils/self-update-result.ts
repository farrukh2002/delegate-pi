import type { InstallChannel } from "./version-check.ts";

export interface SelfUpdateOutcome {
	ok: boolean;
	text: string;
}

export function selfUpdateOutcome(input: {
	appName: string;
	command: string;
	previousVersion: string;
	installedVersion: string | undefined;
	plannedVersion: string;
	channel: InstallChannel;
}): SelfUpdateOutcome {
	const { appName, command, previousVersion, installedVersion, plannedVersion, channel } = input;
	if (installedVersion === undefined) {
		return { ok: false, text: `Ran ${command}, but \`${appName} --version\` reports no version.` };
	}
	if (installedVersion !== previousVersion) {
		return { ok: true, text: `Updated ${appName} from ${previousVersion} to ${installedVersion}` };
	}
	if (channel !== "stable") {
		return { ok: true, text: `${appName} is already at ${installedVersion}` };
	}
	if (installedVersion === plannedVersion) {
		return { ok: true, text: `${appName} is up to date at ${installedVersion}` };
	}
	return {
		ok: false,
		text: `Ran ${command}, but \`${appName} --version\` reports ${installedVersion}, not ${plannedVersion}.`,
	};
}
