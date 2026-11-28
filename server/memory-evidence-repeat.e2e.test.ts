import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireBot } from "../shared/wire.ts";
import { CAPTURE_MARKER } from "./memory-capture.ts";
import { ORGANIZE_MARKER } from "./memory-organize.ts";

it("captures a repeated quote only when a real statement supports it", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-memory-evidence-"));
  const routes = join(scratch, "routes.json");
  writeFileSync(routes, JSON.stringify({
    [CAPTURE_MARKER]: JSON.stringify([{
      text: "The person prefers short replies", kind: "preference",
      evidence: "I prefer short replies", aboutUser: true,
    }]),
    [ORGANIZE_MARKER]: '{"moves": []}',
  }));
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CODEX_TEXT_ROUTES: routes },
    undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const api = async <T>(path: string, method = "GET", body?: unknown, status = 200): Promise<T> => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    expect(response.status, `${method} ${path}`).toBe(status);
    return response.json() as Promise<T>;
  };
  try {
    const { instances } = await api<{ instances: Array<{ instanceId: string; models: { default: string } }> }>("/api/instances");
    const codex = instances.find((instance) => instance.instanceId === "codex")!;
    await api("/api/config", "PUT", { memory: { captureQuietMs: 1_000 } });
    for (const [person, added] of [
      ["Did I say I prefer short replies? Have I said I prefer short replies?", 0],
      ["Did I say I prefer short replies? I prefer short replies.", 1],
    ] as const) {
      const { bot } = await api<{ bot: WireBot }>("/api/bots", "POST", {
        name: `Evidence ${added}`, modelSelection: { instanceId: "codex", model: codex.models.default },
      }, 201);
      const control = (...args: string[]) => runControlOmb([...args, "--url", fixture.info.url]);
      await control("send", "--bot", bot.id, "--task", bot.threadId, "--text", person);
      expect(await control("wait", "--bot", bot.id, "--task", bot.threadId, "--timeout", "30")).toMatchObject({ status: "settled" });
      type Upkeep = { lastCapture?: { added: number } };
      await expect.poll(async () => (await api<Upkeep>(`/api/bots/${bot.id}/memory/upkeep`)).lastCapture,
        { timeout: 20_000 }).toBeDefined();
      expect((await api<Upkeep>(`/api/bots/${bot.id}/memory/upkeep`)).lastCapture?.added).toBe(added);
      const { text } = await api<{ text: string }>(`/api/bots/${bot.id}/memory/file?path=MEMORY.md`);
      expect(text.includes("The person prefers short replies")).toBe(added === 1);
      const { entries } = await api<{ entries: Array<{ via: string }> }>(`/api/bots/${bot.id}/memory/journal`);
      expect(entries.filter((row) => row.via === "capture")).toHaveLength(added);
      const { learned } = await api<{ learned: Array<{ text: string }> }>("/api/profile/learned");
      expect(learned.map((row) => row.text)).toEqual(added ? ["The person prefers short replies"] : []);
    }
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
