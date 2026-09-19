import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Scenario, Step } from "../types.ts";
import type { SendReceipt, WorldSnapshot } from "../scorers/snapshot.ts";
import { makeClient, waitUntil } from "./api.ts";
import type { ApiClient } from "./api-types.ts";

export interface WorldContext {
  sends: SendReceipt[];
  observations: Record<string, unknown>;
}

/** Shared machinery for both worlds: one real harness server, an HTTP
 * client, the scripted plan's evidence log, gate files, and the common
 * steps. Worlds add only what is genuinely theirs. */
export abstract class BaseWorld {
  protected api!: ApiClient;
  protected bots = new Map<string, { id: string; threadId: string }>();
  private evidencePath = "";
  private gatesDir = "";
  /** Activity prefixes proven live by waitForActivity steps. The server
   * patches a wait chip in place when it settles ("Waiting for its turn..."
   * becomes "Computer free"), so a freeze-time read alone would lose the
   * waiting half of that history. */
  private activityFacts = new Map<string, Set<string>>();

  protected initBase(url: string, evidencePath: string, gatesDir: string): Promise<void> {
    this.evidencePath = evidencePath;
    this.gatesDir = gatesDir;
    mkdirSync(gatesDir, { recursive: true });
    return makeClient(url).then((client) => {
      this.api = client;
    });
  }

  protected gatePath(gate: string): string {
    return this.gatesDir === "" ? gate : this.gatesDir + "/" + gate;
  }

  /** Steps may name a bot as "worker" or "@worker"; the plain key is
   * what this.bots and evidence bot ids are recorded under. */
  protected botKey(ref: string): string {
    return ref.startsWith("@") ? ref.slice(1) : ref;
  }

  protected botId(ref: string): string {
    const bot = this.bots.get(this.botKey(ref));
    if (bot === undefined) throw new Error("unknown bot reference " + ref);
    return bot.id;
  }

  protected botKeyOf(botId: string): string {
    for (const [key, bot] of this.bots) if (bot.id === botId) return key;
    return botId;
  }

  /** Deep-resolves "@key" bot references to live ids. */
  protected resolveRefs(value: unknown): unknown {
    if (typeof value === "string" && value.startsWith("@")) return this.botId(value);
    if (Array.isArray(value)) return value.map((entry) => this.resolveRefs(entry));
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, this.resolveRefs(entry)]));
    }
    return value;
  }

  protected evidence(): Array<Record<string, any>> {
    if (!existsSync(this.evidencePath)) return [];
    return readFileSync(this.evidencePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }

  protected botState(botKey: string): Promise<any> {
    return this.api.get("/api/bots?messages=0").then((response) =>
      response.body.bots.find((bot: any) => bot.id === this.botId(botKey)),
    );
  }

  protected activities(botKey: string): Promise<string[]> {
    return this.api.get("/api/bots?messages=50").then((response) =>
      ((response.body.bots.find((bot: any) => bot.id === this.botId(botKey))?.messages ?? []) as Array<any>)
        .filter((message) => message.kind === "activity")
        .map((message) => message.tool?.name ?? ""),
    );
  }

  protected async threadMessages(threadId: string): Promise<Array<{ text?: string; kind?: string; tool?: { name?: string } }>> {
    const response = await this.api.get("/api/threads/" + threadId + "/messages");
    return (response.body.messages ?? []) as Array<{ text?: string; kind?: string; tool?: { name?: string } }>;
  }

  async runStep(step: Step, ctx: WorldContext): Promise<string> {
    switch (step.kind) {
      case "send": {
        const bot = this.bots.get(this.botKey(step.bot));
        if (bot === undefined) throw new Error("unknown bot " + step.bot);
        const response = await this.api.post("/api/bots/" + bot.id + "/messages", { text: step.text, threadId: bot.threadId });
        if (response.status >= 300) throw new Error("send failed: " + JSON.stringify(response.body));
        ctx.sends.push({ bot: step.bot, text: step.text, queued: response.body.queued });
        return "receipt " + (response.body.queued === true ? "queued" : "immediate");
      }
      case "waitForTurns": {
        const key = this.botKey(step.bot);
        await waitUntil(
          "turns for " + key,
          async () => this.evidence().filter((turn) => this.botKeyOf(turn.botId) === key).length,
          (count) => count >= step.count,
          step.timeoutMs ?? 20_000,
        );
        return step.count + " turn(s) recorded";
      }
      case "waitForBusy": {
        await waitUntil(
          "busy=" + step.busy + " for " + step.bot,
          async () => (await this.botState(step.bot))?.busy,
          (busy) => busy === step.busy,
          step.timeoutMs ?? 20_000,
        );
        return "busy is " + step.busy;
      }
      case "waitForActivity": {
        await waitUntil(
          "activity " + step.namePrefix + " for " + step.bot,
          async () => this.activities(step.bot),
          (names) => names.some((name) => name.startsWith(step.namePrefix)),
          step.timeoutMs ?? 20_000,
        );
        const facts = this.activityFacts.get(step.bot) ?? new Set<string>();
        facts.add(step.namePrefix);
        this.activityFacts.set(step.bot, facts);
        return "activity seen";
      }
      case "writeGate": {
        writeFileSync(this.gatePath(step.gate), "open\n");
        return "gate " + step.gate + " open";
      }
      default:
        return this.runWorldStep(step, ctx);
    }
  }

  protected abstract runWorldStep(step: Step, ctx: WorldContext): Promise<string>;

  protected readHandoffs(): Array<Record<string, any>> {
    return [];
  }

  async snapshot(ctx: WorldContext): Promise<WorldSnapshot> {
    const turns = this.evidence().map((turn) => ({
      bot: this.botKeyOf(turn.botId),
      index: turn.turnIndex,
      threadId: turn.threadId,
      system: turn.system ?? "",
      prompt: JSON.stringify(turn.prompt ?? null),
      toolCalls: ((turn.evidence ?? []) as Array<any>)
        .filter((entry) => entry?.step)
        .map((entry) => ({
          tool: entry.step.tool ?? "coordinate_bots",
          arguments: entry.step.arguments ?? {},
          errored: Boolean(entry.response?.error || entry.response?.result?.isError),
        })),
    }));
    const handoffs = this.readHandoffs().map((node) => ({
      bot: this.botKeyOf(node.botId),
      status: node.status,
      threadId: node.threadId,
      hasParent: Boolean(node.parentId) || undefined,
    }));
    const activeThreads: Record<string, string> = {};
    for (const [key, bot] of this.bots) activeThreads[key] = bot.threadId;
    const threads: WorldSnapshot["threads"] = {};
    const threadIds = new Set<string>(Object.values(activeThreads));
    for (const node of handoffs) if (node.threadId) threadIds.add(node.threadId);
    for (const threadId of threadIds) threads[threadId] = await this.threadMessages(threadId);
    const capturedActivities = await this.captureActivities();
    return {
      turns,
      handoffs,
      activeThreads,
      threads,
      sends: ctx.sends,
      observations: ctx.observations,
      activities: (bot) => [...(capturedActivities[bot] ?? []), ...(this.activityFacts.get(bot) ?? [])],
      resolve: (value) => this.resolveRefs(value),
    };
  }

  /** Freezes activities into the snapshot so scorers never hit the server. */
  protected async captureActivities(): Promise<Record<string, string[]>> {
    const captured: Record<string, string[]> = {};
    for (const key of this.bots.keys()) captured[key] = await this.activities(key);
    return captured;
  }

  abstract boot(scenario: Scenario): Promise<void>;
  abstract close(): Promise<void>;
}
