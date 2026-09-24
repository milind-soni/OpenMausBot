import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { removeTempDir, waitForExit } from "../../server/testing/cleanup.ts";
import { freePortBlock } from "../../server/testing/ports.ts";
import type { Scenario, Step } from "../types.ts";
import { buildScriptedPlan } from "../providers/mock/scripted-plan.ts";
import { BaseWorld, type WorldContext } from "./base-world.ts";
import { waitUntil } from "./api.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** The Local VM world: the real server with the container boundary replaced
 * by the in-repo VM fixture (no Podman, no network), exactly the proven
 * group-local-vm recipe. This is the only world where the lazy computer
 * claim seam (issue #1361) can be driven end to end. */
export class LocalVmWorld extends BaseWorld {
  private child: ChildProcess | undefined;
  private fixtureHome = "";
  private stateFile = "";
  private dumpFile = "";
  private planPath = "";
  private stderr = "";
  private computers = new Map<string, { url: string; token: string }>();

  override async boot(scenario: Scenario): Promise<void> {
    this.fixtureHome = mkdtempSync(join(tmpdir(), "omb-evals-vm-"));
    this.stateFile = join(this.fixtureHome, "vm.json");
    this.dumpFile = join(this.fixtureHome, "dump.json");
    const data = join(this.fixtureHome, "data");
    const ui = join(this.fixtureHome, "static");
    this.planPath = join(data, "room-plan.json");
    mkdirSync(join(ui, "assets"), { recursive: true });
    writeFileSync(join(ui, "index.html"), "<title>evals</title>");
    writeFileSync(join(ui, "assets", "eval.css"), "body{}");
    mkdirSync(data, { recursive: true });
    this.vmState({});
    writeFileSync(join(data, "config.json"), JSON.stringify({
      instances: {
        claude: {
          driver: "claudeAgent",
          config: { cli: join(ROOT, "server", "testing", "fake-claude-cli.ts") },
          environment: { FAKE_CLAUDE_ROOM_PLAN: this.planPath, FAKE_CLAUDE_DUMP: this.dumpFile },
        },
      },
    }));
    const port = await freePortBlock([0, 1]);
    const hooks = pathToFileURL(join(ROOT, "server", "testing", "group-local-vm-hooks.mjs")).href;
    const env: NodeJS.ProcessEnv = {
      PATH: dirname(process.execPath),
      HOME: this.fixtureHome,
      USERPROFILE: this.fixtureHome,
      OMB_DATA_DIR: data,
      APPDATA: join(this.fixtureHome, "appdata"),
      LOCALAPPDATA: join(this.fixtureHome, "localappdata"),
      TEMP: this.fixtureHome,
      TMP: this.fixtureHome,
      TMPDIR: this.fixtureHome,
      OMB_PORT: String(port),
      OMB_WEBHOOK_PORT: String(port + 1),
      OMB_STATIC_DIR: ui,
      OMB_TEST_VM_STATE: this.stateFile,
      ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    };
    const child = this.child = spawn(process.execPath, ["--import", hooks, join(ROOT, "server", "index.ts")], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.child.stderr?.on("data", (chunk) => (this.stderr += chunk));
    const base = "http://127.0.0.1:" + port;
    await waitUntil(
      "VM fixture server to come up",
      async () => {
        // exitCode stays null for a child killed by a signal; either way
        // the boot is over and the captured stderr says why
        if (child.exitCode !== null || child.signalCode !== null) {
          const how = child.signalCode !== null ? " (killed by " + child.signalCode + ")" : "";
          throw new Error("server exited" + how + ": " + this.stderr.slice(-2000));
        }
        try {
          return (await fetch(base + "/api/health")).ok;
        } catch {
          return false;
        }
      },
      (up) => up,
      20_000,
    );
    await this.initBase(base, this.planPath + ".evidence.jsonl", join(this.fixtureHome, "eval-gates"));
    for (const bot of scenario.bots) {
      const created = await this.api.post("/api/bots", { name: bot.name });
      if (created.status >= 300) throw new Error("bot create failed: " + JSON.stringify(created.body));
      this.bots.set(bot.key, { id: created.body.bot.id, threadId: created.body.bot.threadId });
      const patch: Record<string, unknown> = {};
      if (bot.computer !== undefined) patch.computer = bot.computer;
      if (bot.browser !== undefined) patch.browser = bot.browser;
      if (Object.keys(patch).length > 0) {
        const response = await this.api.patch("/api/bots/" + created.body.bot.id, patch);
        if (response.status >= 300) throw new Error("bot patch failed: " + JSON.stringify(response.body));
      }
    }
    const plan = buildScriptedPlan(scenario, (ref) => this.botId(ref), (gate) => this.gatePath(gate));
    writeFileSync(this.planPath, JSON.stringify(plan));
  }

  private vmState(state: Record<string, unknown>): void {
    writeFileSync(this.stateFile, JSON.stringify(state));
  }

  /** The fake engine dumps once per process; reads must tolerate a torn
   * partial write, and every read consumes the file so the next dump is
   * unambiguous. */
  private async readDump(timeoutMs: number): Promise<any> {
    const dump = await waitUntil(
      "engine dump",
      () => {
        if (!existsSync(this.dumpFile)) return null;
        try {
          return JSON.parse(readFileSync(this.dumpFile, "utf8"));
        } catch {
          return null;
        }
      },
      (value) => value !== null,
      timeoutMs,
    );
    rmSync(this.dumpFile, { force: true });
    return dump;
  }

  protected override async runWorldStep(step: Step, ctx: WorldContext): Promise<string> {
    switch (step.kind) {
      case "setVmState": {
        this.vmState(step.state);
        return "vm state set: " + JSON.stringify(step.state);
      }
      case "consumeDump": {
        await this.readDump(step.timeoutMs ?? 20_000);
        return "engine dump consumed";
      }
      case "captureComputer": {
        const dump = await this.readDump(20_000);
        const computer = dump?.mcpConfig?.mcpServers?.computer;
        if (!computer?.env?.OMB_CONTROL_URL) throw new Error("no computer mount in dump: " + JSON.stringify(dump?.mcpConfig ?? null));
        this.computers.set(step.bot, { url: computer.env.OMB_CONTROL_URL, token: computer.env.OMB_CONTROL_TOKEN });
        return "computer gate captured for " + step.bot;
      }
      case "pollComputerGate": {
        const computer = this.computers.get(step.bot);
        if (computer === undefined) throw new Error("no captured computer for " + step.bot);
        const response = await fetch(computer.url, { headers: { authorization: "Bearer " + computer.token } });
        const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        ctx.observations[step.saveAs] = { httpStatus: response.status, ...body };
        return "gate answered " + response.status + ": " + JSON.stringify(body);
      }
      default:
        throw new Error("step " + step.kind + " is not available in the localVm world");
    }
  }

  override async close(): Promise<void> {
    try {
      this.vmState({});
    } catch {
      /* the temp home may already be gone */
    }
    if (this.child !== undefined) await waitForExit(this.child, { signal: "SIGTERM" });
    await removeTempDir(this.fixtureHome);
  }
}
