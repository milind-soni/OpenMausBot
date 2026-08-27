import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import { writeAcceptanceReport } from "./report.ts";
import { runAutomatedFakePilot } from "./scenario.ts";

function outputDirectory(argv: string[]): string {
  let output: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--output") {
      output = argv[index + 1];
      if (!output) throw new Error("pilot_output_directory_required");
      index += 1;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      process.stdout.write("Usage: pnpm pilot:collaboration:fake -- --output <directory>\n");
      process.exit(0);
    }
    throw new Error("pilot_invalid_arguments");
  }
  if (!output) throw new Error("pilot_output_directory_required");
  return resolve(output);
}

async function main(): Promise<void> {
  const output = outputDirectory(process.argv.slice(2));
  mkdirSync(output, { recursive: true, mode: 0o700 });
  const result = await runAutomatedFakePilot();
  try {
    const written = writeAcceptanceReport({
      report: result.report,
      jsonPath: resolve(output, "acceptance-report.json"),
      markdownPath: resolve(output, "acceptance-report.md"),
    });
    process.stdout.write(`${JSON.stringify({
      scope: result.report.scope,
      status: result.report.status,
      jsonFile: "acceptance-report.json",
      markdownFile: "acceptance-report.md",
      jsonDigest: written.jsonDigest,
    })}\n`);
  } finally {
    result.dispose();
  }
}

await main().catch((error: unknown) => {
  const known = error instanceof Error && ["pilot_output_directory_required", "pilot_invalid_arguments"].includes(error.message);
  process.stderr.write(`${JSON.stringify({ status: "fail", errorCode: known ? error.message : "pilot_execution_failed" })}\n`);
  process.exitCode = 1;
});
