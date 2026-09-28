import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { runControlOmb } from "../../scripts/control-omb.ts";
import type { Scenario, Step } from "../types.ts";
import { BaseWorld, type WorldContext } from "../runners/base-world.ts";
import { waitUntil } from "../runners/api.ts";
import { spawnLiveServer, type LiveServerSession } from "./live-server.ts";
import type { LiveInstance } from "./types.ts";

/** The live world: the real server plus one real engine instance. Bots
 * are real, turns are real model turns, and evidence rows are derived
 * from the threads' own messages so the same snapshot/assertion machinery
 * as the offline tiers scores live behavior. */

export class LiveWorld extends BaseWorld {
  private session: LiveServerSession | undefined;
  private dataDir = "";
  private readonly instance: LiveInstance;
  private readonly passEnvNames: string[];

  constructor(instance: LiveInstance, passEnvNames: string[] = []) {
    super();
    this.instance = instance;
    this.passEnvNames = passEnvNames;
  }

  override async boot(scenario: Scenario): Promise<void> {
    this.session = await spawnLiveServer(process.env, this.instance, this.passEnvNames);
    this.dataDir = this.session.dataDir;
    await this.initBase(this.session.url, join(this.dataDir, "live-evidence.jsonl"), join(this.dataDir, "eval-gates"));
    for (const bot of scenario.bots) await this.createBot(bot.key, bot.name);
    for (const bot of scenario.bots) {
      const patch: Record<string, unknown> = {};
      if (bot.section !== undefined) patch.section = bot.section;
      if (bot.chiefOfStaff !== undefined) patch.chiefOfStaff = bot.chiefOfStaff;
      if (bot.managedSections !== undefined) patch.managedSections = bot.managedSections;
      if (bot.managedSections !== undefined && bot.acknowledgePeerScope === undefined) patch.acknowledgePeerScope = true;
      else if (bot.acknowledgePeerScope !== undefined) patch.acknowledgePeerScope = bot.acknowledgePeerScope;
      if (Object.keys(patch).length > 0) {
        const response = await this.api.patch("/api/bots/" + this.botId(bot.key), patch);
        if (response.status >= 300) throw new Error("bot patch failed: " + JSON.stringify(response.body));
      }
    }
  }

  /** Creates one more bot mid-run (the judge gets its own bot so its turns
   * never pollute the scenario bot's evidence). */
  async createBot(key: string, name: string): Promise<void> {
    const created = (await runControlOmb(["new-bot", "--name", name], {
      env: { OPENMAUSBOT_URL: this.session!.url },
    })) as { bot: { id: string; activeTaskId: string } };
    this.bots.set(key, { id: created.bot.id, threadId: created.bot.activeTaskId });
    const response = await this.api.patch("/api/bots/" + created.bot.id, {
      modelSelection: { instanceId: this.instance.instanceId, model: this.instance.model },
    });
    if (response.status >= 300) throw new Error("model selection patch failed: " + JSON.stringify(response.body));
  }

  protected override async runWorldStep(step: Step, _ctx: WorldContext): Promise<string> {
    if (step.kind === "waitForNodeStatus") {
      const key = this.botKey(step.bot);
      await waitUntil(
        "handoff node " + key + " to be " + step.status,
        async () => this.readHandoffs().find((node) => this.botKeyOf(node.botId) === key)?.status,
        (status) => status === step.status,
        step.timeoutMs ?? 20_000,
      );
      return "node " + key + " is " + step.status;
    }
    if (step.kind === "setConfig") {
      const response = await this.api.patch("/api/config", step.config);
      if (response.status >= 300) throw new Error("config patch failed: " + JSON.stringify(response.body));
      return "config patched: " + JSON.stringify(step.config);
    }
    throw new Error("step " + step.kind + " is not available in the live world");
  }

  protected override readHandoffs(): Array<Record<string, any>> {
    const path = join(this.dataDir, "room-handoffs.json");
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Array<Record<string, any>>) : [];
  }

  /** Derives scripted-engine-shaped evidence rows from each bot's real
   * thread: one row per real turn, tool calls from that turn's activity
   * messages. This is what lets the tier-1 snapshot and scorers score a
   * live run unchanged. */
  protected override async evidence(): Promise<Array<Record<string, any>>> {
    const rows: Array<Record<string, any>> = [];
    for (const [key, bot] of this.bots) {
      const messages = await this.threadMessages(bot.threadId);
      const botMessages = messages.filter((message) => message.role === "bot");
      const turns = new Map<string, Array<(typeof botMessages)[number]>>();
      botMessages.forEach((message, index) => {
        const turnKey = message.turnId ?? "turn-" + index;
        const bucket = turns.get(turnKey) ?? [];
        bucket.push(message);
        turns.set(turnKey, bucket);
      });
      let turnIndex = 0;
      for (const bucket of turns.values()) {
        rows.push({
          botId: bot.id,
          botKey: key,
          turnIndex,
          threadId: bot.threadId,
          system: "",
          prompt: "",
          evidence: bucket
            .filter((message) => message.kind === "activity" && message.tool?.name !== undefined)
            .map((message) => ({
              step: { tool: message.tool!.name!, arguments: message.tool?.arguments ?? {} },
              response: {},
            })),
        });
        turnIndex += 1;
      }
    }
    return rows;
  }

  override async close(): Promise<void> {
    await this.session?.close();
  }
}
