// Against the real server: the room's eligibility and the turn it reads are assembled in server/index.ts.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";
import type { WireBot } from "../shared/wire.ts";
import { CAPTURE_MARKER } from "./memory-capture.ts";

it("captures a member bot's room turn into its memory, sourced to the room, once Learn from group chats is on", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-room-capture-"));
  const routes = join(scratch, "routes.json");
  const textLog = join(scratch, "text-prompts.jsonl");
  writeFileSync(routes, JSON.stringify({
    [CAPTURE_MARKER]: JSON.stringify([{ text: "The garden launch moved to Friday", kind: "decision", confidence: 0.9 }]),
  }));
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CLAUDE_TEXT_ROUTES: routes, FAKE_CLAUDE_TEXT_LOG: textLog });
  const env = { OPENMAUSBOT_URL: fixture.info.url };
  const api = async <T = any>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as T;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  // Memory upkeep can run after the CAPTURE step, so read every one-shot prompt, not just the last.
  const capturePrompt = () => {
    try {
      return readFileSync(textLog, "utf8").split("\n").filter(Boolean)
        // SAFETY: the fake CLI appends exactly this shape, one object per line
        .map((line) => (JSON.parse(line) as { prompt?: string }).prompt ?? "")
        .find((prompt) => prompt.includes(CAPTURE_MARKER)) ?? "";
    } catch {
      return "";
    }
  };
  try {
    const { bot: lead } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Lead" });
    const { bot: helper } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Helper" });
    await api("/api/config", "PUT", { memory: { captureQuietMs: 1_000 } });
    expect((await api<{ features?: { roomMemoryCapture?: boolean } }>("/api/config")).features?.roomMemoryCapture).toBe(false);
    const config = await api<{ features?: { roomMemoryCapture?: boolean } }>("/api/config", "PATCH", { features: { roomMemoryCapture: true } });
    expect(config.features?.roomMemoryCapture).toBe(true);

    const { group } = await api<{ group: { id: string } }>("/api/groups", "POST", {
      name: "Garden room", memberIds: [lead.id, helper.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    });
    await api(`/api/groups/${group.id}/messages`, "POST", { text: "Lead, the garden launch moved to Friday." });
    await runControlOmb(["wait", "--bot", lead.id, "--timeout", "30"], { env });

    await expect.poll(async () => (await api<{ text: string }>(`/api/bots/${lead.id}/memory/file?path=MEMORY.md`)).text, { timeout: 30_000 })
      .toMatch(/- \d{4}-\d{2}-\d{2} · from room "Garden room" \(noticed\) · The garden launch moved to Friday/);
    const prompt = capturePrompt();
    expect(prompt).toContain("Person: Lead, the garden launch moved to Friday.");
    expect(prompt).toContain('This is a group chat ("room") Lead is a member of.');
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);

// Codex has no generateText: its background call is generateMemoryText, a tool-free `codex exec`.
it("captures a Codex member bot's room turn through Codex's own background call", async () => {
  const scratch = mkdtempSync(join(tmpdir(), "omb-room-capture-codex-"));
  const routes = join(scratch, "routes.json");
  const textLog = join(scratch, "codex-exec.jsonl");
  writeFileSync(routes, JSON.stringify({
    [CAPTURE_MARKER]: JSON.stringify([{ text: "The orchard tour moved to Monday", kind: "decision", confidence: 0.9 }]),
  }));
  const fixture = await launchVerificationServer({ ...process.env, FAKE_CODEX_TEXT_ROUTES: routes, FAKE_CODEX_TEXT_LOG: textLog },
    undefined, undefined, undefined, undefined, undefined, ["codex"]);
  const env = { OPENMAUSBOT_URL: fixture.info.url };
  const api = async <T = any>(path: string, method = "GET", body?: unknown): Promise<T> => {
    const response = await fetch(fixture.info.url + path, {
      method,
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json() as T;
    expect(response.ok, `${method} ${path}: ${JSON.stringify(result)}`).toBe(true);
    return result;
  };
  // SAFETY: the fake CLI appends exactly this shape, one object per line
  const execCalls = () => (existsSync(textLog) ? readFileSync(textLog, "utf8").split("\n").filter(Boolean) : [])
    .map((line) => JSON.parse(line) as { argv: string[]; prompt: string });
  try {
    const { instances } = await api<{ instances: Array<{ instanceId: string; models: { default: string }; capabilities: { backgroundText?: boolean } }> }>("/api/instances");
    const codex = instances.find((instance) => instance.instanceId === "codex")!;
    expect(codex.capabilities.backgroundText).toBe(true);
    const { bot: lead } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Lead", modelSelection: { instanceId: "codex", model: codex.models.default } });
    const { bot: helper } = await api<{ bot: WireBot }>("/api/bots", "POST", { name: "Helper" });
    expect(await api(`/api/bots/${lead.id}/memory/upkeep`)).toMatchObject({ enabled: true, modelSteps: true });
    await api("/api/config", "PUT", { memory: { captureQuietMs: 1_000 } });
    await api("/api/config", "PATCH", { features: { roomMemoryCapture: true } });

    const { group } = await api<{ group: { id: string; threadId: string } }>("/api/groups", "POST", {
      name: "Orchard room", memberIds: [lead.id, helper.id],
      setup: { bulletin: "", defaultResponder: { kind: "member", botId: lead.id } },
    });
    await api(`/api/groups/${group.id}/messages`, "POST", { text: "Lead, the orchard tour moved to Monday." });
    await runControlOmb(["wait", "--bot", lead.id, "--timeout", "30"], { env });

    await expect.poll(async () => (await api<{ text: string }>(`/api/bots/${lead.id}/memory/file?path=MEMORY.md`)).text, { timeout: 30_000 })
      .toMatch(/- \d{4}-\d{2}-\d{2} · from room "Orchard room" \(noticed\) · The orchard tour moved to Monday/);
    const capture = execCalls().find((call) => call.prompt.includes(CAPTURE_MARKER));
    expect(capture?.prompt).toContain("Person: Lead, the orchard tour moved to Monday.");
    expect(capture?.argv).toEqual(expect.arrayContaining(["exec", "--ignore-user-config", "--ephemeral"]));

    await expect.poll(async () => (await api<{ entries: Array<{ path: string; actor: string; via: string; threadId?: string }> }>(`/api/bots/${lead.id}/memory/journal`)).entries
      .filter((entry) => entry.path.startsWith("memory/log/")), { timeout: 10_000 })
      .toEqual([expect.objectContaining({ actor: "bot", via: "turn", threadId: group.threadId })]);
  } finally {
    await fixture.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}, 120_000);
