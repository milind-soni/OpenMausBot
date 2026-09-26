import { describe, expect, it, beforeEach } from "vitest";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EmbeddingClient, SkillRouterEntry, SkillRouterShard } from "./skill-router.ts";

// config.ts resolves DATA_DIR at import time, so point this suite at a
// scratch dir before any module under test loads.
process.env.OMB_DATA_DIR = mkdtempSync(join(tmpdir(), "omb-skill-router-"));

const router = await import("./skill-router.ts");
const library = await import("./skill-library.ts");
const skills = await import("./skills.ts");

const SKILL = (name: string, description: string, body = "Do the thing.") =>
  "---\nname: " + name + "\ndescription: " + description + "\n---\n\n# " + name + "\n\n" + body + "\n";

// A unit vector at exactly cosine c from the query vector [1, 0].
const at = (c: number): number[] => [c, Math.sqrt(Math.max(0, 1 - c * c))];

const entry = (name: string, cosineToQuery: number, text: string): SkillRouterEntry => ({
  name,
  source: "library",
  description: "description of " + name,
  excerpt: text,
  path: "/library/skills/" + name + "/SKILL.md",
  vector: at(cosineToQuery),
});

const filler = (count: number, cosine: number): SkillRouterEntry[] =>
  Array.from({ length: count }, (_, index) => entry("filler-" + String(index).padStart(2, "0"), cosine, "filler body"));

const shardOf = (entries: SkillRouterEntry[]): SkillRouterShard => ({
  version: 1,
  botId: "selector-bot",
  model: "synthetic-1",
  builtAt: "2026-09-26T00:00:00.000Z",
  entries,
});

const select = (shard: SkillRouterShard, queryText = "a query", recent?: readonly string[]) =>
  router.selectFromShard({ queryText, queryVector: [1, 0], shard, recent });

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("skill router selector (synthetic vectors)", () => {
  it("holds the 0.35 floor when every score clusters low", () => {
    const shard = shardOf([0.18, 0.19, 0.2, 0.21, 0.22].map((c, index) => entry("low-" + index, c, "unrelated text")));
    const selection = select(shard);
    expect(selection.threshold).toBeCloseTo(0.35, 10);
    expect(selection.pointers).toEqual([]);
  });

  it("raises the threshold to mean + 1.5 sigma when that exceeds the floor", () => {
    const shard = shardOf([entry("sharp", 0.95, "sharp"), ...filler(5, 0.3)]);
    const selection = select(shard);
    expect(selection.threshold).toBeGreaterThan(0.35);
    expect(selection.pointers.map((pointer) => pointer.name)).toEqual(["sharp"]);
    expect(selection.pointers[0]!.score).toBeCloseTo(0.95, 10);
  });

  it("returns at most three pointers, best scores first", () => {
    const shard = shardOf([
      entry("top", 0.9, "top body"),
      entry("second", 0.89, "second body"),
      entry("third", 0.88, "third body"),
      entry("fourth", 0.87, "fourth body"),
      entry("fifth", 0.86, "fifth body"),
      ...filler(15, 0.5),
    ]);
    const selection = select(shard);
    expect(selection.pointers.map((pointer) => pointer.name)).toEqual(["top", "second", "third"]);
    expect(selection.reranked).toBe(false);
  });

  it("reranks a crowded, unconfident selection; lexical overlap picks the order", () => {
    const deploy = entry("deploy-runbook", 0.63, "Roll out the database migration runbook for deploy changes");
    const blur = entry("gaussian-blur", 0.64, "Pixels and kernels");
    const shard = shardOf([blur, deploy, ...filler(8, 0.55)]);
    const selection = select(shard, "deploy the database migration runbook safely");
    expect(selection.reranked).toBe(true);
    // First-stage order would be gaussian-blur (0.64) over deploy-runbook
    // (0.63); the rerank's lexical bonus flips it, and the reported score
    // stays the first-stage cosine.
    expect(selection.pointers.map((pointer) => pointer.name)).toEqual(["deploy-runbook", "gaussian-blur"]);
    expect(selection.pointers[0]!.score).toBeCloseTo(0.63, 10);
  });

  it("skips the rerank below four candidates", () => {
    const shard = shardOf([entry("a", 0.6, "alpha"), entry("b", 0.59, "beta"), entry("c", 0.58, "gamma")]);
    expect(select(shard).reranked).toBe(false);
  });

  it("skips the rerank when the top score is already confident", () => {
    const shard = shardOf([0.7, 0.69, 0.68, 0.67, 0.66].map((c, index) => entry("conf-" + index, c, "body")));
    const selection = select(shard);
    expect(selection.topScore).toBeGreaterThanOrEqual(0.65);
    expect(selection.reranked).toBe(false);
  });

  it("skips the rerank when scores are spread", () => {
    const shard = shardOf([
      entry("hi", 0.64, "a"),
      entry("mid", 0.63, "b"),
      entry("low", 0.5, "c"),
      entry("bottom", 0.4, "d"),
    ]);
    const selection = select(shard);
    expect(selection.spread).toBeGreaterThanOrEqual(0.10);
    expect(selection.reranked).toBe(false);
  });

  it("dedups a skill pointed out within the last four turns, and not older ones", () => {
    const shard = shardOf([entry("fresh", 0.9, "fresh"), entry("next", 0.85, "next"), ...filler(6, 0.3)]);
    const deduped = select(shard, "query", ["fresh"]);
    expect(deduped.pointers.map((pointer) => pointer.name)).toEqual(["next"]);
    // "fresh" is five turns back: only the last four entries of recent count.
    const older = select(shard, "query", ["fresh", "turn-2", "turn-3", "turn-4", "turn-5"]);
    expect(older.pointers.map((pointer) => pointer.name)).toEqual(["fresh", "next"]);
  });

  it("is deterministic across repeated selects", () => {
    const shard = shardOf([
      entry("top", 0.9, "top"),
      entry("second", 0.89, "second"),
      entry("third", 0.88, "third"),
      entry("fourth", 0.87, "fourth"),
      entry("fifth", 0.86, "fifth"),
      ...filler(15, 0.5),
    ]);
    const first = select(shard, "repeat me", ["fourth"]);
    for (let i = 0; i < 5; i++) expect(select(shard, "repeat me", ["fourth"])).toEqual(first);
  });

  it("flattens skill text into a bounded excerpt and embeds frontmatter plus excerpt", () => {
    const text = SKILL("excerpt-check", "Checks excerpts", "# Excerpt check\n\n" + "word ".repeat(400));
    const excerpt = router.excerptFromSkillText(text);
    expect(excerpt).not.toContain("\n");
    expect(excerpt).not.toContain("---");
    expect(excerpt.length).toBeLessThanOrEqual(512);
    expect(excerpt.startsWith("# excerpt-check # Excerpt check")).toBe(true);
    expect(excerpt).toContain("word word");
    const documentText = router.shardDocumentText({ name: "excerpt-check", description: "Checks excerpts", excerpt: "abc" });
    expect(documentText).toBe("name: excerpt-check\ndescription: Checks excerpts\nabc");
  });
});

describe("skill router shard build and service", () => {
  let counter = 0;
  let bot: string;
  beforeEach(() => {
    counter += 1;
    bot = "router-bot-" + counter;
  });

  const countingEmbed = (): { client: EmbeddingClient; batches: string[][] } => {
    const batches: string[][] = [];
    return {
      batches,
      client: {
        model: "synthetic-1",
        embed: async (texts) => {
          batches.push([...texts]);
          return texts.map((text) => (text.includes("deploy") ? at(0.95) : at(0.2)));
        },
      },
    };
  };
  const buildBatches = (batches: string[][]): string[][] => batches.filter((batch) => batch[0]?.startsWith("name:"));

  it("indexes enabled private and assigned library skills, private winning collisions", async () => {
    const priv = skills.installSkill(bot, "https://example.com/priv", [
      { path: "SKILL.md", content: SKILL("code-review", "Private review flavor") },
    ]);
    expect("error" in priv).toBe(false);
    expect("error" in skills.setSkillEnabled(bot, "code-review", true)).toBe(false);
    const disabled = skills.installSkill(bot, "https://example.com/off", [
      { path: "SKILL.md", content: SKILL("archived-flow", "Stays disabled") },
    ]);
    expect("error" in disabled).toBe(false);
    expect("error" in library.installLibrarySkill({
      name: "code-review",
      instructions: SKILL("code-review", "Library review flavor"),
      source: "library",
      reviewState: "approved",
    })).toBe(false);
    expect("error" in library.installLibrarySkill({
      name: "pdf-signing",
      instructions: SKILL("pdf-signing", "Sign PDFs"),
      source: "library",
      reviewState: "approved",
    })).toBe(false);

    const documents = router.collectBotSkillDocuments(bot, ["code-review", "pdf-signing"]);
    expect(documents.map((document) => [document.name, document.source])).toEqual([
      ["code-review", "private"],
      ["pdf-signing", "library"],
    ]);
    expect(documents[0]!.excerpt).toContain("Do the thing");
    expect(documents[1]!.path).toContain("skills-library");

    const embed = countingEmbed();
    const shard = await router.buildSkillRouterShard({
      botId: bot,
      assignedLibrary: ["code-review", "pdf-signing"],
      embed: embed.client,
    });
    expect(shard.entries.map((skill) => skill.name)).toEqual(["code-review", "pdf-signing"]);
    expect(buildBatches(embed.batches)).toHaveLength(1);
    expect(buildBatches(embed.batches)[0]).toHaveLength(2);
    expect(router.loadRouterShard(bot, "synthetic-1")).toEqual(shard);
    expect(router.loadRouterShard(bot, "other-model")).toBeNull();
  });

  it("rebuilds held shards when a library invalidation event fires", async () => {
    expect("error" in library.installLibrarySkill({
      name: "triage-playbook",
      instructions: SKILL("triage-playbook", "Triage"),
      source: "library",
      reviewState: "approved",
    })).toBe(false);
    const embed = countingEmbed();
    const service = router.createSkillRouter({ embed: embed.client, enabled: true });
    try {
      await service.rebuild(bot, ["triage-playbook"]);
      expect(service.shard(bot)!.entries.map((skill) => skill.name)).toEqual(["triage-playbook"]);
      // Disabling the assigned skill is a library write: the event, not an
      // explicit rebuild call, must refresh the held shard.
      expect("error" in library.setLibrarySkillReviewState("triage-playbook", "disabled")).toBe(false);
      await flush();
      await flush();
      expect(service.shard(bot)!.entries).toEqual([]);
      // An empty shard embeds nothing; re-enabling is a second library
      // write, so the eager rebuild makes the second build batch.
      expect("error" in library.setLibrarySkillReviewState("triage-playbook", "approved")).toBe(false);
      await flush();
      await flush();
      expect(service.shard(bot)!.entries.map((skill) => skill.name)).toEqual(["triage-playbook"]);
      expect(buildBatches(embed.batches)).toHaveLength(2);
    } finally {
      service.close();
    }
  });

  it("rebuilds when assignments change even though no event fires", async () => {
    expect("error" in library.installLibrarySkill({
      name: "deploy-runbook",
      instructions: SKILL("deploy-runbook", "Deploy"),
      source: "library",
      reviewState: "approved",
    })).toBe(false);
    const embed = countingEmbed();
    const service = router.createSkillRouter({ embed: embed.client, enabled: true });
    try {
      await service.rebuild(bot, []);
      expect(service.shard(bot)!.entries).toEqual([]);
      await service.select({ botId: bot, assignedLibrary: ["deploy-runbook"], text: "deploy the database" });
      expect(service.shard(bot)!.entries.map((skill) => skill.name)).toEqual(["deploy-runbook"]);
    } finally {
      service.close();
    }
  });

  it("runs nothing while the flag is off: empty selections, no embed calls, no state", async () => {
    const embed = countingEmbed();
    const service = router.createSkillRouter({ embed: embed.client, enabled: false });
    const selection = await service.select({ botId: bot, text: "deploy the runbook" });
    expect(selection.pointers).toEqual([]);
    await service.rebuild(bot);
    expect(embed.batches).toEqual([]);
    expect(existsSync(router.routerShardPath(bot))).toBe(false);
    service.close();
  });

  it("selects through the service and adopts a persisted shard without re-embedding", async () => {
    expect("error" in library.installLibrarySkill({
      name: "deploy-runbook",
      instructions: SKILL("deploy-runbook", "Deploy"),
      source: "library",
      reviewState: "approved",
    })).toBe(false);
    const embed = countingEmbed();
    const first = router.createSkillRouter({ embed: embed.client, enabled: true });
    await first.select({ botId: bot, assignedLibrary: ["deploy-runbook"], text: "deploy the database" });
    first.close();
    expect(buildBatches(embed.batches)).toHaveLength(1);

    const second = router.createSkillRouter({ embed: embed.client, enabled: true });
    try {
      const selection = await second.select({
        botId: bot,
        assignedLibrary: ["deploy-runbook"],
        text: "deploy the database",
      });
      expect(selection.pointers.map((pointer) => pointer.name)).toEqual(["deploy-runbook"]);
      // The persisted shard was adopted: the build embed ran once, total.
      expect(buildBatches(embed.batches)).toHaveLength(1);
    } finally {
      second.close();
    }
  });
});
