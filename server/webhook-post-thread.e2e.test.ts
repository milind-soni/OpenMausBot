import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("opens a new Updates task for a post webhook after the person deleted the old one", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const { url } = fixture.info;
  const api = async (method: string, path: string, body?: unknown, status = 200) => {
    const response = await fetch(`${url}${path}`, {
      method, headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(status);
    return value;
  };
  const updates = async (botId: string) => ((await api("GET", "/api/bots")).bots.find((bot: any) => bot.id === botId).tasks as any[])
    .filter((task) => task.title === "Updates");
  try {
    const { bot } = await runControlOmb(["new-bot", "--name", "Poster", "--url", url]) as any;
    const hook = await api("POST", "/api/webhooks", { name: "Deploys", prompt: "", botId: bot.id, delivery: "post" }, 201);
    const deliver = (text: string) => fetch(hook.credential.url, {
      method: "POST", headers: { authorization: `Bearer ${hook.credential.secret}`, "content-type": "application/json" }, body: JSON.stringify({ text }),
    });

    expect((await deliver("First deploy.")).status).toBe(202);
    const [first] = await updates(bot.id);
    expect(first).toBeDefined();
    await api("DELETE", `/api/bots/${bot.id}/tasks/${first.threadId}`);

    expect((await deliver("Second deploy.")).status).toBe(202);
    const [second] = await updates(bot.id);
    expect(second?.threadId).toBeDefined();
    expect(second.threadId).not.toBe(first.threadId);
    expect(second.unread).toBe(true);
    const messages = (await api("GET", `/api/threads/${second.threadId}/messages?limit=50`)).messages as any[];
    expect(messages.map((message) => message.text)).toContain("Second deploy.");
    const { webhooks } = await api("GET", "/api/webhooks");
    expect(webhooks.find((candidate: any) => candidate.id === hook.webhook.id)?.resultsThreadId).toBe(second.threadId);
  } finally {
    await fixture.close();
  }
}, 120_000);
