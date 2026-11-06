#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv.includes("--version")) {
  console.log("2.1.296 (Claude Code)");
  process.exit(0);
}
if (process.argv.includes("--help")) {
  console.log("--autocompact");
  process.exit(0);
}

createInterface({ input: process.stdin }).on("line", (line) => {
  if (JSON.parse(line).type !== "user") return;
  for (const frame of JSON.parse(process.env.FAKE_CLAUDE_FAILURE_FRAMES!)) {
    process.stdout.write(`${JSON.stringify(frame)}\n`);
  }
  appendFileSync(process.env.FAKE_CLAUDE_EFFECTS!, "effect\n");
  process.stderr.write("ECONNRESET\n", () => process.exit(1));
});
