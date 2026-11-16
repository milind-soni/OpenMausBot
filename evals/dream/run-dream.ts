// Sends each dream case to a real model with the dream's own prompt and scores what runDream would keep.
//
//   OMB_EVAL_LIVE=1 OMB_EVAL_LIVE_INSTANCE='{"instanceId":"claude","driver":"claudeAgent","model":"claude-haiku-5-5","config":{"cli":"/path/to/claude"},"environmentFrom":["HOME","USER","PATH"]}' \
//     node --experimental-strip-types evals/dream/run-dream.ts [--only id,id]
//
// Each case is one real model call on your account: never in CI, closed unless OMB_EVAL_LIVE=1. The server's data folder is
// a temporary one, so nothing reads or writes ~/.openmausbot.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

async function main(): Promise<void> {
  if (process.env.OMB_EVAL_LIVE !== "1") {
    console.log("dream eval: skipped (set OMB_EVAL_LIVE=1; each case is one real model call)");
    return;
  }
  const dataDir = mkdtempSync(join(tmpdir(), "omb-dream-eval-"));
  process.env.OMB_DATA_DIR = dataDir;
  const { loadLiveInstance } = await import("../live/run-live.ts");
  const { BUILT_IN_DRIVERS } = await import("../../server/drivers/builtIn.ts");
  const { DREAM_TIMEOUT_MS } = await import("../../server/memory-upkeep.ts");
  const { reportLines, runCases } = await import("./live.ts");
  const at = process.argv.indexOf("--only");
  const only = at === -1 ? undefined : process.argv[at + 1]?.split(",");
  const cases = (JSON.parse(readFileSync(join(HERE, "cases.json"), "utf8")) as Parameters<typeof runCases>[0]).filter((item) => !only || only.includes(item.id));
  const live = loadLiveInstance(process.env);
  const driver = BUILT_IN_DRIVERS.find((candidate) => candidate.driverKind === live.driver);
  if (!driver) throw new Error(`no driver ${live.driver}; known: ${BUILT_IN_DRIVERS.map((candidate) => candidate.driverKind).join(", ")}`);
  const environment: Record<string, string> = { ...live.environment };
  for (const name of live.environmentFrom ?? []) if (process.env[name] !== undefined) environment[name] = process.env[name]!;
  const instance = await driver.create({
    instanceId: live.instanceId,
    displayName: live.displayName,
    environment,
    enabled: true,
    config: driver.decodeConfig(live.config ?? driver.defaultConfig()),
  });
  try {
    if (!instance.generateText) throw new Error(`${live.driver} has no one-shot text call, so it cannot dream`);
    const generate = instance.generateText.bind(instance);
    const rows = await runCases(cases, async (prompt) => {
      let costUsd: number | undefined;
      const text = await generate(prompt, { model: live.model, timeoutMs: DREAM_TIMEOUT_MS, onUsage: (usage) => { costUsd = usage.costUsd; } });
      return { text, ...(costUsd === undefined ? {} : { costUsd }) };
    });
    for (const line of reportLines(rows, live.model)) console.log(line);
    const out = join(HERE, "..", "reports", "runs");
    mkdirSync(out, { recursive: true });
    const file = join(out, `dream-${live.model.replace(/[^\w.-]+/g, "_")}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify({ model: live.model, driver: live.driver, rows }, null, 2));
    console.log(`report: ${file}`);
  } finally {
    await instance.dispose();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
