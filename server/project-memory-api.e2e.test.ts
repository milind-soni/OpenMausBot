import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb, verificationServerEnvironment } from "../scripts/control-omb.ts";
import { waitForExit } from "./testing/cleanup.ts";

it("binds project memory to current native capabilities, project CWD and revocable policy across a server restart", async () => {
  const fixture = await launchVerificationServer(process.env);
  const { url, dataDir, logPath } = fixture.info;
  const capabilityKey = "project-memory-isolated-fixture";
  let child: ChildProcess | undefined;
  const api = async (path: string, method = "GET", body?: unknown, token?: string, expected = 200): Promise<any> => {
    const response = await fetch(url + path, { method,
      headers: { origin: url, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000) });
    const result = await response.json();
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(expected);
    return result;
  };
  const start = async () => {
    await waitForExit(child ?? fixture.child, { signal: "SIGTERM" });
    const log = openSync(logPath, "a", 0o600);
    child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(new URL("./index.ts", import.meta.url))], {
      cwd: fileURLToPath(new URL("..", import.meta.url)), stdio: ["ignore", log, log],
      env: { ...verificationServerEnvironment({}, dataDir, Number(new URL(url).port)), OMB_TEST_INTERNAL_CAPABILITY_KEY: capabilityKey },
    });
    closeSync(log);
    await expect.poll(async () => { try { return (await fetch(url + "/api/health")).ok; } catch { return false; } }, { timeout: 30_000 }).toBe(true);
  };
  const mint = async (botId: string, threadId: string): Promise<string> => {
    const response = await fetch(url + "/api/testing/internal-capability", { method: "POST",
      headers: { "content-type": "application/json", "x-openmausbot-test-capability": capabilityKey },
      body: JSON.stringify({ botId, threadId, kind: "agents" }), signal: AbortSignal.timeout(20_000) });
    expect(response.status).toBe(201);
    return ((await response.json()) as { token: string }).token;
  };
  const path = "/api/internal/project-memory";
  try {
    await start();
    const uncanonical = [join(dataDir, "project-alpha"), join(dataDir, "project-beta")];
    for (const root of uncanonical) mkdirSync(root);
    const roots = uncanonical.map(root => realpathSync(root));
    const alpha = (await api("/api/bots", "POST", { name: "Project Alpha Member", section: "Project Alpha", cwd: roots[0], memoryUpkeep: false }, undefined, 201)).bot;
    const beta = (await api("/api/bots", "POST", { name: "Project Beta Member", section: "Project Beta", cwd: roots[1], memoryUpkeep: false }, undefined, 201)).bot;
    const alphaTask = (await api(`/api/bots/${alpha.id}/tasks`, "POST", { title: "Alpha canary", cwd: roots[0], approvalMode: "ask" }, undefined, 201)).task;
    const betaTask = (await api(`/api/bots/${beta.id}/tasks`, "POST", { title: "Beta exclusion", cwd: roots[1], approvalMode: "ask" }, undefined, 201)).task;
    const registry = JSON.parse(readFileSync(join(dataDir, "section-contexts.json"), "utf8"));
    const projects = [
      { id: "fixture-alpha", sectionKey: registry.memoryKeys["Project Alpha"], root: roots[0], memberBotIds: [alpha.id] },
      { id: "fixture-beta", sectionKey: registry.memoryKeys["Project Beta"], root: roots[1], memberBotIds: [beta.id] },
    ];
    expect(projects[0].sectionKey).toMatch(/^team:/);
    const policy = join(dataDir, "project-memory-policy.json");
    const savePolicy = (entries: typeof projects) => writeFileSync(policy, JSON.stringify({ version: 1, projects: entries }), { mode: 0o600 });
    savePolicy(projects);
    const pairing = await api("/api/auth/pairing", "POST", { label: "Project fixture browser", scopes: ["client"] });
    const paired = await api("/api/auth/pair", "POST", { code: pairing.code, label: "Project fixture browser" });
    for (const [botId, threadId] of [[alpha.id, alphaTask.threadId], [beta.id, betaTask.threadId]]) {
      await api(`/api/bots/${botId}/messages`, "POST", { threadId, text: "Synthetic user-driven project-memory fixture request" }, paired.token, 202);
      expect(await runControlOmb(["wait", "--bot", botId, "--task", threadId, "--timeout", "30", "--url", url])).toMatchObject({ status: "settled" });
    }
    let alphaToken = await mint(alpha.id, alphaTask.threadId);
    let betaToken = await mint(beta.id, betaTask.threadId);
    const fact = { operation: "remember", kind: "decision", key: "acceptance/canary", name: "Native project canary", detail: "Synthetic amber 7453" };
    const oversized = await api(path, "POST", { ...fact, detail: "PRIVATE_NOTE_".padEnd(826, "x") }, alphaToken, 400);
    expect(oversized.code).toBe("invalid");
    expect(oversized.error).toContain("detail");
    expect(oversized.error).toContain("600");
    expect(oversized.error).toContain("826");
    expect(JSON.stringify(oversized)).not.toContain("PRIVATE_NOTE_");
    expect((await api(path, "POST", { operation: "recall" }, alphaToken)).entries).toEqual([]);
    const stored = await api(path, "POST", fact, alphaToken, 201);
    expect(stored).toMatchObject({ state: "remembered", canonical: false, promoted: false, untrusted_context: true,
      entry: { detail: fact.detail, source: { botId: alpha.id, threadId: alphaTask.threadId,
        project: { id: "fixture-alpha", root: roots[0], sectionKey: projects[0].sectionKey } } } });
    expect(stored.entry.source.turnId).toBeTruthy();
    expect(stored.entry.source.project.assignmentId).toBeTruthy();
    expect((await api(path, "POST", { operation: "recall", query: "amber" }, alphaToken)).entries).toMatchObject([{ id: stored.entry.id }]);
    expect((await api(path, "POST", { operation: "recall", entryId: stored.entry.id }, betaToken)).entries).toEqual([]);
    await api(path, "POST", { operation: "forget", entryId: stored.entry.id, revision: stored.entry.revision }, betaToken, 404);
    await api(path, "POST", { operation: "recall", projectId: "fixture-alpha" }, betaToken, 400);
    await api(path + "?projectId=fixture-alpha", "POST", { operation: "recall" }, betaToken, 400);
    await api(path, "POST", { ...fact, fromBotId: alpha.id }, betaToken, 403);
    await api(path, "POST", { ...fact, fromThreadId: alphaTask.threadId }, betaToken, 403);
    await api(path, "POST", { ...fact, path: "../project-alpha/memory.md" }, betaToken, 400);
    expect((await api("/api/team-memory?section=Project%20Alpha")).entries).toEqual([]);
    expect((await api(path, "POST", { operation: "recall" }, alphaToken)).entries[0].detail).toBe(fact.detail);

    const switched = (await api(`/api/bots/${alpha.id}/tasks`, "POST", { title: "Same bot, foreign folder", cwd: roots[1], approvalMode: "ask" }, undefined, 201)).task;
    const switchedToken = await mint(alpha.id, switched.threadId);
    await api(path, "POST", { operation: "recall", entryId: stored.entry.id }, switchedToken, 403);
    await api(path, "POST", fact, switchedToken, 403);

    const undriven = (await api(`/api/bots/${alpha.id}/tasks`, "POST", { title: "Undriven project writer", cwd: roots[0], approvalMode: "ask" }, undefined, 201)).task;
    const undrivenToken = await mint(alpha.id, undriven.threadId);
    await api(path, "POST", { ...fact, detail: "Must not be written" }, undrivenToken, 403);
    expect((await api(path, "POST", { operation: "recall" }, alphaToken)).entries[0].detail).toBe(fact.detail);
    savePolicy([projects[1]]);
    await api(path, "POST", { operation: "recall" }, alphaToken, 403);
    await start();
    await api(path, "POST", { operation: "recall" }, alphaToken, 401);
    alphaToken = await mint(alpha.id, alphaTask.threadId);
    betaToken = await mint(beta.id, betaTask.threadId);
    await api(path, "POST", { operation: "recall" }, alphaToken, 403);
    savePolicy(projects);
    const recovered = await api(path, "POST", { operation: "recall", entryId: stored.entry.id }, alphaToken);
    expect(recovered.entries).toMatchObject([{ id: stored.entry.id, revision: stored.entry.revision, detail: fact.detail, source: stored.entry.source }]);
    expect((await api(path, "POST", { operation: "recall", entryId: stored.entry.id }, betaToken)).entries).toEqual([]);
    expect(JSON.parse(readFileSync(join(dataDir, "team-memory.json"), "utf8")).version).toBe(3);
    expect(await api(path, "POST", stored.undo, alphaToken)).toMatchObject({ state: "forgotten" });
    expect((await api(path, "POST", { operation: "recall" }, alphaToken)).entries).toEqual([]);
  } finally {
    if (child) await waitForExit(child, { signal: "SIGTERM" });
    await fixture.close();
  }
}, 120_000);
