// The memory layer end to end, against an isolated fixture server and the
// fake engine, named after the memory rubric it covers: single-fact recall,
// recall across sessions, temporal forgetting, update and contradiction,
// explicit personalisation, and the identity regressions. The model steps
// are scripted with FAKE_CLAUDE_TEXT_ROUTES, so this proves the plumbing,
// not a model's judgement.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireBot } from "../shared/wire.ts";
import { CAPTURE_MARKER } from "./memory-capture.ts";
import { TIDY_MARKER } from "./memory-tidy.ts";

it("recalls, captures, suggests, forgets and tidies a bot's memory", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-memory-layer-"));
  const routes = join(scratch, "routes.json");
  const prompts = join(scratch, "prompts.jsonl");
  const future = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  writeFileSync(routes, JSON.stringify({
    [CAPTURE_MARKER]: JSON.stringify([
      { text: "The person is vegetarian", kind: "preference", aboutUser: true, confidence: 0.9 },
      { text: "The person has exams this weekend", kind: "fact", until: future, aboutUser: true, confidence: 0.9 },
      { text: "The account balance is -10", kind: "fact", confidence: 0.9 },
      { text: "The person loves Irani cafes", kind: "preference", topic: "food", topicAliases: ["restaurants", "cafes"], confidence: 0.9 },
    ]),
    [TIDY_MARKER]: '{"pairs": []}',
  }));
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TEXT_ROUTES: routes, FAKE_CLAUDE_PROMPTS: prompts });
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
  const api = async <T = any>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status, `${method} ${path}`).toBe(status);
    return response.json() as Promise<T>;
  };
  const turn = async (botId: string, threadId: string, text: string) => {
    await control("send", "--bot", botId, "--task", threadId, "--text", text);
    expect(await control("wait", "--bot", botId, "--task", threadId, "--timeout", "30")).toMatchObject({ status: "settled" });
  };
  const sentSince = (count: number) => readFileSync(prompts, "utf8").trim().split("\n").slice(count).join("\n");
  const sentCount = () => { try { return readFileSync(prompts, "utf8").trim().split("\n").filter(Boolean).length; } catch { return 0; } };
  const memoryFile = async (botId: string, path = "MEMORY.md") => (await api<{ text: string; hash: string }>(`/api/bots/${botId}/memory/file?path=${encodeURIComponent(path)}`));
  try {
    const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Memo" }, 201);
    await api("/api/config", "PUT", { memory: { captureQuietMs: 1_000 } });
    // upkeep is on for a new bot; switched off here so the read side is tested alone
    expect(await api(`/api/bots/${bot.id}/memory/upkeep`)).toMatchObject({ enabled: true });
    await api(`/api/bots/${bot.id}`, "PATCH", { memoryUpkeep: false });

    // A successful routine is automation, not the owner's personal words.
    const { bot: scheduled } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Scheduled memory" }, 201);
    const { routine } = await api("/api/routines", "POST", {
      name: "Automated report", prompt: "Report the work status.", botId: scheduled.id, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 },
    }, 201);
    const { run } = await api(`/api/routines/${routine.id}/run`, "POST", undefined, 201);
    await expect.poll(async () => (await api("/api/routines")).runs.find((entry: any) => entry.id === run.id)?.status,
      { timeout: 20_000 }).toBe("completed");
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect((await memoryFile(scheduled.id)).text).not.toContain("The person is vegetarian");
    expect((await api("/api/profile/learned")).learned).toEqual([]);

    // ── read side, on by default ─────────────────────────────────────────
    // single-fact recall by an alias: a topic note found by a word it never says
    await api(`/api/bots/${bot.id}/memory/file`, "PUT", { path: "memory/dining.md", text: "---\ntitle: Dining\naliases: [food, restaurants, lunch]\n---\n- Loves pasta, hates olives\n" });
    const preview = JSON.stringify(await api(`/api/bots/${bot.id}/system-prompt`));
    expect(preview).toContain("memory/dining.md — Dining (also: food, restaurants, lunch)");
    let before = sentCount();
    await turn(bot.id, bot.threadId, "Can you suggest some restaurants for Friday?");
    expect(sentSince(before)).toContain("Recalled for this message");
    expect(sentSince(before)).toContain("Loves pasta, hates olives");

    // recall across sessions: a codename said in one chat is recalled in a new one
    await turn(bot.id, bot.threadId, "Note for later: the project codename is Bluebird.");
    const created = await api<any>(`/api/bots/${bot.id}/tasks`, "POST", { title: "New chat" }, 201);
    const second: string = created.task?.threadId ?? created.threadId;
    before = sentCount();
    await turn(bot.id, second, "What was the project codename again?");
    expect(sentSince(before)).toContain("Bluebird");
    expect(sentSince(before)).toMatch(/your main chat|chat \\"[^"\\]+\\"/);

    await api(`/api/bots/${bot.id}`, "PATCH", { memoryEnabled: false });
    before = sentCount();
    await turn(bot.id, second, "Can you suggest some restaurants for Friday?");
    expect(sentSince(before)).not.toContain("Recalled for this message");
    expect(JSON.stringify(await api(`/api/bots/${bot.id}/system-prompt`))).not.toContain("memory/dining.md");
    await api(`/api/bots/${bot.id}`, "PATCH", { memoryEnabled: true });

    // temporal: an entry past its until day no longer loads
    const index = await memoryFile(bot.id);
    await api(`/api/bots/${bot.id}/memory/file`, "PUT", {
      path: "MEMORY.md",
      text: `${index.text}\n- 2026-01-01 · Dentist appointment on Monday · until 2026-01-05\n- 2026-01-01 · Prefers short replies\n`,
      expectedHash: index.hash,
    });
    const withExpired = JSON.stringify(await api(`/api/bots/${bot.id}/system-prompt`));
    expect(withExpired).not.toContain("Dentist appointment on Monday");
    expect(withExpired).toContain("Prefers short replies");

    // ── write side, on by default; off above ─────────────────────────────
    await api(`/api/bots/${bot.id}/memory/tidy`, "POST", undefined, 409);
    await turn(bot.id, bot.threadId, "Just so you know, I'm vegetarian and I have exams this weekend.");
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect((await memoryFile(bot.id)).text).not.toContain("The person is vegetarian");

    await api("/api/config", "PUT", { memory: { captureQuietMs: 5_000 } });
    await api(`/api/bots/${bot.id}`, "PATCH", { memoryUpkeep: true });
    await turn(bot.id, bot.threadId, "Just so you know, I'm vegetarian and I have exams this weekend.");
    // A later invalid field rejects the entire patch: queued capture must
    // survive, since memory upkeep was never actually switched off.
    expect((await memoryFile(bot.id)).text).not.toContain("The person is vegetarian");
    await api(`/api/bots/${bot.id}`, "PATCH", { memoryUpkeep: false, browser: "invalid" }, 400);
    expect(await api(`/api/bots/${bot.id}/memory/upkeep`)).toMatchObject({ enabled: true });
    await expect.poll(async () => (await memoryFile(bot.id)).text, { timeout: 20_000 }).toContain("The person is vegetarian");
    await api("/api/config", "PUT", { memory: { captureQuietMs: 1_000 } });
    const captured = (await memoryFile(bot.id)).text;
    expect(captured).toMatch(/- \d{4}-\d{2}-\d{2} · from chat "[^"]*" \(noticed\) · The person is vegetarian/);
    expect(captured).toContain(`The person has exams this weekend · until ${future}`);
    expect(captured).toContain("The account balance is -10");
    // detail is filed into a topic the bot creates, found later by its other words
    const food = (await memoryFile(bot.id, "memory/food.md")).text;
    expect(food).toContain("title: food");
    expect(food).toContain("aliases: [restaurants, cafes]");
    expect(food).toContain("The person loves Irani cafes");
    expect(captured).not.toContain("Irani cafes");
    const journal = await api<{ entries: Array<{ actor: string; via: string }> }>(`/api/bots/${bot.id}/memory/journal`);
    expect(journal.entries.some((row) => row.actor === "upkeep" && row.via === "capture")).toBe(true);

    // identity: a later capture of "-10" again adds nothing; "10" is a different fact
    writeFileSync(routes, JSON.stringify({
      [CAPTURE_MARKER]: JSON.stringify([
        { text: "The account balance is -10", kind: "fact" },
        { text: "The account balance is 10", kind: "fact" },
      ]),
      [TIDY_MARKER]: '{"pairs": []}',
    }));
    await turn(bot.id, bot.threadId, "The balance changed today.");
    await expect.poll(async () => (await memoryFile(bot.id)).text, { timeout: 20_000 }).toContain("The account balance is 10\n");
    expect((await memoryFile(bot.id)).text.match(/The account balance is -10/g)).toHaveLength(1);

    // explicit personalisation: a durable fact about the person reaches About
    // me on its own, is listed with Remove, and a removed one never returns
    const { learned } = await api<{ learned: Array<{ id: string; text: string; botName: string }> }>("/api/profile/learned");
    expect(learned.map((f) => f.text)).toEqual(["The person is vegetarian"]);
    expect((await api("/api/config")).profile.aboutMe).toMatch(/- \d{4}-\d{2}-\d{2} · learned by Memo · The person is vegetarian/);
    expect(JSON.stringify(await api(`/api/bots/${bot.id}/system-prompt`))).toContain("learned by Memo · The person is vegetarian");
    const removed = await api<{ aboutMe: string }>(`/api/profile/learned/${learned[0]!.id}/remove`, "POST");
    expect(removed.aboutMe).not.toContain("vegetarian");
    await api(`/api/profile/learned/${learned[0]!.id}/remove`, "POST", undefined, 404);

    // forgetting and contradiction: the tidy-up archives the expired entry
    // and strikes the older balance, leaving both in the record
    const current = (await memoryFile(bot.id)).text.split("\n").filter((line) => /^- \d{4}/.test(line));
    const minus = current.findIndex((line) => line.includes("balance is -10"));
    const plus = current.findIndex((line) => line.includes("balance is 10"));
    expect(current.length).toBeGreaterThanOrEqual(5);
    // the candidate list skips the expired dentist line
    const live = current.filter((line) => !line.includes("Dentist"));
    writeFileSync(routes, JSON.stringify({ [TIDY_MARKER]: JSON.stringify({ pairs: [{ a: live.indexOf(current[minus]!), b: live.indexOf(current[plus]!), keep: "b" }] }) }));
    const { report } = await api<{ report: { expired: number; superseded: number; contradictionsChecked: boolean } }>(`/api/bots/${bot.id}/memory/tidy`, "POST");
    expect(report).toMatchObject({ expired: 1, superseded: 1, contradictionsChecked: true });
    const tidied = (await memoryFile(bot.id)).text;
    expect(tidied).toMatch(/~~The account balance is -10~~ · superseded \d{4}-\d{2}-\d{2}/);
    expect(tidied).not.toContain("Dentist appointment");
    expect((await memoryFile(bot.id, "memory/archive.md")).text).toContain("Dentist appointment on Monday · until 2026-01-05 · expired");
    const status = await api(`/api/bots/${bot.id}/memory/upkeep`);
    expect(status).toMatchObject({ enabled: true, modelSteps: true, lastTidy: { expired: 1, superseded: 1 } });

    // every upkeep change can be undone from the journal
    const rows = await api<{ entries: Array<{ id: string; actor: string; via: string; path: string }> }>(`/api/bots/${bot.id}/memory/journal`);
    const tidyRow = rows.entries.find((row) => row.actor === "upkeep" && row.via === "tidy" && row.path === "MEMORY.md")!;
    await api(`/api/bots/${bot.id}/memory/journal/${tidyRow.id}/revert`, "POST");
    expect((await memoryFile(bot.id)).text).toContain("Dentist appointment on Monday");
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 180_000);
