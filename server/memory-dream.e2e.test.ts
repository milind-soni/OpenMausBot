// Against the real server: which chats a dream reads is assembled in server/index.ts.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireBot } from "../shared/wire.ts";
import { DREAM_MARKER } from "./memory-dream.ts";

it("dreams over a bot's chats on request: the insight lands in memory, journaled, and the report says so", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-dream-"));
  const routes = join(scratch, "routes.json");
  const textLog = join(scratch, "text-prompts.jsonl");
  writeFileSync(routes, JSON.stringify({
    [DREAM_MARKER]: JSON.stringify({ learned: [{ text: "The person wants drafts under 100 words", from: [1, 2], confidence: 0.9 }], outdated: [], ideas: [] }),
  }));
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TEXT_ROUTES: routes, FAKE_CLAUDE_TEXT_LOG: textLog });
  const url = fixture.info.url;
  const api = async <T = any>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as T;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  const dreamPrompt = () => readFileSync(textLog, "utf8").split("\n").filter(Boolean)
    // SAFETY: the fake CLI appends exactly this shape, one object per line
    .map((line) => (JSON.parse(line) as { prompt?: string }).prompt ?? "")
    .find((prompt) => prompt.includes(DREAM_MARKER)) ?? "";
  try {
    // Capture waits long enough never to run here, so every note below came from the dream.
    await api("/api/config", "PUT", { memory: { captureQuietMs: 600_000 } });
    const { bot } = await api<{ bot: WireBot & { threadId: string } }>("/api/bots", "POST", { name: "Scout" });
    const { task } = await api<{ task: { threadId: string } }>(`/api/bots/${bot.id}/tasks`, "POST", {});
    for (const [thread, text] of [[bot.threadId, "Draft the launch note, and keep it short."], [task.threadId, "Too long again, cut it to 100 words."]] as const) {
      await runControlOmb(["send", "--bot", bot.id, "--task", thread, "--text", text, "--url", url]);
      expect(await runControlOmb(["wait", "--bot", bot.id, "--task", thread, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });
    }

    expect(await api(`/api/bots/${bot.id}/memory/upkeep`)).toMatchObject({ dreams: false });
    expect(await api(`/api/bots/${bot.id}/memory/dream`, "PATCH", { nightly: true })).toMatchObject({ dreams: true });
    const { report } = await api<{ report: { conversations: number; learned: { text: string; where: string }[] } }>(`/api/bots/${bot.id}/memory/dream`, "POST");
    expect(report).toMatchObject({ conversations: 2, learned: [{ text: "The person wants drafts under 100 words", where: "MEMORY.md" }] });

    const prompt = dreamPrompt();
    expect(prompt).toContain("Person: Too long again, cut it to 100 words.");
    expect(prompt).toContain("Person: Draft the launch note, and keep it short.");
    expect((await api<{ text: string }>(`/api/bots/${bot.id}/memory/file?path=MEMORY.md`)).text)
      .toMatch(/- \d{4}-\d{2}-\d{2} · from dream across 2 chats · The person wants drafts under 100 words/);
    const { entries } = await api<{ entries: { actor: string; via: string; path: string }[] }>(`/api/bots/${bot.id}/memory/journal`);
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ actor: "upkeep", via: "dream", path: "MEMORY.md" })]));
    expect(await api(`/api/bots/${bot.id}/memory/upkeep`)).toMatchObject({ dreams: true, lastDream: { conversations: 2 } });
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
