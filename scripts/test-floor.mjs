// Fail CI when suspiciously few tests were counted — even if all of them passed.
//
// The failure mode this guards against: a test file that never registers its
// tests still lets the run go green. A rename that slips out of the include
// globs, a directory dropped from the vitest config, an import-time throw that
// gets swallowed as an empty collection — in each case the surviving files all
// pass and CI reports success with a chunk of the suite silently missing. A
// green run only means "everything that ran passed"; this script adds the
// missing half of the claim: "and roughly everything we expected to run, ran."
//
// It wraps `vitest run` with a machine-readable reporter, counts the tests the
// run REGISTERED, and refuses to pass if that count is below the floor — or if
// the count cannot be determined at all. An uncountable run must never report
// success: that is exactly the shape a collection failure has.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// The FLOOR, not an exact count. An exact count would catch the failure mode
// too, but it would need editing on every PR that adds or removes a test —
// so this keeps a small buffer below the most recently verified full run
// (1091 registered tests, 2026-08). Adding tests never touches it; removing
// a meaningful slice does. If the suite legitimately shrinks below this,
// lower the number here in the same PR that removes the tests, so the change
// is a visible, reviewed decision rather than a silent one.
export const TEST_COUNT_FLOOR = 1070;

const TARGET_FLAGS = ["--changed", "--related", "--shard", "--exclude", "--testNamePattern", "-t", "--project"];

/** A path/name/project filter intentionally collects only part of the suite,
 * so applying the global floor would make Vitest's normal targeted-run
 * workflow unusable. CI invokes the wrapper without arguments and therefore
 * always keeps the floor. */
export function isTargetedRun(args) {
  return args.some((arg) => {
    if (!arg.startsWith("-")) return true;
    return TARGET_FLAGS.some((flag) => arg === flag || arg.startsWith(`${flag}=`));
  });
}

export function vitestArguments(vitestBin, summaryFile, cliArgs) {
  return [
    vitestBin,
    "run",
    ...cliArgs,
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${summaryFile}`,
  ];
}

// Registered tests, not executed tests, on purpose: POSIX-only process tests
// self-skip on Windows, and a skipped test still proves its file was imported
// and collected — which is the thing that silently disappears in the failure
// mode above. Counting registrations keeps one floor valid across the whole
// 3-OS CI matrix instead of needing a per-platform allowance for skips.
export function evaluateRun({ exitCode, summary }, floor = TEST_COUNT_FLOOR) {
  // Anything that is not a finite number — absent summary, absent field, NaN,
  // a stringified count — collapses to "uncountable" here, at the boundary.
  const counted = Number.isFinite(summary?.numTotalTests) ? summary.numTotalTests : null;

  if (counted === null) {
    return {
      ok: false,
      message:
        "test-floor: could not determine how many tests ran (no usable JSON summary). " +
        "Refusing to report a pass on a run that cannot be counted.",
    };
  }

  if (exitCode !== 0) {
    return {
      ok: false,
      message: `test-floor: vitest exited with ${exitCode === null ? "a signal" : `code ${exitCode}`} (${counted} tests counted). See the report above.`,
    };
  }

  // Belt and braces: a reporter bug or partial write could hand us exit 0
  // alongside a summary that says the run failed. Trust the pessimistic one.
  if (summary.success === false) {
    return {
      ok: false,
      message: `test-floor: vitest exited 0 but its own summary reports failure (${counted} tests counted).`,
    };
  }

  if (floor !== null && counted < floor) {
    return {
      ok: false,
      message:
        `test-floor: only ${counted} tests were counted, below the floor of ${floor}. ` +
        "Every test that ran passed — but a chunk of the suite did not run at all. " +
        "Likely causes: a test file failing at import/collection time, or include " +
        "globs no longer matching it. If the suite genuinely shrank, lower " +
        "TEST_COUNT_FLOOR in scripts/test-floor.mjs in the same PR.",
    };
  }

  return {
    ok: true,
    message: floor === null
      ? `test-floor: ${counted} targeted tests counted (global floor intentionally skipped) ✓`
      : `test-floor: ${counted} tests counted, floor is ${floor} ✓`,
  };
}

async function main(cliArgs = process.argv.slice(2)) {
  // Resolve vitest's CLI entry and run it under this same Node binary instead
  // of shelling out to `pnpm exec` — spawning package-manager shims is the
  // classic Windows CI papercut (.cmd resolution), and this script runs on
  // all three matrix platforms.
  const require = createRequire(import.meta.url);
  const vitestPkgPath = require.resolve("vitest/package.json");
  const vitestPkg = JSON.parse(readFileSync(vitestPkgPath, "utf8"));
  // npm allows `bin` as either a name→path map or a bare path string.
  const binRel = vitestPkg.bin?.vitest ?? vitestPkg.bin;
  const vitestBin = join(dirname(vitestPkgPath), binRel);

  // The JSON summary goes to a scratch file, not stdout: the default reporter
  // owns stdout so humans still get the live report, and a file cannot be
  // corrupted by interleaved test output the way a piped stream can.
  const scratch = mkdtempSync(join(tmpdir(), "omb-test-floor-"));
  const summaryFile = join(scratch, "vitest-summary.json");

  const exitCode = await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      vitestArguments(vitestBin, summaryFile, cliArgs),
      { stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });

  let summary = null;
  try {
    summary = JSON.parse(readFileSync(summaryFile, "utf8"));
  } catch {
    // Missing or unparsable summary — evaluateRun treats that as uncountable
    // and fails; it must not be masked into a pass here.
  }

  try {
    rmSync(scratch, { recursive: true, force: true });
  } catch {
    // Scratch cleanup must never decide the verdict.
  }

  const result = evaluateRun({ exitCode, summary }, isTargetedRun(cliArgs) ? null : TEST_COUNT_FLOOR);
  console[result.ok ? "log" : "error"](result.message);
  process.exit(result.ok ? 0 : (exitCode ?? 1) || 1);
}

// Only act as a CLI when invoked directly; the unit test imports evaluateRun
// without wanting a full suite run as a side effect.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main();
}
