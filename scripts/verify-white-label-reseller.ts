// By-hand entry point for the white-label reseller acceptance flow (docs/verification/white-label-reseller.md).
// Run it directly, not through pnpm, so Ctrl-C reaches it: node --experimental-strip-types scripts/verify-white-label-reseller.ts [--hold]
import { ResellerFlow } from "../server/testing/reseller-flow.ts";

async function main(): Promise<void> {
  const hold = process.argv.includes("--hold");
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--hold");
  if (unknown.length) throw new Error(`unknown option ${unknown[0]}; the only option is --hold`);
  if (process.env.npm_lifecycle_event) throw new Error("run this with node directly so Ctrl-C can stop the fixtures it owns");

  const startup = new AbortController();
  let flow: ResellerFlow | undefined;
  let interrupted = false;
  const interrupt = () => {
    interrupted = true;
    startup.abort();
    void flow?.close();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  try {
    flow = await ResellerFlow.start(startup.signal);
    const evidence = await flow.runAll();
    process.stdout.write(`${JSON.stringify({ ok: true, ...evidence }, null, 2)}\n`);
    if (hold && !interrupted) {
      process.stderr.write("holding the fixtures open; Ctrl-C stops them and removes their temporary folders\n");
      await new Promise<void>((resolve) => {
        process.once("SIGINT", resolve);
        process.once("SIGTERM", resolve);
      });
    }
  } catch (error) {
    if (!interrupted) throw error;
  } finally {
    await flow?.close();
  }
  if (interrupted) process.exitCode = 130;
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`);
  process.exitCode = 1;
});
