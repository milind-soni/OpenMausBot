import { createServer } from "node:http";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("keeps the selected API model for direct, group and scheduled Box turns and preserves human control", async () => {
  const rows: Array<{ id: string; name: string; state: string }> = [];
  const requests: any[] = [];
  const commands: string[] = [];
  let nativePrompts = 0;
  let boxOffline = false;
  const upstream = createServer(async (req, res) => {
    const path = new URL(req.url ?? "/", "http://fixture").pathname;
    let raw = ""; for await (const part of req) raw += part;
    const body = raw ? JSON.parse(raw) : {};
    res.setHeader("content-type", "application/json");
    if (path === "/v1/models") return res.end(JSON.stringify({ data: [{ id: "chosen-vision-model" }, { id: "other-default" }] }));
    if (path === "/v1/chat/completions") {
      requests.push(body);
      const completed = body.messages.some((message: any) => message.role === "tool");
      const tool = body.tools?.find((entry: any) => entry.function.name === "computer_screenshot");
      return res.end(JSON.stringify({ choices: [{ message: completed
        ? { role: "assistant", content: "Fixture completed." }
        : { role: "assistant", content: null, tool_calls: [{ id: "capture", type: "function", function: { name: tool?.function.name ?? "missing_computer", arguments: "{}" } }] },
      finish_reason: completed ? "stop" : "tool_calls" }] }));
    }
    if (boxOffline && path.startsWith("/boxes")) { res.statusCode = 503; return res.end(JSON.stringify({ error: "Fixture Box unavailable" })); }
    if (path === "/boxes" && req.method === "POST") {
      const row = { id: rows.length ? "bx_3456789a" : "bx_23456789", name: body.name, state: "idle" }; rows.push(row);
      return res.end(JSON.stringify({ box: row }));
    }
    if (path === "/boxes") return res.end(JSON.stringify({ boxes: rows }));
    if (path.endsWith("/commands")) { commands.push(body.command); return res.end(JSON.stringify({ exitCode: 0, stdout: "captured", stderr: "" })); }
    if (path.endsWith("/artifacts")) { res.setHeader("content-type", "image/jpeg"); return res.end(Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8qqKKKAP/2Q==", "base64")); }
    if (path.endsWith("/desktop")) return res.end(JSON.stringify({ desktopUrl: "https://desktop.fixture.invalid" }));
    if (path.endsWith("/prompt")) { nativePrompts++; return res.end(JSON.stringify({ promptRun: { id: "unexpected-native" } })); }
    const row = rows.find(row => path === "/boxes/" + row.id);
    if (row) {
      if (req.method === "PATCH" && typeof body.name === "string") row.name = body.name;
      return res.end(JSON.stringify({ box: row }));
    }
    res.end("{}");
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("fixture failed to bind");
  const origin = `http://127.0.0.1:${address.port}`;
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, undefined, [], origin).catch(async error => {
    upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); throw error;
  });
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method, headers: { "content-type": "application/json", origin: fixture.info.url }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json() as any;
    expect(response.ok, JSON.stringify(result)).toBe(true);
    return result;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  try {
    await api("PATCH", "/api/config", { openaiCompat: { key: "synthetic-model-key", url: origin + "/v1", model: "other-default" } });
    const { bot } = await control(["new-bot", "--name", "Box API fixture"]);
    await control(["set-model", "--bot", bot.id, "--instance", "openaiCompat", "--model", "chosen-vision-model"]);
    await api("PATCH", `/api/bots/${bot.id}`, { computer: "cloud", browser: false });
    let group: any;
    for (const scenario of ["direct", "held", "group"]) {
      if (scenario === "group") ({ group } = await api("POST", "/api/groups", { name: "Box fixture room", memberIds: [bot.id], setup: { bulletin: "", defaultResponder: { kind: "member", botId: bot.id } } }));
      const before = requests.length;
      const destination = scenario === "group" ? ["--channel", group.id, "--task", group.threadId] : ["--bot", bot.id, "--task", bot.activeTaskId];
      await control([scenario === "group" ? "send-channel" : "send", ...destination, "--text", "Inspect the assigned cloud desktop."]);
      const waiting = await control(["wait", ...destination, "--timeout", "20"]);
      expect(waiting.status, JSON.stringify({ scenario, waiting })).toBe("needs-user");
      const current = await api("GET", "/api/bots");
      const conversation = scenario === "group" ? current.groups.find((item: any) => item.id === group.id) : current.bots.find((item: any) => item.id === bot.id);
      const card = conversation.messages.find((message: any) => message.card?.requestId && !message.card.answered)?.card;
      expect(card?.requestId).toBeTruthy();
      if (scenario === "held") await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "take" });
      await api("POST", `/api/threads/${scenario === "group" ? group.threadId : bot.activeTaskId}/respond`, { requestId: card.requestId, behavior: "allow" });
      const settled = await control(["wait", ...destination, "--timeout", "20"]);
      expect(settled.status).toBe(scenario === "held" ? "failed" : "settled");
      expect(requests.slice(before)).toHaveLength(2);
      expect(requests.slice(before).every(request => request.model === "chosen-vision-model")).toBe(true);
      const followup = requests[before + 1].messages;
      if (scenario === "held") {
        expect(followup.at(-1).content).toContain("NOT performed");
        await api("POST", `/api/bots/${bot.id}/computer/control`, { action: "release" });
      } else {
        expect(followup.at(-1).content[1].type).toBe("image_url");
      }
      expect(nativePrompts).toBe(0);
    }
    const beforeRoutine = requests.length;
    const { routine } = await api("POST", "/api/routines", { name: "Cloud fixture", botId: bot.id,
      prompt: "Inspect the assigned cloud desktop.", runOn: "cloud", enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } });
    const { run } = await api("POST", `/api/routines/${routine.id}/run`, {});
    let routineThread = "";
    await expect.poll(async () => {
      routineThread = (await api("GET", "/api/routines")).runs.find((entry: any) => entry.id === run.id)?.threadId ?? "";
      return routineThread;
    }, { timeout: 15_000 }).not.toBe("");
    const destination = ["--bot", bot.id, "--task", routineThread];
    const waiting = await control(["wait", ...destination, "--timeout", "20"]);
    expect(waiting.status, JSON.stringify(waiting)).toBe("needs-user");
    const routineMessages = await api("GET", `/api/threads/${routineThread}/messages?limit=30`);
    const card = routineMessages.messages.find((message: any) => message.card?.requestId && !message.card.answered)?.card;
    expect(card?.requestId).toBeTruthy();
    await api("POST", `/api/threads/${routineThread}/respond`, { requestId: card.requestId, behavior: "allow" });
    expect((await control(["wait", ...destination, "--timeout", "20"])).status).toBe("settled");
    expect(requests.slice(beforeRoutine)).toHaveLength(2);
    expect(requests.slice(beforeRoutine).every(request => request.model === "chosen-vision-model")).toBe(true);
    expect(nativePrompts).toBe(0);
    expect(commands.some(command => command.includes(".model.jpg"))).toBe(true);
    // Readiness is checked again at dispatch, after the routine was created.
    // An available native Box runner must not mask the selected engine's missing key.
    const expectBlockedRun = async (reason: RegExp) => {
      const before = requests.length;
      const { run: blocked } = await api("POST", `/api/routines/${routine.id}/run`, {});
      await expect.poll(async () => {
        const latest = (await api("GET", "/api/routines")).runs.find((entry: any) => entry.id === blocked.id);
        return latest?.status === "failed" ? latest.error : "";
      }, { timeout: 15_000 }).toMatch(reason);
      expect(requests).toHaveLength(before);
      expect(nativePrompts).toBe(0);
    };
    await api("PATCH", "/api/config", { openaiCompat: { key: "", url: origin + "/v1", model: "other-default" } });
    await expectBlockedRun(/target bot's model engine is not ready/i);
    await api("PATCH", "/api/config", { openaiCompat: { key: "synthetic-model-key", url: origin + "/v1", model: "other-default" } });
    boxOffline = true;
    await expectBlockedRun(/cloud computer could not be checked/i);
  } finally {
    await fixture.close(); upstream.closeAllConnections();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
  }
}, 90_000);
