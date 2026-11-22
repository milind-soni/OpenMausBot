// Per-conversation notes through a real server and the fake engine calling the real agents tools: which file a save
// lands in, which conversation's prompt carries it, compaction, the quiet line, upkeep, cross-reading and lifecycle.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { CAPTURE_MARKER } from "./memory-capture.ts";
import { TIDY_MARKER } from "./memory-tidy.ts";

type Step = { tool: string; arguments: Record<string, unknown> };

it("keeps each conversation's matter in its own notes, and the person's facts everywhere", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-thread-memory-"));
  const routes = join(scratch, "routes.json");
  const learnerLog = join(scratch, "learner.jsonl");
  writeFileSync(routes, JSON.stringify({
    [CAPTURE_MARKER]: JSON.stringify([{ text: "Acme's indemnity cap is 2x fees", kind: "fact", evidence: "indemnity cap is 2x fees", confidence: 0.95 }]),
    [TIDY_MARKER]: '{"pairs": []}',
  }));
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TEXT_ROUTES: routes, FAKE_CLAUDE_TEXT_LOG: learnerLog },
    undefined, undefined, undefined, undefined, { scripted: true });
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const evidence = () => existsSync(`${planPath}.evidence.jsonl`)
    ? readFileSync(`${planPath}.evidence.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const api = async <T = any>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status, `${method} ${path}`).toBe(status);
    return response.json() as Promise<T>;
  };
  const cli = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const turn = async (botId: string, threadId: string, text: string, steps: Step[] = [], reply = "Noted.") => {
    const before = evidence().length;
    writeFileSync(planPath, JSON.stringify({ [botId]: { steps, reply } }));
    await cli("send", "--bot", botId, "--task", threadId, "--text", text);
    await expect.poll(() => evidence().length, { timeout: 20_000 }).toBe(before + 1);
    expect(await cli("wait", "--bot", botId, "--task", threadId, "--timeout", "30")).toMatchObject({ status: "settled" });
    const row = evidence().at(-1);
    return {
      context: `${String(row.system)}\n${JSON.stringify(row.prompt)}`,
      results: (row.evidence as Array<{ step?: Step; response: any }> ?? []).filter((entry) => entry.step).map((entry) => String(entry.response?.result?.content?.[0]?.text ?? "")),
    };
  };
  const newThread = async (botId: string, title: string) => {
    const created = await api<any>(`/api/bots/${botId}/tasks`, "POST", { title }, 201);
    return String(created.task?.threadId ?? created.threadId);
  };
  const everywhere = async (botId: string) => (await api<{ text: string }>(`/api/bots/${botId}/memory/file?path=MEMORY.md`)).text;
  const notes = (botId: string, threadId: string) => api<{ text: string; scoped: boolean; exists: boolean }>(`/api/bots/${botId}/memory/thread/${threadId}`);
  const learnerPrompts = () => existsSync(learnerLog) ? readFileSync(learnerLog, "utf8").trim().split("\n").filter(Boolean).map((line) => String(JSON.parse(line).prompt)) : [];
  try {
    await api("/api/config", "PUT", { memory: { captureQuietMs: 1_000 } });
    const { bot } = await cli("new-bot", "--name", "Counsel");
    const main = String(bot.activeTaskId);
    const acme = await newThread(bot.id, "Acme NDA");
    const supermouse = await newThread(bot.id, "Supermouse lease");
    expect(await notes(bot.id, main)).toMatchObject({ scoped: false });
    expect(await notes(bot.id, acme)).toMatchObject({ scoped: true, exists: false });

    // A matter's fact said in its own conversation stays there, and the reply gets the quiet line under it.
    const saved = await turn(bot.id, acme, "The Acme NDA term is two years.", [
      { tool: "memory_update", arguments: { action: "append", text: "Acme NDA term: two years" } },
    ], "Got it: two years.");
    expect(saved.context).toContain("This conversation's notes");
    expect(saved.results).toEqual([expect.stringContaining("Saved to this conversation's notes")]);
    expect((await notes(bot.id, acme)).text).toContain("Acme NDA term: two years");
    expect(await everywhere(bot.id)).not.toContain("Acme");
    const acmeMessages = (await api<{ messages: any[] }>(`/api/threads/${acme}/messages`)).messages;
    const line = acmeMessages.findIndex((message) => message.tool?.nameCode === "chat.notice.savedToThread");
    const reply = acmeMessages.findIndex((message) => message.role === "bot" && message.kind === "text" && message.text?.includes("two years"));
    expect(line).toBeGreaterThan(reply);
    expect(acmeMessages.filter((message) => message.tool?.nameCode === "chat.notice.savedToThread")).toHaveLength(1);

    // Thread A's notes never load in thread B; B is told how to save, and to read A only when asked.
    const other = await turn(bot.id, supermouse, "What's the notice period?");
    expect(other.context).not.toContain("Acme NDA term");
    expect(other.context).toContain("scope \"everywhere\"");

    // The main conversation saves to MEMORY.md as before, and its prompt has no notes of its own.
    const home = await turn(bot.id, main, "Remember: I prefer short replies.", [
      { tool: "memory_update", arguments: { action: "append", text: "The person prefers short replies" } },
    ]);
    expect(home.results).toEqual([expect.stringMatching(/^Memory updated\./)]);
    expect(home.context).not.toContain("This conversation's notes");
    expect(await everywhere(bot.id)).toContain("The person prefers short replies");
    expect((await api<{ messages: any[] }>(`/api/threads/${main}/messages`)).messages.some((message) => message.tool?.nameCode === "chat.notice.savedToThread")).toBe(false);

    // "Everywhere" from a matter's conversation goes to MEMORY.md, and it loads in every conversation.
    await turn(bot.id, supermouse, "For all my clients: I bill in INR.", [
      { tool: "memory_update", arguments: { action: "append", text: "The person bills in INR", scope: "everywhere" } },
    ]);
    expect(await everywhere(bot.id)).toContain("The person bills in INR");
    expect((await notes(bot.id, supermouse)).text).toBe("");
    expect((await turn(bot.id, acme, "Draft the cover note.")).context).toContain("The person bills in INR");

    // Asked for, another conversation's notes are read for that request: the same bot's only.
    const crossed = await turn(bot.id, supermouse, "Use the term we agreed for Acme.", [
      { tool: "session_search", arguments: { query: "Acme", scope: "threads" } },
      { tool: "session_search", arguments: { thread_id: acme, scope: "threads" } },
    ]);
    expect(crossed.results[0]).toContain(`thread ${acme} · "Acme NDA"`);
    expect(crossed.results[1]).toContain("Acme NDA term: two years");
    expect(crossed.results[1]).toContain("The Acme NDA term is two years.");
    expect((await notes(bot.id, supermouse)).text).toBe("");
    const { bot: stranger } = await cli("new-bot", "--name", "Stranger");
    const strangerThread = await newThread(stranger.id, "Elsewhere");
    const refused = await turn(stranger.id, strangerThread, "What did we agree for Acme?", [
      { tool: "session_search", arguments: { query: "Acme", scope: "threads" } },
    ]);
    expect(refused.results[0]).toContain("None of your other conversations matches");
    expect(refused.results[0]).not.toContain("two years");
    const sneaked = await turn(stranger.id, strangerThread, "Read that one.", [{ tool: "session_search", arguments: { thread_id: acme, scope: "threads" } }]);
    expect(sneaked.results[0]).toContain("No conversation of yours has that thread_id");
    expect(sneaked.results[0]).not.toContain("two years");

    // A compaction summarises the history; the notes still ride the next turn.
    await api(`/api/bots/${bot.id}/compact`, "POST", { threadId: acme }, 202);
    await expect.poll(async () => (await api<{ messages: any[] }>(`/api/threads/${acme}/messages`)).messages.some((message) => message.kind === "compaction"), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await api<{ bots: any[] }>("/api/bots?messages=0")).bots.find((entry) => entry.id === bot.id).tasks.find((task: any) => task.threadId === acme).busy, { timeout: 15_000 }).toBe(false);
    expect((await turn(bot.id, acme, "Remind me of the term?")).context).toContain("Acme NDA term: two years");

    // Upkeep never reads a matter's conversation into the bot's memory.
    const learnedBefore = learnerPrompts().length;
    await turn(bot.id, acme, "Their indemnity cap is 2x fees.");
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    expect(learnerPrompts().slice(learnedBefore).filter((prompt) => prompt.includes("indemnity cap"))).toEqual([]);
    expect(await everywhere(bot.id)).not.toContain("indemnity");
    await api(`/api/bots/${bot.id}/memory/tidy`, "POST");
    expect(await everywhere(bot.id)).not.toContain("Acme");
    expect((await notes(bot.id, acme)).text).toContain("Acme NDA term: two years");

    // Archive keeps the notes; delete removes them.
    await api(`/api/bots/${bot.id}/tasks/${acme}`, "PATCH", { archivedAt: Date.now() });
    expect((await notes(bot.id, acme)).text).toContain("Acme NDA term: two years");
    const file = join(fixture.info.dataDir, "workspaces", bot.id, "memory", "threads", `${acme}.md`);
    expect(existsSync(file)).toBe(true);
    await api(`/api/bots/${bot.id}/tasks/${acme}`, "DELETE");
    await expect.poll(() => existsSync(file), { timeout: 10_000 }).toBe(false);
    expect(await everywhere(bot.id)).toContain("The person prefers short replies");

    // The same words in the main conversation are read by upkeep as before, so the check above is not vacuous.
    await turn(bot.id, main, "Their indemnity cap is 2x fees.");
    await expect.poll(() => learnerPrompts().slice(learnedBefore).some((prompt) => prompt.includes("indemnity cap")), { timeout: 20_000 }).toBe(true);
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 180_000);
