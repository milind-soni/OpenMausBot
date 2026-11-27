import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireBot, WireMessage } from "../shared/wire.ts";
import { SKILL_REVIEW_MARKER } from "./skill-review.ts";

const SKILL_MD = "---\nname: weekly-report\ndescription: Writes the weekly status report.\n---\n\n# Weekly report\n\nWrites the weekly status report from the project notes.\n\n## When to Use\n- \"write the weekly report\"\n\n## Procedure\n1. Read notes/status.md.\n2. Keep it to five bullets.\n\n## Pitfalls\n- Ask which week when the notes span two.\n\n## Verification\n- The report has at most five bullets.\n";

it("reviews a conversation in the background once its tool steps reach the threshold", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-skill-review-"));
  const routes = join(scratch, "routes.json");
  writeFileSync(routes, JSON.stringify({
    [SKILL_REVIEW_MARKER]: JSON.stringify({ changes: [{ action: "create", skill_md: SKILL_MD, gist: "Five-bullet weekly report." }], note: "one lesson" }),
  }));
  const fixture = await launchVerificationServer({
    ...process.env,
    FAKE_CLAUDE_TEXT_ROUTES: routes,
    FAKE_CLAUDE_TEXT_DUMP: join(scratch, "one-shot.json"),
    FAKE_CLAUDE_TOOL_CALLS: JSON.stringify([
      { name: "Read", input: { file_path: "notes/status.md" }, ok: true, output: "notes" },
      { name: "Grep", input: { pattern: "done" }, ok: true, output: "3 matches" },
    ]),
  });
  const { url } = fixture.info;
  const api = async <T = any>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status, `${method} ${path}`).toBe(status);
    return response.json() as Promise<T>;
  };
  const turn = async (bot: WireBot, text: string) => {
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", text, "--url", url]);
    expect(await runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });
  };
  const messages = async (bot: WireBot) =>
    ((await api<{ bots: Array<WireBot & { messages: WireMessage[] }> }>("/api/bots")).bots.find((candidate) => candidate.id === bot.id)?.messages ?? []);
  try {
    const config = await api("/api/config", "PATCH", { features: { skillReview: true, skillReviewSteps: 3 } });
    expect(config.features).toMatchObject({ skillAuthoring: true, skillReview: true, skillReviewSteps: 3 });
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Reporter" }, 201);

    await turn(bot, "Write the weekly report from the notes.");
    const counters = JSON.parse(readFileSync(join(fixture.info.dataDir, "skill-review.json"), "utf8")).counters;
    expect(counters).toEqual([expect.objectContaining({ botId: bot.id, threadId: bot.threadId, steps: 2 })]);
    expect((await messages(bot)).some((message) => message.card?.skillRequest)).toBe(false);

    await turn(bot, "Shorter please, five bullets at most.");
    await expect.poll(async () => (await messages(bot)).find((message) => message.card?.skillRequest)?.card, { timeout: 20_000 })
      .toMatchObject({ answered: "allow", autoApplied: true, title: 'Skill "weekly-report" enabled' });
    expect((await api<{ text: string }>(`/api/bots/${bot.id}/skills/weekly-report`)).text).toContain("Keep it to five bullets.");

    const review = JSON.parse(readFileSync(join(scratch, "one-shot.json"), "utf8")) as { prompt: string };
    expect(review.prompt).toContain("Shorter please, five bullets at most.");
    expect(review.prompt).toContain("[tool] Read");
    const texts = (await messages(bot)).filter((message) => message.kind === "text").map((message) => message.text ?? "");
    expect(texts.some((text) => text.includes(SKILL_REVIEW_MARKER) || text.includes("one lesson"))).toBe(false);
    await expect.poll(() => JSON.parse(readFileSync(join(fixture.info.dataDir, "skill-review.json"), "utf8")).counters[0].steps).toBe(0);
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 90_000);

// On Codex, OMB's default engine, the review is Codex's own tool-free `codex exec` call.
it("reviews a Codex bot's conversation through Codex's own background call", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-skill-review-codex-"));
  const routes = join(scratch, "routes.json");
  const textLog = join(scratch, "codex-exec.jsonl");
  writeFileSync(routes, JSON.stringify({
    [SKILL_REVIEW_MARKER]: JSON.stringify({ changes: [{ action: "create", skill_md: SKILL_MD, gist: "Five-bullet weekly report." }], note: "one lesson" }),
  }));
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CODEX_TEXT_ROUTES: routes, FAKE_CODEX_TEXT_LOG: textLog },
    undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const { url } = fixture.info;
  const api = async <T = any>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status, `${method} ${path}`).toBe(status);
    return response.json() as Promise<T>;
  };
  const turn = async (bot: WireBot, text: string) => {
    await runControlOmb(["send", "--bot", bot.id, "--task", bot.threadId, "--text", text, "--url", url]);
    expect(await runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });
  };
  const messages = async (bot: WireBot) =>
    ((await api<{ bots: Array<WireBot & { messages: WireMessage[] }> }>("/api/bots")).bots.find((candidate) => candidate.id === bot.id)?.messages ?? []);
  try {
    await api("/api/config", "PATCH", { features: { skillReview: true, skillReviewSteps: 3 } });
    const { instances } = await api<{ instances: Array<{ instanceId: string; models: { default: string } }> }>("/api/instances");
    const model = instances.find((instance) => instance.instanceId === "codex")!.models.default;
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Reporter", modelSelection: { instanceId: "codex", model } }, 201);

    // Each fake Codex turn runs a command and a web search: two tool steps.
    await turn(bot, "Write the weekly report from the notes.");
    await turn(bot, "Shorter please, five bullets at most.");
    await expect.poll(async () => (await messages(bot)).find((message) => message.card?.skillRequest)?.card, { timeout: 20_000 })
      .toMatchObject({ answered: "allow", autoApplied: true, title: 'Skill "weekly-report" enabled' });
    expect((await api<{ text: string }>(`/api/bots/${bot.id}/skills/weekly-report`)).text).toContain("Keep it to five bullets.");
    // SAFETY: the fake CLI appends exactly this shape, one object per line
    const review = readFileSync(textLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as { argv: string[]; prompt: string })
      .find((call) => call.prompt.includes(SKILL_REVIEW_MARKER));
    expect(review?.prompt).toContain("Shorter please, five bullets at most.");
    expect(review?.argv).toEqual(expect.arrayContaining(["exec", "--ignore-user-config"]));
    await expect.poll(() => JSON.parse(readFileSync(join(fixture.info.dataDir, "skill-review.json"), "utf8")).counters[0]?.steps ?? 0).toBe(0);
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 90_000);
