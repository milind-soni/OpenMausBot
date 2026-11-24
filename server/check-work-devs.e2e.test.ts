import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import { request } from "../scripts/mcp-server.ts";

// A check before done brief quotes the answer it checks. An answer that drafts an "@devs ..." line for the person
// must not send a report from the checker's thread: only what the person types does.

it("never sends a report for an @devs draft quoted in a check before done brief; the person's own @devs still goes", async () => {
  const received: Array<Record<string, string>> = [];
  const endpoint = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      if (incoming.method === "POST" && incoming.url === "/api/bug-reports") received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      response.writeHead(incoming.url === "/api/bug-reports" ? 201 : 404, { "content-type": "application/json" }).end(JSON.stringify({ id: `report-${received.length}` }));
    });
  });
  await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
  try {
    const session = await launchVerificationServer({ ...process.env, OMB_BUG_REPORT_URL: `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/api/bug-reports` },
      undefined, undefined, undefined, undefined, { scripted: true });
    const cli = (...args: string[]) => runControlOmb(args, { env: { OPENMAUSBOT_URL: session.info.url } }) as Promise<any>;
    const api = (path: string, body?: unknown, method = "POST") => request(path, body === undefined ? {} : { method, body: JSON.stringify(body) }, session.info.url) as Promise<any>;
    try {
      const worker = (await cli("new-bot", "--name", "Nib")).bot;
      const checker = (await cli("new-bot", "--name", "Vera")).bot;
      const draft = `The export button stays grey after the upload finishes. ${"It never turns blue again until a reload. ".repeat(12).trim()}\n\nTo tell the team, send this line:\n\n@devs the export button stays grey after an upload`;
      writeFileSync(join(session.info.dataDir, "room-plan.json"), JSON.stringify({
        [worker.id]: { script: [
          { key: "draft", match: ["Write the bug report"], reply: draft },
          { key: "sent", match: ["the export button stays grey"], reply: "Sent." },
        ] },
        [checker.id]: { reply: "pass" },
      }));
      expect((await api(`/api/bots/${worker.id}`, { checkWork: { checker: checker.id } }, "PATCH")).bot.checkWork).toEqual({ checker: checker.id });

      await cli("send", "--bot", worker.id, "--task", worker.activeTaskId, "--text", "Write the bug report for the grey export button, I will send it myself.");
      await expect.poll(async () => ((await api(`/api/threads/${worker.activeTaskId}/messages`)).messages as any[])
        .some((message) => message.tool?.name === "Checked by Vera · passed in round 1"), { timeout: 60_000, interval: 250 }).toBe(true);

      await cli("send", "--bot", worker.id, "--task", worker.activeTaskId, "--text", "@devs the export button stays grey after an upload");
      await expect.poll(() => received.length, { timeout: 60_000, interval: 250 }).toBeGreaterThan(0);
      expect(received).toHaveLength(1);
      expect(received[0]!.description).toContain("the export button stays grey after an upload");
      expect(received[0]!.description).not.toContain("check before done");
    } finally {
      await session.close();
    }
  } finally {
    await new Promise((resolve) => endpoint.close(resolve));
  }
}, 150_000);
