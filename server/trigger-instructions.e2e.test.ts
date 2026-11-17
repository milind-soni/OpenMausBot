import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

it("reads, edits and verifies long automation instructions through the real MCP tools without losing the tail or hidden credentials", async () => {
  const fixture = await launchVerificationServer(process.env, undefined, undefined, undefined, undefined, { scripted: true });
  const planPath = join(fixture.info.dataDir, "room-plan.json");
  const evidencePath = `${planPath}.evidence.jsonl`;
  const api = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(fixture.info.url + path, { method,
      headers: { "content-type": "application/json", origin: fixture.info.url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.ok, JSON.stringify(value)).toBe(true);
    return value;
  };
  const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]) as Promise<any>;
  const turns = () => existsSync(evidencePath)
    ? readFileSync(evidencePath, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) : [];
  try {
    const { bot } = await control("new-bot", "--name", "Instruction fixture");
    const tool = async (name: string, args: unknown, expectError = false) => {
      const count = turns().length;
      writeFileSync(planPath, JSON.stringify({ [bot.id]: { steps: [{ tool: name, arguments: args, expectError }], reply: "Fixture complete." } }));
      await control("send", "--bot", bot.id, "--task", bot.activeTaskId, "--text", "Check this fixture automation.");
      await expect.poll(() => turns().length, { timeout: 20_000 }).toBe(count + 1);
      await control("wait", "--bot", bot.id, "--task", bot.activeTaskId, "--timeout", "20");
      const response = turns().at(-1).evidence.find((entry: any) => entry.step?.tool === name).response;
      expect(response.error).toBeUndefined();
      expect(Boolean(response.result.isError)).toBe(expectError);
      return response.result.content[0].text as string;
    };
    const detail = async (id: string) => {
      const text = await tool("trigger_info", { action: "list", trigger_id: id });
      return JSON.parse(text.slice(text.indexOf("\n") + 1));
    };
    const prompt = "Review the queue.\n".repeat(220) + "Keep this final instruction.";
    const routine = (await api("POST", "/api/routines", { name: "Long schedule", botId: bot.id, prompt, enabled: false,
      schedule: { type: "interval", everyMinutes: 60, anchorAt: Date.now() + 3_600_000 } })).routine;
    const webhook = (await api("POST", "/api/webhooks", { name: "Long webhook", botId: bot.id, prompt, enabled: false })).webhook;
    const listing = await tool("trigger_info", { action: "list" });
    const previews = JSON.parse(listing.slice(listing.indexOf("\n") + 1));
    for (const saved of [routine, webhook]) {
      expect(previews.find((row: any) => row.id === saved.id)).toMatchObject({ instructionsTruncated: true });
      const full = await detail(saved.id);
      expect(full).toMatchObject({ instructions: prompt, instructionsTruncated: false, instructionsRedacted: false });
      const revised = full.instructions.replace("Review the queue.", "Review the queue twice.");
      await tool("trigger", { action: "update", trigger_id: saved.id, instructions: revised });
      expect((await detail(saved.id)).instructions).toBe(revised);
      const path = saved.id === routine.id ? "/api/routines" : "/api/webhooks";
      const rows = (await api("GET", path))[saved.id === routine.id ? "routines" : "webhooks"];
      expect(rows.find((row: any) => row.id === saved.id).prompt).toBe(revised);
      const secret = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789";
      const protectedPrompt = `${prompt}\nUse ${secret}.`;
      await api("PATCH", `${path}/${saved.id}`, { prompt: protectedPrompt });
      const hidden = await detail(saved.id);
      expect(hidden.instructionsRedacted).toBe(true);
      expect(hidden.instructionsTruncated).toBe(false);
      expect(JSON.stringify(hidden)).not.toContain(secret);
      const refusal = await tool("trigger", { action: "update", trigger_id: saved.id, name: "Must not apply", instructions: hidden.instructions }, true);
      expect(refusal).not.toContain(secret);
      expect((await api("GET", path))[saved.id === routine.id ? "routines" : "webhooks"].find((row: any) => row.id === saved.id))
        .toMatchObject({ name: saved.name, prompt: protectedPrompt });
      await tool("trigger", { action: "update", trigger_id: saved.id, name: "Safe rename" });
      expect((await api("GET", path))[saved.id === routine.id ? "routines" : "webhooks"].find((row: any) => row.id === saved.id))
        .toMatchObject({ name: "Safe rename", prompt: protectedPrompt });
    }
  } finally {
    if (existsSync(evidencePath)) writeFileSync(`${fixture.info.logPath}.trigger-instructions.jsonl`, readFileSync(evidencePath));
    console.info(JSON.stringify({ logPath: fixture.info.logPath }));
    await fixture.close();
  }
}, 180_000);
