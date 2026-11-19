import assert from "node:assert";
import { describe, it } from "node:test";
import { SettingsList, type SettingsListTheme } from "../src/components/settings-list.ts";
import { visibleWidth } from "../src/utils.ts";

const testTheme: SettingsListTheme = {
	label: (text) => text,
	value: (text) => text,
	description: (text) => text,
	cursor: "> ",
	hint: (text) => text,
};

const items = [
	{
		id: "tui-mode",
		label: "TUI mode",
		currentValue: "regular",
		values: ["regular", "fullscreen"],
	},
];

describe("SettingsList", () => {
	it("includes spaces in an active search instead of changing the selected setting", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		for (const character of "TUI mode") list.handleInput(character);

		assert.deepStrictEqual(changes, []);
		assert.match(list.render(80)[0] ?? "", /TUI mode/);

		list.handleInput("\r");
		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("keeps Space as a change shortcut before a search query is entered", () => {
		const changes: Array<{ id: string; value: string }> = [];
		const list = new SettingsList(
			items.map((item) => ({ ...item })),
			10,
			testTheme,
			(id, value) => changes.push({ id, value }),
			() => {},
			{ enableSearch: true },
		);

		list.handleInput(" ");

		assert.deepStrictEqual(changes, [{ id: "tui-mode", value: "fullscreen" }]);
	});

	it("moves by one visible page with selection page keys (#7629)", () => {
		const list = new SettingsList(
			Array.from({ length: 12 }, (_, index) => ({
				id: `setting-${index}`,
				label: `Setting ${index}`,
				currentValue: String(index),
			})),
			5,
			testTheme,
			() => {},
			() => {},
		);

		list.handleInput("\x1b[6~");
		assert.match(list.render(80).join("\n"), /> Setting 5/);
		list.handleInput("\x1b[6~");
		list.handleInput("\x1b[6~");
		assert.match(list.render(80).join("\n"), /> Setting 11/);
		list.handleInput("\x1b[5~");
		assert.match(list.render(80).join("\n"), /> Setting 6/);
	});

	it("shows Esc to cancel in the hint line by default", () => {
		const list = new SettingsList(
			items,
			10,
			testTheme,
			() => {},
			() => {},
		);

		assert.match(list.render(80).join("\n"), /Enter\/Space to change · Esc to cancel/);
	});

	it("shows a custom Esc hint, also with search enabled", () => {
		const cancelHint = "Esc to close · Changes save immediately";
		const plain = new SettingsList(
			items,
			10,
			testTheme,
			() => {},
			() => {},
			{ cancelHint },
		);
		const searchable = new SettingsList(
			items,
			10,
			testTheme,
			() => {},
			() => {},
			{ enableSearch: true, cancelHint },
		);

		assert.match(plain.render(80).join("\n"), /Enter\/Space to change · Esc to close · Changes save immediately/);
		const searchableText = searchable.render(80).join(" ");
		assert.match(searchableText, /Type to search · Enter\/Space to change · Esc to close · Changes save immediately/);
		for (const line of searchable.render(80)) assert.ok(visibleWidth(line) <= 80);
		assert.doesNotMatch(plain.render(80).join("\n"), /Esc to cancel/);
	});
});
