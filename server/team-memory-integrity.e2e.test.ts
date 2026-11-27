import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { launchVerificationServer, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";
import { CAPTURE_MARKER } from "./memory-capture.ts";
import type { TeamMemoryEntry } from "./team-memory.ts";

it("preserves team identity, rejects stale writes and searches omitted shared notes", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-memory-integrity-"));
  const routes = join(scratch, "routes.json");
  writeFileSync(routes, JSON.stringify({ [CAPTURE_MARKER]: JSON.stringify([{ kind: "decision", text: "Use amber for the fixture", teamName: "Fixture treatment", key: "fixture/treatment", sourceTurn: 0, sourceQuote: "Use amber for the fixture", confidence: 0.9 }]) }));
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TEXT_ROUTES: routes });
  let child: ChildProcess | undefined;
  const capabilityKey = "memory-integrity-fixture";
  const api = async (path: string, method = "GET", body?: unknown, token?: string, status = 200): Promise<any> => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
    const value = await response.json();
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  try {
    await waitForExit(fixture.child, { signal: "SIGTERM" });
    const log = openSync(fixture.info.logPath, "a", 0o600);
    child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", log, log],
      env: { ...verificationServerEnvironment({ FAKE_CLAUDE_TEXT_ROUTES: routes }, fixture.info.dataDir, Number(new URL(fixture.info.url).port)), OMB_TEST_INTERNAL_CAPABILITY_KEY: capabilityKey },
    });
    closeSync(log);
    await expect.poll(async () => { try { return (await fetch(fixture.info.url + "/api/health")).ok; } catch { return false; } }, { timeout: 30_000 }).toBe(true);
    const folder = join(fixture.info.dataDir, "editing-project");
    mkdirSync(folder);
    writeFileSync(join(folder, "project.aep"), "revision one");
    writeFileSync(join(folder, "preview.png"), "synthetic preview");
    const { bot } = await api("/api/bots", "POST", { name: "Memory editor", section: "Editing", cwd: folder }, undefined, 201);
    await api(`/api/bots/${bot.id}`, "PATCH", { cwd: folder });
    const added = await api("/api/team-memory?section=Editing", "POST", { kind: "decision", name: "Colour", detail: "Blue", key: "project/colour" }, undefined, 201);
    const old: TeamMemoryEntry = added.entries[0];
    await api(`/api/team-memory/${old.id}?section=Editing`, "PATCH", { detail: "stale" }, undefined, 428);
    await api(`/api/team-memory/${old.id}?section=Editing`, "PATCH", { detail: "Green", expectedRevision: old.revision });
    await api(`/api/team-memory/${old.id}?section=Editing`, "PATCH", { detail: "Blue", expectedRevision: old.revision }, undefined, 409);
    await api(`/api/team-memory/${old.id}?section=Editing&revision=${old.revision}`, "DELETE", undefined, undefined, 409);
    await api("/api/sidebar-sections?section=Editing", "PATCH", { name: "Postproduction" });
    expect((await api("/api/team-memory?section=Postproduction")).entries[0].detail).toBe("Green");
    await api("/api/sidebar-sections", "POST", { name: "Editing" });
    expect((await api("/api/team-memory?section=Editing")).entries).toEqual([]);
    const minted = await fetch(fixture.info.url + "/api/testing/internal-capability", { method: "POST",
      headers: { "content-type": "application/json", "x-openmausbot-test-capability": capabilityKey }, body: JSON.stringify({ botId: bot.id, threadId: bot.threadId, kind: "agents" }) });
    expect(minted.status).toBe(201);
    const { token } = await minted.json() as { token: string };
    for (let i = 0; i < 16; i++) await api("/api/team-memory?section=Postproduction", "POST", { kind: "term", name: `Note ${i}`, detail: "Background notes. ".repeat(30) }, undefined, 201);
    const page = await api("/api/team-memory?section=Postproduction");
    const omitted = page.entries.find((entry: TeamMemoryEntry) => !page.loadedIds.includes(entry.id));
    expect(omitted).toBeDefined();
    const search = await api(`/api/internal/session-search?fromBotId=${bot.id}&fromThreadId=${bot.threadId}&scope=team&q=${encodeURIComponent(omitted.name)}`, "GET", undefined, token);
    expect(search.teamHits.some((entry: TeamMemoryEntry) => entry.id === omitted.id)).toBe(true);
  } finally {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
