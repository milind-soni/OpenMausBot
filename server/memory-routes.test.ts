// The memory routes through a real, isolated harness server: containment
// at the HTTP boundary, the 409 that keeps a settings save from erasing
// what the bot just wrote, the journal, revert, and the turn-boundary diff
// that catches a bot writing memory with nothing but a file tool.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { launchVerificationServer, type VerificationServer } from "../scripts/control-omb.ts";
import { hashMemoryText } from "./memory-store.ts";

interface Reply {
  status: number;
  // SAFETY: test-only view of JSON bodies; every field read below is asserted first
  body: any;
}

describe("memory routes through an isolated HTTP fixture", () => {
  let fixture: VerificationServer;
  let botId = "";
  let threadId = "";
  const api = async (method: string, path: string, body?: unknown): Promise<Reply> => {
    const response = await fetch(`${fixture.info.url}${path}`, {
      method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  };
  const workspace = () => join(fixture.info.dataDir, "workspaces", botId);

  beforeAll(async () => {
    fixture = await launchVerificationServer();
    // A CLI stand-in that behaves like a bot writing memory with a file
    // tool: on a real turn (stream-json) it drops a topic file into the
    // workspace named by memory-target.txt, then hands over to the fake.
    const target = join(fixture.info.dataDir, "memory-target.txt");
    const wrapper = join(fixture.info.dataDir, "memory-fixture.mjs");
    writeFileSync(wrapper, [
      "#!/usr/bin/env node",
      'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
      'import { dirname } from "node:path";',
      `if (process.argv.includes("stream-json")) {`,
      `  try {`,
      `    const target = readFileSync(${JSON.stringify(target)}, "utf8").trim();`,
      `    mkdirSync(dirname(target), { recursive: true });`,
      `    writeFileSync(target, "- the user prefers short replies\\n");`,
      `  } catch {}`,
      `}`,
      `await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "server/testing/fake-claude-cli.ts")).href)});`,
    ].join("\n"), { mode: 0o700 });
    expect((await api("PATCH", "/api/instances/claude", { cli: wrapper })).status).toBe(200);
    const catalog = (await api("GET", "/api/instances")).body.instances.find((instance: { instanceId: string }) => instance.instanceId === "claude");
    const model = catalog.models.options[0].id;
    const created = await api("POST", "/api/bots", { name: "Scout", modelSelection: { instanceId: "claude", model } });
    expect(created.status).toBe(201);
    botId = created.body.bot.id;
    threadId = created.body.bot.threadId;
    writeFileSync(target, join(workspace(), "memory", "learned.md"));
  });

  afterAll(async () => {
    await fixture?.close();
  });

  it("serves an overview with the budget, the folder, and the old whole-file fields", async () => {
    const overview = await api("GET", `/api/bots/${botId}/memory`);
    expect(overview.status).toBe(200);
    expect(overview.body.index).toMatchObject({ maxLines: 200, maxBytes: 24_000, truncated: false });
    expect(overview.body.workspacePath).toBe(workspace());
    expect(overview.body.topics).toEqual([]);
    expect(overview.body.logs).toEqual([]);
    expect(typeof overview.body.text).toBe("string");
    expect(overview.body.truncated).toBe(false);
    expect((await api("GET", "/api/bots/nope/memory")).status).toBe(404);
  });

  it("refuses an escaping path at the boundary without touching the disk", async () => {
    for (const path of ["../../etc/passwd", "/etc/passwd", "memory/../MEMORY.md", "memory/nested/x.md", "notes.txt"]) {
      expect((await api("GET", `/api/bots/${botId}/memory/file?path=${encodeURIComponent(path)}`)).status).toBe(400);
      expect((await api("PUT", `/api/bots/${botId}/memory/file`, { path, text: "pwned" })).status).toBe(400);
      expect((await api("DELETE", `/api/bots/${botId}/memory/file?path=${encodeURIComponent(path)}`)).status).toBe(400);
    }
    expect(existsSync(join(fixture.info.dataDir, "workspaces", "etc"))).toBe(false);
  });

  it("writes a topic with the hash of empty, then refuses a stale save with 409 and what is there now", async () => {
    const created = await api("PUT", `/api/bots/${botId}/memory/file`, {
      path: "memory/clients.md",
      text: "# Clients\n",
      expectedHash: hashMemoryText(""),
    });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ ok: true, path: "memory/clients.md", text: "# Clients\n", hash: hashMemoryText("# Clients\n") });
    expect(created.body.entry).toMatchObject({ kind: "created", actor: "person", via: "ui" });
    expect(created.body.entry.before).toBeUndefined();
    expect(created.body.overview.topics.map((t: { path: string }) => t.path)).toEqual(["memory/clients.md"]);

    // the bot writes in between, with a file tool
    writeFileSync(join(workspace(), "memory", "clients.md"), "# Clients\n- Acme (bot)\n");
    const stale = await api("PUT", `/api/bots/${botId}/memory/file`, {
      path: "memory/clients.md",
      text: "# Clients\n- mine\n",
      expectedHash: created.body.hash,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("conflict");
    expect(stale.body.current).toBe("# Clients\n- Acme (bot)\n");
    expect(stale.body.currentHash).toBe(hashMemoryText("# Clients\n- Acme (bot)\n"));
    expect(readFileSync(join(workspace(), "memory", "clients.md"), "utf8")).toBe("# Clients\n- Acme (bot)\n");

    const merged = await api("PUT", `/api/bots/${botId}/memory/file`, {
      path: "memory/clients.md",
      text: "# Clients\n- Acme (bot)\n- mine\n",
      expectedHash: stale.body.currentHash,
    });
    expect(merged.status).toBe(200);
    const read = await api("GET", `/api/bots/${botId}/memory/file?path=memory%2Fclients.md`);
    expect(read.body).toEqual({ path: "memory/clients.md", text: "# Clients\n- Acme (bot)\n- mine\n", hash: merged.body.hash, exists: true });
  });

  it("refuses an oversized save with 413", async () => {
    const big = await api("PUT", `/api/bots/${botId}/memory/file`, { path: "memory/big.md", text: "x".repeat(256 * 1024 + 1) });
    expect(big.status).toBe(413);
  });

  it("deletes a topic or log but never MEMORY.md", async () => {
    await api("PUT", `/api/bots/${botId}/memory/file`, { path: "memory/log/2026-09-10.md", text: "- logged\n" });
    expect((await api("GET", `/api/bots/${botId}/memory`)).body.logs.map((l: { path: string }) => l.path)).toEqual(["memory/log/2026-09-10.md"]);
    const gone = await api("DELETE", `/api/bots/${botId}/memory/file?path=memory%2Flog%2F2026-09-10.md`);
    expect(gone.status).toBe(200);
    expect(gone.body.entry).toMatchObject({ kind: "deleted", actor: "person" });
    expect(gone.body.overview.logs).toEqual([]);
    const index = await api("DELETE", `/api/bots/${botId}/memory/file?path=MEMORY.md`);
    expect(index.status).toBe(400);
    expect(index.body.error).toMatch(/cannot be deleted/);
    expect(existsSync(join(workspace(), "MEMORY.md"))).toBe(true);
  });

  it("keeps the old whole-file PUT working, journaled as the person's", async () => {
    const legacy = await api("PUT", `/api/bots/${botId}/memory`, { text: "- legacy note\n" });
    expect(legacy.status).toBe(200);
    expect(legacy.body).toMatchObject({ ok: true, truncated: false, hash: hashMemoryText("- legacy note\n") });
    expect(readFileSync(join(workspace(), "MEMORY.md"), "utf8")).toBe("- legacy note\n");
    const journal = await api("GET", `/api/bots/${botId}/memory/journal?limit=1`);
    expect(journal.body.entries[0]).toMatchObject({ path: "MEMORY.md", actor: "person", via: "api", kind: "edited" });
    expect((await api("PUT", `/api/bots/${botId}/memory`, { text: 42 })).status).toBe(400);
  });

  it("lists the journal newest first without the prior text, and reverts one click", async () => {
    const journal = await api("GET", `/api/bots/${botId}/memory/journal`);
    expect(journal.status).toBe(200);
    const entries: Array<{ id: string; at: number; path: string; kind: string; before?: string; diff: string }> = journal.body.entries;
    expect(entries.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < entries.length; i++) expect(entries[i - 1].at).toBeGreaterThanOrEqual(entries[i].at);
    expect(entries.every((entry) => entry.before === undefined)).toBe(true);
    expect(entries.every((entry) => typeof entry.diff === "string")).toBe(true);

    const clientsEdit = entries.find((entry) => entry.path === "memory/clients.md" && entry.kind === "edited");
    expect(clientsEdit).toBeDefined();
    const reverted = await api("POST", `/api/bots/${botId}/memory/journal/${clientsEdit?.id}/revert`);
    expect(reverted.status).toBe(200);
    expect(reverted.body.text).toBe("# Clients\n- Acme (bot)\n");
    expect(reverted.body.entry).toMatchObject({ via: "revert", actor: "person", path: "memory/clients.md" });
    expect(readFileSync(join(workspace(), "memory", "clients.md"), "utf8")).toBe("# Clients\n- Acme (bot)\n");
    expect((await api("POST", `/api/bots/${botId}/memory/journal/nope/revert`)).status).toBe(404);
  });

  it("validates the open target and never runs anything for a bad one", async () => {
    expect((await api("POST", `/api/bots/${botId}/memory/open`, { target: "terminal" })).status).toBe(400);
    expect((await api("POST", `/api/bots/${botId}/memory/open`, {})).status).toBe(400);
  });

  it("journals what a turn wrote with a file tool as the bot's, tied to the chat", async () => {
    mkdirSync(join(workspace(), "memory"), { recursive: true });
    expect((await api("POST", `/api/bots/${botId}/messages`, { threadId, text: "remember that I like short replies" })).status).toBe(202);
    await expect.poll(async () => {
      const bots = (await api("GET", "/api/bots?messages=1")).body.bots;
      return bots.find((bot: { id: string }) => bot.id === botId)?.busy;
    }, { timeout: 15_000 }).toBe(false);
    expect(readFileSync(join(workspace(), "memory", "learned.md"), "utf8")).toContain("short replies");
    await expect.poll(async () => {
      const { entries } = (await api("GET", `/api/bots/${botId}/memory/journal`)).body;
      return entries.find((entry: { path: string }) => entry.path === "memory/learned.md");
    }, { timeout: 5_000 }).toMatchObject({ kind: "created", actor: "bot", via: "turn", threadId, added: 1 });
    const overview = await api("GET", `/api/bots/${botId}/memory`);
    expect(overview.body.topics.map((t: { path: string }) => t.path)).toContain("memory/learned.md");
  });
});
