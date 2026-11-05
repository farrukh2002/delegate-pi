/** Distance between two short strings. Names are short, so a plain table is enough. */
export function editDistance(first: string, second: string): number {
	const a = first.toLowerCase();
	const b = second.toLowerCase();
	if (a === b) return 0;
	if (a.length === 0) return b.length;
	if (b.length === 0) return a.length;
	let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
	for (let i = 1; i <= a.length; i++) {
		const current = [i];
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1;
			current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
		}
		previous = current;
	}
	return previous[b.length];
}

/** The command name in `/name args`, or undefined when the text does not start a command. */
export function commandWord(text: string): string | undefined {
	const trimmed = text.trimStart();
	if (!trimmed.startsWith("/")) return undefined;
	const word = trimmed.slice(1).split(/\s+/, 1)[0] ?? "";
	if (word === "" || !/^[A-Za-z][\w:-]*$/.test(word)) return undefined;
	return word;
}

/** Closest candidate for a mistyped command name, or undefined when nothing is close enough. */
export function suggestCommand(word: string, candidates: Iterable<string>): string | undefined {
	const target = word.toLowerCase();
	let best: string | undefined;
	let bestDistance = Number.POSITIVE_INFINITY;
	const limit = target.length <= 3 ? 1 : target.length <= 6 ? 2 : 3;
	for (const candidate of candidates) {
		const name = candidate.toLowerCase();
		const distance = editDistance(target, name);
		if (distance < bestDistance) {
			bestDistance = distance;
			best = candidate;
		}
	}
	if (best === undefined || bestDistance > limit) return undefined;
	return best;
}

/**
 * A tip for input that looks like a mistyped slash command, or undefined to treat the text as a prompt.
 * Text that only looks like a path, such as `/usr/bin`, has no close command and stays a prompt.
 */
export function unknownCommandTip(text: string, knownCommands: Iterable<string>): string | undefined {
	const word = commandWord(text);
	if (word === undefined) return undefined;
	const known = new Set([...knownCommands].map((name) => name.toLowerCase()));
	if (known.has(word.toLowerCase())) return undefined;
	const suggestion = suggestCommand(word, known);
	if (suggestion === undefined) return undefined;
	return `Unknown command /${word}. Did you mean /${suggestion}?`;
}
