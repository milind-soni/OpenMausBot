// Command dispatch for the `openmausbot` entry (openmausbot.ts runs this).
import { startFleetAgent } from "../fleet-agent.ts";
import { runFleetCommand, type FleetInput } from "../fleet-cli.ts";
import { fleetLayout } from "../fleet.ts";
import { runServiceCommand } from "../service-cli.ts";
import { runAccess, runBrowser, runLogin, runLogout, runStatus } from "./accounts.ts";
import { runOnboardingCommand } from "./onboarding.ts";
import { parseArgs, USAGE } from "./options.ts";
import { runPair } from "./pairing.ts";
import { runServe } from "./serve.ts";
import { runSessions } from "./sessions.ts";

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  if ("error" in options) {
    console.error(`${options.error}\n\n${USAGE}`);
    return 2;
  }
  process.env.OMB_DATA_DIR = options.dataDir;
  switch (options.command) {
    case "setup":
    case "start":
      return runOnboardingCommand(options);
    case "serve":
      return runServe(options);
    case "pair":
      return runPair(options);
    case "sessions":
      return runSessions(options);
    case "status":
      return runStatus(options);
    case "login":
      return runLogin(options);
    case "access":
      return runAccess(options);
    case "service":
      return runServiceCommand({
        action: options.serviceAction ?? "install",
        dataDir: options.dataDir,
        port: options.port,
        domain: options.domain,
        tunnel: options.tunnel,
        tailscale: options.tailscale,
        label: options.label,
        script: process.argv[1] ?? "",
        node: process.execPath,
      }, { log: (line) => console.log(line), error: (line) => console.error(line) });
    case "fleet":
      if (options.fleetAction === "agent") {
        const layout = fleetLayout();
        await startFleetAgent({
          socketPath: options.socket ?? layout.socketPath,
          group: options.group,
          node: process.execPath,
          script: process.argv[1] ?? "",
          licenseKey: options.licenseKey ?? process.env.OMB_LICENSE_KEY,
        }, { log: (line) => console.log(line) });
        // A service: stay up until systemd stops it.
        await new Promise<void>((resolveStop) => {
          for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => resolveStop());
        });
        return 0;
      }
      return runFleetCommand({
        // parseArgs refuses a fleet command without an action; "agent" was handled above
        action: options.fleetAction as FleetInput["action"],
        slug: options.slug,
        domain: options.domain,
        operator: options.operator ?? process.env.SUDO_USER,
        admins: options.admins ?? [],
        members: options.members ?? [],
        brandFile: options.brandFile,
        anthropicKeyFile: options.anthropicKeyFile,
        cap: options.cap,
        licenseKey: options.licenseKey ?? process.env.OMB_LICENSE_KEY,
        memory: options.memory,
        dryRun: options.dryRun ?? false,
        yes: options.yes ?? false,
        keepData: options.keepData ?? false,
        userAction: options.fleetUserAction,
        email: options.email,
        chatOnly: options.chatOnly,
        node: process.execPath,
        script: process.argv[1] ?? "",
      }, { log: (line) => console.log(line), error: (line) => console.error(line) });
    case "logout":
      return runLogout(options);
    case "browser":
      return runBrowser(options);
    default:
      console.log(USAGE);
      return 0;
  }
}
