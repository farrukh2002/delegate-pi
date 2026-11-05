import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const data = fs.mkdtempSync(path.join(os.tmpdir(), "delegate-test-"));
process.env.DELEGATE_DATA = data;
for (const key of ["DELEGATE_DEPTH", "DELEGATE_DEFAULT_AGENTS_DIR", "DELEGATE_AGENTS_DIR", "DELEGATE_PROJECT_CONFIG_DIR", "DELEGATE_PI_ENTRY", "DELEGATE_PI_PACKAGE_DIR", "DELEGATE_PI_CONFIG_DIR", "DELEGATE_PROVIDERS_FILE"]) {
	delete process.env[key];
}
process.on("exit", () => { fs.rmSync(data, { recursive: true, force: true }); });
