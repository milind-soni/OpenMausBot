import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";

import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("filters thread titles and notes by short identifying terms through the real search route", async () => {
  const key = randomUUID();
  const fixture = await launchVerificationServer({ ...process.env, OMB_TEST_INTERNAL_CAPABILITY_KEY: key });
  const api = async (path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(fixture.info.url + path, {
      method, headers: { "content-type": "application/json", origin: fixture.info.url, ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(20_000),
    });
    expect(response.ok, `${method} ${path}: ${response.status}`).toBe(true);
    return await response.json() as any;
  };
  try {
    expect(await runControlOmb(["doctor", "--url", fixture.info.url])).toMatchObject({ ok: true });
    const { bot } = await runControlOmb(["new-bot", "--name", "Search Counsel", "--url", fixture.info.url]) as any;
    const ids: string[] = [];
    for (const title of ["Contract 7", "Contract 8", "李先生的租约", "张先生的租约"]) {
      const created = await api(`/api/bots/${bot.id}/tasks`, "POST", { title });
      ids.push(String(created.task?.threadId ?? created.threadId));
    }
    await api(`/api/bots/${bot.id}/memory/thread/${ids[0]}`, "PUT", { text: "Agreed clause 7" });
    await api(`/api/bots/${bot.id}/memory/thread/${ids[1]}`, "PUT", { text: "Agreed clause 8" });
    const { token } = await api("/api/testing/internal-capability", "POST", {
      botId: bot.id, threadId: bot.activeTaskId, kind: "agents",
    }, { "x-openmausbot-test-capability": key });
    const search = (query: string) => api(`/api/internal/session-search?${new URLSearchParams({
      fromBotId: bot.id, fromThreadId: bot.activeTaskId, scope: "threads", q: query,
    })}`, "GET", undefined, { authorization: `Bearer ${token}` });
    expect(await search("Contract 7")).toMatchObject({ total: 1, threads: [{ threadId: ids[0] }] });
    expect(await search("clause 7")).toMatchObject({ total: 1, threads: [{ threadId: ids[0] }] });
    expect(await search("李")).toMatchObject({ total: 1, threads: [{ threadId: ids[2] }] });
    expect(await search("Contract 9")).toMatchObject({ total: 0, threads: [] });
    expect(await search("")).toMatchObject({ total: 4 });
  } finally {
    await fixture.close();
  }
}, 90_000);
