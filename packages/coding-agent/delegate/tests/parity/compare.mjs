export function diff(a, b, at = "", out = []) {
	if (JSON.stringify(a) === JSON.stringify(b)) return out;
	const object = (value) => value !== null && typeof value === "object";
	if (object(a) && object(b) && Array.isArray(a) === Array.isArray(b)) {
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		for (const key of keys) diff(a[key], b[key], at ? `${at}.${key}` : String(key), out);
		return out;
	}
	out.push(`${at}: js=${JSON.stringify(a)} rust=${JSON.stringify(b)}`);
	return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	const [left, right] = process.argv.slice(2);
	const fs = await import("node:fs");
	const a = JSON.parse(fs.readFileSync(left, "utf8"));
	const b = JSON.parse(fs.readFileSync(right, "utf8"));
	const lines = diff(a.trace ?? a, b.trace ?? b);
	if (!lines.length) console.log("identical");
	else {
		for (const line of lines) console.log(line);
		process.exitCode = 1;
	}
}
