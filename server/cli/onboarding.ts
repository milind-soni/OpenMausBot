// `setup` and `start`: the guided first-run and saved-settings launches.
import { homedir } from "node:os";
import { join } from "node:path";

import { defaultSetupIo, SetupCancelled, type SetupIo } from "../cli-prompts.ts";
import { runPhoneSetup } from "../cli-phone-setup.ts";
import { createTunnelAccount, describeTunnelAccount } from "../tunnel.ts";
import { runLogin } from "./accounts.ts";
import { isWorkspaceRunning, openDashboard } from "./client.ts";
import { defaultIo, serverVersion, type CliIo, type CliOptions } from "./options.ts";
import { applyStartupPreferences, startupPreferences } from "./prefs.ts";
import { runServe } from "./serve.ts";

/** Keep setup imports behind the data-dir override: config binds its paths
 * when first imported. `serve` remains usable with stdin closed. */
export async function runOnboardingCommand(
  options: CliOptions,
  io: CliIo = defaultIo(),
  startServer: (options: CliOptions) => Promise<number> = runServe,
  flow: { prompts?: SetupIo; phoneSetup?: typeof runPhoneSetup; running?: typeof isWorkspaceRunning; open?: typeof openDashboard } = {},
): Promise<number> {
  const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
  if (options.command === "setup" && !interactive) {
    io.error("Setup needs an interactive terminal. Run `npx openmausbot setup` in a terminal, then use `npx openmausbot serve` for unattended starts.");
    return 1;
  }
  process.env.OMB_DATA_DIR = options.dataDir;
  if (options.command !== "setup" && await (flow.running ?? isWorkspaceRunning)(options)) {
    if (options.local || options.tunnel || options.tailscale || options.publicUrl) {
      io.error("This workspace is already running. Stop it before changing local or remote access; the current connection was not changed.");
      return 1;
    }
    io.log(`Your workspace is already running: http://127.0.0.1:${options.port}`);
    io.log("No second server was started. Your existing bots and conversations are unchanged.");
    if (interactive && options.open !== false) await (flow.open ?? openDashboard)(options.port);
    return 0;
  }
  const { runSetup, isSetupComplete, readCliStartup, saveCliStartup } = await import("../cli-setup.ts");
  const prompts = flow.prompts ?? defaultSetupIo();
  try {
    if (options.command === "setup" || !(await isSetupComplete(options.dataDir))) {
      if (!interactive) {
        io.error("No completed setup was found. Run `npx openmausbot setup` in an interactive terminal first, or use `npx openmausbot serve` with an existing configuration.");
        return 1;
      }
      if (!(await runSetup({ dataDir: options.dataDir, port: options.port }))) {
        io.log("Setup cancelled. Run openmausbot when you're ready.");
        return 130;
      }
    }
    const saved = readCliStartup(options.dataDir);
    // An explicit setup revisits the access choice. Normal starts reuse consent
    // instead of asking again or unexpectedly turning a local session public.
    let launch = options.command === "setup" ? options : applyStartupPreferences(options, saved);
    if (interactive && options.pair && !options.local && (options.command === "setup" || !saved)) {
      io.log("\nOne optional step: connect your phone. You can skip this and start chatting here.");
      const result = await (flow.phoneSetup ?? runPhoneSetup)(launch, prompts, {
        accountReady: (value) => !!describeTunnelAccount(createTunnelAccount({ dataDir: value.dataDir, version: serverVersion() }).credentials.read()).email,
        login: (value, ui) => runLogin(value, {
          log: ui.log, error: ui.log,
          ask: (question) => /code/i.test(question) ? ui.secret(question) : ui.ask(question),
        }),
      });
      launch = { ...result.options, phone: result.phone };
      saveCliStartup(options.dataDir, startupPreferences(launch));
    }
    if (options.command === "setup") {
      io.log("\nAll set. Start with: openmausbot (or npx openmausbot without a global install).");
      if (options.dataDir !== join(homedir(), ".openmausbot") || options.port !== 8799) {
        io.log(`Use the same --data-dir (${options.dataDir}) and --port (${options.port}) options when starting.`);
      }
      return 0;
    }
    if (saved) io.log("\nWelcome back. Using your saved AI connection.");
    return startServer({ ...launch, guided: interactive });
  } catch (error) {
    if (!(error instanceof SetupCancelled)) throw error;
    io.log("\nSetup stopped. Any AI setup already saved is kept; no server was started. Run openmausbot setup to continue.");
    return 130;
  }
}
