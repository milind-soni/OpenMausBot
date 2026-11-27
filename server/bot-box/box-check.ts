// `node dist-server/bot-box/box-check.js [--mutate=bind-data,share-pid] [--public=host:port|none] [--root=DIR]`
// Runs the box self-check (self-check.ts) on this machine and prints its JSON: what the Admin's `checks: n/n` counts,
// runnable by hand on a Cloud home or a test machine, with mutations to prove each check has teeth.
// `node dist-server/bot-box/box-check.js --exec -- COMMAND [ARGS...]` runs one command in a box planned as a bot's turn is
// in this server's own layout (OMB_DATA_DIR and HOME as the server has them, a bot folder of its own, no network) and
// exits with its code: what a test proves a bot can and cannot reach on this very server.
import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { engineInstallRoots } from "../engine-roots.ts";
import { BoxRunner, defaultCodeRoots, writeSeccompFile } from "./box.ts";
import { boxWanted, detectBox, serverImage } from "./detect.ts";
import { BOX_MUTATIONS, type BoxMutation } from "./plan.ts";
import { runBoxSelfCheck } from "./self-check.ts";

export const CHECK_DENY_ENV: ReadonlySet<string> = new Set(["COMPOSIO_API_KEY", "OMB_COMPOSIO_BROKER_TOKEN"]);

/** The bot the `--exec` box is planned for: its folder is made for the run and removed after, when the run made it. */
export const EXEC_BOT = "box-check-exec";

/** One command in a bot's box in this server's real layout; resolves to its exit code (126 when the box could not start). */
export async function boxExec(command: readonly string[], env: Record<string, string | undefined> = process.env, out: { stdio?: "inherit" | "pipe" } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  if (!command.length) throw new Error("--exec needs a command after --");
  if (!env.OMB_DATA_DIR) throw new Error("--exec needs OMB_DATA_DIR, the server's data folder");
  const detection = detectBox({ env: { ...env, OMB_BOT_BOX: "1" } });
  if (detection.box !== "bwrap" || !detection.tools) throw new Error(`the box cannot start here (${detection.reason})`);
  const dataDir = env.OMB_DATA_DIR, home = env.HOME ?? homedir();
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = (name: string) => existsSync(join(here, `${name}.ts`)) ? join(here, `${name}.ts`) : join(here, `${name}.js`);
  const root = join(dataDir, "box");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const botFolder = join(dataDir, "workspaces", EXEC_BOT);
  const made = !existsSync(botFolder);
  mkdirSync(botFolder, { recursive: true, mode: 0o700 });
  const runner = new BoxRunner({
    bwrap: detection.tools.bwrap, bridge: { socat: detection.tools.socat, bridgeScript: sibling("box-bridge"), node: process.execPath },
    setup: { dataDir, home, codeRoots: [dirname(dirname(here)), ...defaultCodeRoots()], engineRoots: engineInstallRoots(dataDir), bridges: [] },
    denyEnv: CHECK_DENY_ENV, seccompFile: writeSeccompFile(root),
  });
  const wrapped = runner.wrap({ command: command[0]!, args: command.slice(1), cwd: botFolder, botId: EXEC_BOT, env: { PATH: env.PATH, HOME: home, LANG: env.LANG } });
  try {
    return await new Promise((resolve) => {
      const piped = out.stdio === "pipe";
      const child = spawn(wrapped.command, wrapped.args, { env: wrapped.env, windowsHide: true, stdio: [piped ? "ignore" : "inherit", piped ? "pipe" : "inherit", piped ? "pipe" : "inherit", ...wrapped.extraFds] });
      for (const fd of wrapped.extraFds) try { closeSync(fd); } catch {}
      let stdout = "", stderr = "";
      // UTF-8 decoded across chunks, and the answer given on "close", once both streams have ended.
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
      child.once("error", (error) => resolve({ code: 126, stdout, stderr: `${stderr}the box could not start: ${error.message}` }));
      const settle = (code: number | null, signal: NodeJS.Signals | null) => resolve({ code: code ?? (signal ? 128 : 1), stdout, stderr });
      // On "close", or two seconds after "exit" when something the command left behind keeps a pipe open.
      child.once("exit", (code, signal) => { setTimeout(() => settle(code, signal), 2_000).unref(); });
      child.once("close", settle);
    });
  } finally {
    wrapped.release();
    if (made) rmSync(botFolder, { recursive: true, force: true });
  }
}

export async function boxCheckMain(argv: readonly string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  if (argv[0] === "--exec") {
    const dash = argv.indexOf("--");
    if (dash !== 1) throw new Error("usage: box-check.js --exec -- COMMAND [ARGS...]");
    return (await boxExec(argv.slice(dash + 1), env)).code;
  }
  const mutate = new Set<BoxMutation>();
  let publicTarget: string | null | undefined;
  let root = env.OMB_DATA_DIR ? join(env.OMB_DATA_DIR, "box") : join(tmpdir(), "omb-box-check");
  for (const arg of argv) {
    const [name, value = ""] = arg.split("=", 2) as [string, string?];
    if (name === "--mutate") for (const item of value.split(",").filter(Boolean)) {
      if (!BOX_MUTATIONS.includes(item as BoxMutation)) throw new Error(`unknown mutation ${item}; one of ${BOX_MUTATIONS.join(", ")}`);
      mutate.add(item as BoxMutation);
    } else if (name === "--public") publicTarget = value === "none" ? null : value;
    else if (name === "--root") root = value;
    else throw new Error(`unknown argument ${arg}`);
  }
  const detection = detectBox({ env: { ...env, OMB_BOT_BOX: env.OMB_BOT_BOX ?? "1" } });
  if (detection.box !== "bwrap" || !detection.tools) {
    process.stdout.write(`${JSON.stringify({ box: detection.box, reason: detection.reason })}\n`);
    return 2;
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  // This entry is bundled into its own file beside the bridge and the probe, so they are found next to it, not through
  // the server root the inlined proxy-paths would compute from here.
  const here = dirname(fileURLToPath(import.meta.url));
  const sibling = (name: string) => existsSync(join(here, `${name}.ts`)) ? join(here, `${name}.ts`) : join(here, `${name}.js`);
  const result = await runBoxSelfCheck({
    bwrap: detection.tools.bwrap, bridge: { socat: detection.tools.socat, bridgeScript: sibling("box-bridge"), node: process.execPath },
    probeScript: sibling("box-probe"), codeRoots: [dirname(dirname(here)), ...defaultCodeRoots()],
    root, denyEnv: CHECK_DENY_ENV, mutate, publicTarget, seccompFile: writeSeccompFile(root),
    nestedUserns: serverImage(env) || boxWanted(env) === "required",
  });
  process.stdout.write(`${JSON.stringify({ box: detection.box, bridge: detection.tools.socat ? "socat" : "node", mutate: [...mutate], ...result })}\n`);
  return result.error || result.failed.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  boxCheckMain(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
