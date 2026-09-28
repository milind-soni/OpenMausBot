import { pathToFileURL } from "node:url";
import { runGolden } from "./run-golden.ts";

/** Thin CLI adapter so run-evals can delegate `pnpm eval --golden` while
 * run-golden.ts stays importable from tests. */

export async function runGoldenCli(args: string[]): Promise<number> {
  const wanted = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--scenario") wanted.add(args[index + 1] ?? "");
  }
  const outIndex = args.indexOf("--out");
  const outDir = outIndex === -1 ? undefined : (args[outIndex + 1] ?? undefined);
  try {
    const outcome = await runGolden({
      updateBaseline: args.includes("--update-baseline"),
      only: wanted,
      outDir,
    });
    for (const delta of outcome.deltas) {
      console.error("golden drift in " + delta.id + ":");
      for (const line of delta.lines) console.error("  " + line);
    }
    for (const id of outcome.missingBaselines) console.error("golden " + id + " has no committed baseline");
    for (const path of outcome.updatedBaselines) console.log("baseline updated: " + path);
    return outcome.pass ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runGoldenCli(process.argv.slice(2));
}
