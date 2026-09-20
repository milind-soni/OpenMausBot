import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it.each([false, true])("isolated browser Full access with host opt-in=%s", async (enabled) => {
  const fixture = await launchVerificationServer({ FAKE_CLAUDE_MODE: "slow" }, undefined, undefined, undefined, undefined, undefined, ["codex"], undefined, { browserFullAccess: enabled });
  const { url, dataDir, logPath } = fixture.info;
  const evidence: unknown[] = [];
  const api = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}, status = 200) => {
    const response = await fetch(url + path, { method, headers: { "content-type": "application/json", origin: url, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(10_000) });
    const result = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(result)}`).toBe(status);
    if (!path.startsWith("/api/auth")) evidence.push({ method, path, status: response.status, result });
    return { result, cookie: response.headers.get("set-cookie")?.split(";")[0] };
  };
  const pair = async (scopes: string[], cookie: boolean) => {
    const { result: opened } = await api("POST", "/api/auth/pairing", { scopes });
    return api("POST", "/api/auth/pair", { code: opened.code, cookie, label: "Isolated approval fixture" });
  };
  try {
    const admin = await pair(["admin", "client"], true);
    const client = await pair(["client"], true);
    const bearer = await pair(["admin", "client"], false);
    const ownerHeaders = { cookie: admin.cookie! };
    const { result: created } = await api("POST", "/api/bots", { name: "Full access fixture" }, {}, 201);
    const bot = created.bot;
    const { result: sibling } = await api("POST", `/api/bots/${bot.id}/tasks`, { title: "Ask sibling" }, {}, 201);
    const route = `/api/bots/${bot.id}/browser-approval`;
    const grant = { mode: "full", threadId: bot.threadId, threadOnly: true, confirmFullAccess: true };
    expect((await api("GET", "/api/approval-capabilities", undefined, ownerHeaders)).result.browserFullAccess).toBe(enabled);
    const deniedHeaders: Record<string, string>[] = [{}, { cookie: client.cookie! }, { authorization: `Bearer ${bearer.result.token}` }];
    for (const headers of deniedHeaders) {
      expect((await api("GET", "/api/approval-capabilities", undefined, headers)).result.browserFullAccess).toBe(false);
      await api("POST", route, grant, headers, 403);
    }
    await api("POST", route, grant, { ...ownerHeaders, origin: "https://foreign.example" }, 403);
    await api("POST", route, grant, { ...ownerHeaders, origin: "" }, 403);
    await api("PATCH", `/api/bots/${bot.id}`, { approvalMode: "full" }, ownerHeaders, 403);
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { approvalMode: "full" }, ownerHeaders, 403);
    if (!enabled) { await api("POST", route, grant, ownerHeaders, 403); return; }
    await api("POST", route, { ...grant, confirmFullAccess: false }, ownerHeaders, 400);
    await api("POST", route, { ...grant, mode: "custom" }, ownerHeaders, 400);
    await api("POST", route, { ...grant, threadId: "missing" }, ownerHeaders, 404);
    await api("POST", route, grant, ownerHeaders);
    await api("POST", route, { ...grant, modelSelection: { instanceId: "codex", model: "fixture" } }, ownerHeaders, 400);
    await api("POST", route, { ...grant, threadId: sibling.task.threadId, threadOnly: false }, ownerHeaders, 400);
    await api("PATCH", `/api/bots/${bot.id}/tasks/${bot.threadId}`, { modelSelection: { instanceId: "codex", model: "fixture" } }, ownerHeaders, 400);
    const saved = JSON.parse(readFileSync(join(dataDir, "bots.json"), "utf8")).find((value: any) => value.id === bot.id);
    expect(saved.approvalMode ?? "ask").toBe("ask");
    expect(saved.tasks.find((task: any) => task.threadId === bot.threadId).approvalMode).toBe("full");
    expect(saved.tasks.find((task: any) => task.threadId === sibling.task.threadId).approvalMode ?? "ask").toBe("ask");

    await api("POST", `/api/bots/${bot.id}/messages`, { text: "Complete the isolated fixture turn", threadId: bot.threadId }, {}, 202);
    await api("POST", route, grant, ownerHeaders, 409);
    const settled = await runControlOmb(["wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "20", "--url", url]) as any;
    expect(settled.status).toBe("settled");
    const dump = JSON.parse(readFileSync(fixture.fixtureDumpPath, "utf8"));
    expect(dump.argv[dump.argv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
    await api("POST", route, { mode: "ask", threadId: bot.threadId, threadOnly: true }, ownerHeaders);
    const fullDefault = (await api("POST", route, { mode: "full", confirmFullAccess: true }, ownerHeaders)).result.bot;
    expect(fullDefault.approvalMode).toBe("full");
    expect(fullDefault.tasks.find((task: any) => task.threadId === bot.threadId).approvalMode).toBe("ask");
    await api("POST", route, { mode: "ask" }, ownerHeaders);
    await api("DELETE", `/api/auth/sessions/${admin.result.session.id}`, undefined, { authorization: `Bearer ${bearer.result.token}` });
    await api("POST", route, grant, ownerHeaders, 401);
  } finally {
    writeFileSync(`${logPath}.browser-full-access.json`, JSON.stringify(evidence, null, 2));
    await fixture.close();
  }
}, 90_000);
