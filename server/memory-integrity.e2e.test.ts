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

it("preserves team identity, rejects stale writes, searches shared notes and pins approval to saved evidence", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-memory-integrity-"));
  const routes = join(scratch, "routes.json");
  writeFileSync(routes, JSON.stringify({ [CAPTURE_MARKER]: JSON.stringify([{ kind: "decision", text: "Use amber for the fixture", teamName: "Fixture treatment", key: "fixture/treatment", sourceTurn: 0, sourceQuote: "Use amber for the fixture", confidence: 0.9 }]) }));
  const fake = { FAKE_CLAUDE_TEXT_ROUTES: routes, FAKE_CLAUDE_REPLIES: JSON.stringify(["Fixture check: missing font found"]) };
  const fixture = await launchVerificationServer({ ...process.env, ...fake });
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
      env: { ...verificationServerEnvironment(fake, fixture.info.dataDir, Number(new URL(fixture.info.url).port)), OMB_TEST_INTERNAL_CAPABILITY_KEY: capabilityKey },
    });
    closeSync(log);
    await expect.poll(async () => { try { return (await fetch(fixture.info.url + "/api/health")).ok; } catch { return false; } }, { timeout: 30_000 }).toBe(true);
    const folder = join(fixture.info.dataDir, "editing-project");
    mkdirSync(folder);
    writeFileSync(join(folder, "project.aep"), "revision one");
    writeFileSync(join(folder, "preview.png"), "synthetic preview");
    const { bot } = await api("/api/bots", "POST", { name: "Memory editor", section: "Editing", cwd: folder }, undefined, 201);
    await api(`/api/bots/${bot.id}`, "PATCH", { cwd: folder });
    const { bot: helper } = await api("/api/bots", "POST", { name: "Memory helper", section: "Editing" }, undefined, 201);
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
    const search = await api(`/api/internal/session-search?fromBotId=${bot.id}&fromThreadId=${bot.threadId}&scope=team&q=Green`, "GET", undefined, token);
    expect(search.teamHits[0].detail).toBe("Green");
    const proposal = await api("/api/internal/team-memory", "POST", { fromBotId: bot.id, fromThreadId: bot.threadId, kind: "outcome", name: "Title fix", detail: "Title adjusted",
      key: "project/title", evidence: { project: "project.aep", artifacts: ["preview.png"], stage: "checked", check: "Compared preview to brief" } }, token, 201);
    await api(`/api/threads/${bot.threadId}/respond`, "POST", { requestId: proposal.requestId, behavior: "allow" });
    let outcome = (await api("/api/team-memory?section=Postproduction")).entries.find((entry: TeamMemoryEntry) => entry.kind === "outcome");
    expect(outcome.evidenceStatus).toBe("agent-checked");
    const download = await fetch(fixture.info.url + `/api/team-memory/${outcome.id}/evidence?section=Postproduction&artifact=0`);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("synthetic preview");
    await api(`/api/team-memory/${outcome.id}?section=Postproduction`, "PATCH", { approveEvidence: true, expectedRevision: outcome.revision });
    outcome = (await api("/api/team-memory?section=Postproduction")).entries.find((entry: TeamMemoryEntry) => entry.id === outcome.id);
    expect(outcome.evidenceStatus).toBe("approved");
    expect(outcome.evidence.approval.by).toBe("local owner");
    writeFileSync(join(folder, "project.aep"), "revision two");
    expect((await api("/api/team-memory?section=Postproduction")).entries.find((entry: TeamMemoryEntry) => entry.id === outcome.id).evidenceStatus).toBe("stale");
    await api(`/api/team-memory/${outcome.id}?section=Postproduction`, "PATCH", { approveEvidence: true, expectedRevision: outcome.revision }, undefined, 409);
    await api("/api/config", "PUT", { memory: { captureQuietMs: 1_000 }, features: { roomMemoryCapture: true } });
    const { group } = await api("/api/groups", "POST", { name: "Editing decisions", section: "Postproduction", memberIds: [bot.id, helper.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } }, undefined, 201);
    await api(`/api/groups/${group.id}/messages`, "POST", { text: "Use amber for the fixture" }, undefined, 202);
    await expect.poll(async () => (await api("/api/team-memory?section=Postproduction")).entries.some((entry: TeamMemoryEntry) => entry.key === "fixture/treatment" && entry.status === "proposed"), { timeout: 30_000 }).toBe(true);
    const captured = (await api("/api/team-memory?section=Postproduction")).entries.find((entry: TeamMemoryEntry) => entry.key === "fixture/treatment");
    expect(captured.source.messageId).toBeTruthy();
    expect(captured.source.quote).toBe("Use amber for the fixture");
    expect(JSON.stringify(await api(`/api/bots/${helper.id}/system-prompt`))).not.toContain("Use amber for the fixture");
    await api(`/api/team-memory/${captured.id}?section=Postproduction`, "PATCH", { accept: true, expectedRevision: captured.revision });
    expect(JSON.stringify(await api(`/api/bots/${helper.id}/system-prompt`))).toContain("Use amber for the fixture");
    writeFileSync(routes, JSON.stringify({ [CAPTURE_MARKER]: JSON.stringify([{ kind: "lesson", text: "Check project fonts before rendering", teamName: "Font check", key: "fixture/fonts", sourceTurn: 0, sourceQuote: "missing font found", confidence: 0.9 }]) }));
    const handoff = await api("/api/internal/coordinate-bots", "POST", { botIds: [helper.id], thread: "new", reply: "none", message: "Check the project fonts" }, token);
    const delegatedThread = handoff.receipts[0].threadId;
    expect(delegatedThread).not.toBe(helper.threadId);
    await expect.poll(async () => (await api("/api/team-memory?section=Postproduction")).entries.some((entry: TeamMemoryEntry) => entry.key === "fixture/fonts"), { timeout: 30_000 }).toBe(true);
    const lesson = (await api("/api/team-memory?section=Postproduction")).entries.find((entry: TeamMemoryEntry) => entry.key === "fixture/fonts");
    expect(lesson.source.threadId).toBe(delegatedThread);
    expect(lesson.source.messageId).toBeTruthy();
    expect(lesson.status).toBe("proposed");
    const delegatedMessages = (await api(`/api/threads/${delegatedThread}/messages`)).messages;
    expect(delegatedMessages.filter((message: { role: string }) => message.role === "user")).toEqual([]);

  } finally {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
