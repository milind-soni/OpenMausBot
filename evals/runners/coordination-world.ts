import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { launchVerificationServer, runControlOmb, type VerificationServer } from "../../scripts/control-omb.ts";
import type { Scenario, Step } from "../types.ts";
import { buildScriptedPlan } from "../providers/mock/scripted-plan.ts";
import { BaseWorld, type WorldContext } from "./base-world.ts";
import { waitUntil } from "./api.ts";

/** The coordination world: the real server plus the scripted engine, exactly
 * the proven e2e recipe (launchVerificationServer with room scripting). * Ordinary chat, coordinate_bots handoffs, and routines run end to end. */
export class CoordinationWorld extends BaseWorld {
  private session: VerificationServer | undefined;
  private dataDir = "";
  private planPath = "";
  private routines = new Map<string, string>();
  private latestRuns = new Map<string, string>();

  override async boot(scenario: Scenario): Promise<void> {
    this.session = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
    this.dataDir = this.session.info.dataDir;
    this.planPath = join(this.dataDir, "room-plan.json");
    await this.initBase(this.session.info.url, this.planPath + ".evidence.jsonl", join(this.dataDir, "eval-gates"));
    // Create every bot first, then patch: a Chief's managedSections can only
    // name a team that already exists, and teams materialize when a member is
    // created with --section (the same order the e2e fixtures use).
    for (const bot of scenario.bots) {
      const argv = ["new-bot", "--name", bot.name];
      if (bot.section !== undefined) argv.push("--section", bot.section);
      const created = (await runControlOmb(argv, { env: { OPENMAUSBOT_URL: this.session.info.url } })) as { bot: { id: string; activeTaskId: string } };
      this.bots.set(bot.key, { id: created.bot.id, threadId: created.bot.activeTaskId });
    }
    for (const bot of scenario.bots) {
      const patch: Record<string, unknown> = {};
      if (bot.chiefOfStaff !== undefined) patch.chiefOfStaff = bot.chiefOfStaff;
      if (bot.managedSections !== undefined) patch.managedSections = bot.managedSections;
      if (bot.acknowledgePeerScope !== undefined) patch.acknowledgePeerScope = bot.acknowledgePeerScope;
      else if ((bot.managedSections ?? []).length > 0) patch.acknowledgePeerScope = true;
      if (Object.keys(patch).length > 0) {
        const response = await this.api.patch("/api/bots/" + this.botId(bot.key), patch);
        if (response.status >= 300) throw new Error("bot patch failed: " + JSON.stringify(response.body));
      }
    }
    this.writePlan(scenario);
  }

  private writePlan(scenario: Scenario): void {
    const plan = buildScriptedPlan(
      scenario,
      (ref) => this.botId(ref),
      (gate) => this.gatePath(gate),
    );
    writeFileSync(this.planPath, JSON.stringify(plan));
  }

  protected override async runWorldStep(step: Step, ctx: WorldContext): Promise<string> {
    switch (step.kind) {
      case "createRoutine": {
        const response = await this.api.post("/api/routines", {
          name: step.routine,
          prompt: step.prompt,
          botId: this.botId(step.bot),
          enabled: false,
          schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
        });
        if (response.status !== 201) throw new Error("routine create failed: " + JSON.stringify(response.body));
        this.routines.set(step.routine, response.body.routine.id);
        return "routine " + step.routine + " created";
      }
      case "waitForNodeStatus": {
        const key = step.bot.startsWith("@") ? step.bot.slice(1) : step.bot;
        await waitUntil(
          "handoff node " + key + " to be " + step.status,
          async () => this.readHandoffs().find((node) => this.botKeyOf(node.botId) === key)?.status,
          (status) => status === step.status,
          step.timeoutMs ?? 20_000,
        );
        return "node " + key + " is " + step.status;
      }
      case "setConfig": {
        const response = await this.api.patch("/api/config", step.config);
        if (response.status >= 300) throw new Error("config patch failed: " + JSON.stringify(response.body));
        return "config patched: " + JSON.stringify(step.config);
      }
      case "runRoutine": {
        const id = this.routines.get(step.routine);
        if (id === undefined) throw new Error("unknown routine " + step.routine);
        const response = await this.api.post("/api/routines/" + id + "/run");
        if (response.status !== 201) throw new Error("routine run failed: " + JSON.stringify(response.body));
        this.latestRuns.set(step.routine, response.body.run.id);
        return "run " + response.body.run.id + " queued";
      }
      case "snapshotRoutineRun": {
        const run = await this.findRun(step.routine);
        ctx.observations[step.saveAs] = {
          status: run?.status,
          deferredAt: run?.deferredAt,
          executionThreadId: run?.executionThreadId,
        };
        return "run is " + (run?.status ?? "missing");
      }
      case "waitForRoutineRun": {
        const status = await waitUntil(
          "routine run " + step.routine + " to be " + step.status,
          async () => (await this.findRun(step.routine))?.status,
          (value) => value === step.status,
          step.timeoutMs ?? 30_000,
        );
        return "run is " + status;
      }
      default:
        throw new Error("step " + step.kind + " is not available in the coordination world");
    }
  }

  private async findRun(routineKey: string): Promise<any> {
    const routineId = this.routines.get(routineKey);
    if (routineId === undefined) throw new Error("unknown routine " + routineKey);
    const response = await this.api.get("/api/routines");
    const runs = (response.body.runs ?? []).filter((run: any) => run.routineId === routineId);
    const wanted = this.latestRuns.get(routineKey);
    return runs.find((run: any) => run.id === wanted) ?? runs.at(-1);
  }

  protected override readHandoffs(): Array<Record<string, any>> {
    const path = join(this.dataDir, "room-handoffs.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, any>>) : [];
  }

  override async close(): Promise<void> {
    await this.session?.close();
  }
}
