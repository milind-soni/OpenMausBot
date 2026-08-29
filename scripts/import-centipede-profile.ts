import { runProfileImport } from "../server/profile-import.ts";

function readArguments(argv: readonly string[]): {
  sourceFile: string;
  targetRoot: string;
  mode: "dry-run" | "apply";
  reviewedPlanHash?: string;
} {
  const allowed = new Set(["--source", "--target", "--plan-hash", "--dry-run", "--apply"]);
  for (const argument of argv) {
    if (argument.startsWith("--") && !allowed.has(argument)) throw new Error(`Unknown argument: ${argument}`);
  }
  const value = (name: string): string | undefined => {
    const positions = argv.flatMap((argument, index) => argument === name ? [index] : []);
    if (positions.length > 1) throw new Error(`${name} may be provided only once`);
    const index = positions[0];
    if (index === undefined) return undefined;
    const result = argv[index + 1];
    if (!result || result.startsWith("--")) throw new Error(`${name} requires a value`);
    return result;
  };
  const sourceFile = value("--source");
  const targetRoot = value("--target");
  if (!sourceFile || !targetRoot) throw new Error("Pass explicit --source and --target paths");
  const dryRun = argv.includes("--dry-run");
  const apply = argv.includes("--apply");
  if (dryRun === apply) throw new Error("Choose exactly one of --dry-run or --apply");
  const reviewedPlanHash = value("--plan-hash");
  if (dryRun && reviewedPlanHash) throw new Error("--plan-hash is accepted only with --apply");
  return reviewedPlanHash === undefined
    ? { sourceFile, targetRoot, mode: dryRun ? "dry-run" : "apply" }
    : { sourceFile, targetRoot, mode: "apply", reviewedPlanHash };
}

try {
  const result = runProfileImport(readArguments(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Profile import failed"}\n`);
  process.exitCode = 1;
}
