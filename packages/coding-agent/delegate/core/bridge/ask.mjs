import { request } from "./client.mjs";
try {
  const input = JSON.parse(process.argv[2] || "{}");
  const answer = await request({ ...input, kind: "question" });
  process.stdout.write(JSON.stringify(answer) + "\n");
} catch (error) {
  process.stderr.write(String(error.message) + "\n");
  process.exitCode = 1;
}
