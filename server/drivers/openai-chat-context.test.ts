import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { afterEach, expect, it, vi } from "vitest";
import type { RuntimeEvent, SendTurnInput } from "../contracts.ts";
import { CHAT_IMAGE_BUDGET, chatImage, chatImageBudget } from "./chat-images.ts";
import { OpenAICompatDriver } from "./openai-compat.ts";

afterEach(() => vi.unstubAllGlobals());
const answer = (text: string) => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: "stop" }] }),
  { headers: { "content-type": "application/json" } });
const contextError = () => new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "Prompt exceeds context length." } }), { status: 400 });

async function fixture(onRequest: (body: any, count: number) => Response | Promise<Response>, defaults: Partial<SendTurnInput> = {}) {
  const bodies: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    if (!String(url).endsWith("/chat/completions")) return new Response(JSON.stringify({ data: [] }));
    const body = JSON.parse(String(init?.body));
    bodies.push(body);
    return onRequest(body, bodies.length);
  }));
  const instance = await OpenAICompatDriver.create({ instanceId: "context-fixture", displayName: "Context fixture", enabled: true,
    config: OpenAICompatDriver.decodeConfig({ url: "http://127.0.0.1:1/v1", apiKeyEnv: "K", model: "fixture" }), environment: { K: "fixture-key" } });
  const events: RuntimeEvent[] = [];
  instance.adapter.onEvent(event => events.push(event));
  const send = async (turn: Partial<SendTurnInput>) => {
    const before = events.filter(event => event.type === "turn.completed").length;
    await instance.adapter.sendTurn({ threadId: "t", text: "current", systemStable: "Stable rules", systemVolatile: "Full current notes", ...defaults, ...turn });
    await vi.waitFor(() => expect(events.filter(event => event.type === "turn.completed")).toHaveLength(before + 1), { timeout: 10_000 });
    return events.filter(event => event.type === "turn.completed").at(-1)!;
  };
  const seed = async () => {
    expect(await send({ text: "first", transcript: [], sourceMessage: { id: "u1", role: "user", text: "first" } })).toMatchObject({ ok: true });
    expect(await send({ text: "second", transcript: [{ id: "u1", role: "user", text: "first" }, { id: "a1", role: "assistant", text: "answer 1" }],
      sourceMessage: { id: "u2", role: "user", text: "second" } })).toMatchObject({ ok: true });
  };
  const follow: Partial<SendTurnInput> = { text: "clock and recall: third", sourceMessage: { id: "u3", role: "user", text: "third" }, transcript: [
    { id: "", role: "assistant", text: "[2 earlier messages omitted from this context; full history remains in the app.]" },
    { id: "u2", role: "user", text: "second" }, { id: "a2", role: "assistant", text: "answer 2" },
  ] };
  return { instance, send, seed, follow, bodies, events };
}

it("rebuilds a rejected reused prefix once from the bounded branch and all current notes", async () => {
  const f = await fixture((_body, count) => count === 3 ? contextError() : answer(`answer ${count}`));
  try {
    await f.seed();
    expect(await f.send(f.follow)).toMatchObject({ ok: true });
    expect(f.bodies).toHaveLength(4);
    expect(f.bodies[2].messages.slice(0, f.bodies[1].messages.length)).toEqual(f.bodies[1].messages);
    expect(f.bodies[3].messages.some((m: any) => m.content === "first")).toBe(false);
    expect(f.bodies[3].messages.at(-1).content).toContain("clock and recall: third");
    expect(f.bodies[3].messages.at(-1).content).toContain("Full current notes");
    expect(f.bodies[3].messages).toHaveLength(5);
  } finally { await f.instance.dispose(); }
});

it("rebuilds a rejected full prefix with bounded delivered users, retaining clocks and removing earlier recall", async () => {
  const f = await fixture((_body, count) => count === 3 ? contextError() : answer(`answer ${count}`));
  const transcript: NonNullable<SendTurnInput["transcript"]> = [];
  try {
    for (let index = 1; index <= 2; index++) {
      const typed = `message ${index}`;
      const recalled = `<recalled>${index} private recalled fact</recalled>`;
      expect(await f.send({ text: `Clock ${index}\n\n${recalled}\n\n${typed}`, recalled,
        transcript: [...transcript], sourceMessage: { id: `u${index}`, role: "user", text: typed } })).toMatchObject({ ok: true });
      transcript.push({ id: `u${index}`, role: "user", text: typed }, { id: `a${index}`, role: "assistant", text: `answer ${index}` });
    }
    expect(await f.send({ text: "Clock 3\n\nmessage 3", transcript,
      sourceMessage: { id: "u3", role: "user", text: "message 3" } })).toMatchObject({ ok: true });
    expect(f.bodies).toHaveLength(4);
    expect(f.bodies[2].messages.slice(0, f.bodies[1].messages.length)).toEqual(f.bodies[1].messages);
    const rebuilt = f.bodies[3].messages;
    expect(rebuilt[1].content).toContain("Clock 1");
    expect(rebuilt[3].content).toContain("Clock 2");
    expect(JSON.stringify(rebuilt)).not.toContain("<recalled>");
    expect(JSON.stringify(rebuilt)).toContain("Full current notes");
    expect(rebuilt.at(-1).content).toContain("message 3");
  } finally { await f.instance.dispose(); }
});

it.each(["branch", "reset", "policy"])("does not lend delivered notes across a %s invalidation", async invalidation => {
  const f = await fixture((_body, count) => answer(`answer ${count}`));
  try {
    expect(await f.send({ text: "Original clock\n\nfirst", transcript: [], approvalMode: "ask",
      sourceMessage: { id: "u1", role: "user", text: "first" } })).toMatchObject({ ok: true });
    expect(await f.send({ text: "second", approvalMode: "ask", toolScope: invalidation === "policy" ? { deny: ["native:unused"] } : undefined,
      replayReset: invalidation === "reset", sourceMessage: { id: "u2", role: "user", text: "second" },
      transcript: [{ id: invalidation === "branch" ? "other-user" : "u1", role: "user", text: "first" },
        { id: "a1", role: "assistant", text: "answer 1" }] })).toMatchObject({ ok: true });
    expect(f.bodies[1].messages[1]).toEqual({ role: "user", content: "first" });
    expect(f.bodies[1].messages.at(-1).content).toContain("Full current notes");
  } finally { await f.instance.dispose(); }
});


it.each([
  [400, { error: { message: "Invalid schema" } }, 3],
  [401, { error: { code: "context_length_exceeded" } }, 3],
  [400, { error: { code: "context_length_exceeded" } }, 4],
])("does not rebuild arbitrary errors, auth failures, or twice (%s, %j)", async (status, body, requests) => {
  const f = await fixture((_body, count) => count < 3 ? answer(`answer ${count}`) : new Response(JSON.stringify(body), { status }));
  try {
    await f.seed();
    expect(await f.send(f.follow)).toMatchObject({ ok: false });
    expect(f.bodies).toHaveLength(requests);
  } finally { await f.instance.dispose(); }
});

it.each([
  { content: "Partial answer" },
  { reasoning_content: "Partial thinking" },
  { tool_calls: [{ index: 0, id: "partial", type: "function", function: { name: "ask_user", arguments: "{" } }] },
])("does not replay a context rejection after streamed output (%j)", async delta => {
  const f = await fixture((_body, count) => count < 3 ? answer(`answer ${count}`) : new Response(
    `data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n` +
    'data: {"error":{"code":"context_length_exceeded","message":"Prompt exceeds context length."}}\n\n',
    { headers: { "content-type": "text/event-stream" } }));
  try {
    await f.seed();
    expect(await f.send(f.follow)).toMatchObject({ ok: false });
    expect(f.bodies).toHaveLength(3);
    if ("content" in delta) expect(f.events.some(event => event.type === "content.delta" && event.delta === delta.content)).toBe(true);
  } finally { await f.instance.dispose(); }
});

it("refuses a rebuild while mid-turn input is parked", async () => {
  let release!: (response: Response) => void;
  const gate = new Promise<Response>(resolve => { release = resolve; });
  const f = await fixture((_body, count) => count < 3 ? answer(`answer ${count}`) : gate);
  try {
    await f.seed();
    const sent = f.send(f.follow);
    await vi.waitFor(() => expect(f.bodies).toHaveLength(3));
    expect(await f.instance.adapter.steer!("t", "Parked peer input")).toBe("steered");
    release(contextError());
    expect(await sent).toMatchObject({ ok: false });
    expect(f.bodies).toHaveLength(3);
  } finally { release?.(contextError()); await f.instance.dispose(); }
});

it("does not rebuild after handling a tool operation", async () => {
  const f = await fixture((_body, count) => count < 3 ? answer(`answer ${count}`) : count === 3 ? new Response(JSON.stringify({ choices: [{
    message: { content: null, tool_calls: [{ id: "question", type: "function", function: { name: "ask_user", arguments: JSON.stringify({ questions: [{ question: "Continue?", options: [{ label: "Yes" }, { label: "No" }] }] }) } }] }, finish_reason: "tool_calls",
  }] }), { headers: { "content-type": "application/json" } }) : contextError());
  f.instance.adapter.onEvent(event => {
    if (event.type === "request.opened") void f.instance.adapter.respondToRequest(event.threadId, event.requestId!, { behavior: "answer", message: "Yes" });
  });
  try {
    await f.seed();
    expect(await f.send(f.follow)).toMatchObject({ ok: false });
    expect(f.bodies).toHaveLength(4);
    expect(f.bodies[3].messages.find((m: any) => m.role === "tool").content).toContain("Yes");
    expect(f.events.some(event => event.type === "request.resolved" && event.behavior === "answer")).toBe(true);
  } finally { await f.instance.dispose(); }
});


it.each([false, true])("restarts image accounting for a rebuilt request and charges later screenshots (%s)", async screenshot => {
  const directory = mkdtempSync(join(tmpdir(), "omb-context-image-"));
  const imagePath = join(directory, "pixel.png");
  // A valid one-pixel PNG with a large ancillary text chunk exercises the
  // encoded budget without requiring a decoder or a provider with vision.
  const pixel = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==", "base64");
  const data = Buffer.concat([Buffer.from("Fixture\0"), Buffer.alloc(Math.ceil(CHAT_IMAGE_BUDGET * 0.55 * 3 / 4), "x")]);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length);
  chunk.write("tEXt", 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  const png = Buffer.concat([pixel.subarray(0, -12), chunk, pixel.subarray(-12)]);
  writeFileSync(imagePath, png);
  const image = chatImage({ mimeType: "image/png", data: png.toString("base64") });
  expect(image.image_url.url.length).toBeGreaterThan(CHAT_IMAGE_BUDGET / 2);
  expect(image.image_url.url.length).toBeLessThan(CHAT_IMAGE_BUDGET);
  const helper = join(directory, "screenshot.mjs");
  writeFileSync(helper, `
    import { readFileSync } from "node:fs";
    import { createInterface } from "node:readline";
    const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
    createInterface({ input: process.stdin }).on("line", line => {
      const request = JSON.parse(line);
      if (request.method === "initialize") send(request.id, { protocolVersion: "2024-11-05", capabilities: { tools: {} } });
      else if (request.method === "tools/list") send(request.id, { tools: [{ name: "capture", description: "Synthetic screenshot", inputSchema: { type: "object", properties: {}, additionalProperties: false } }] });
      else if (request.method === "tools/call") send(request.id, { content: [{ type: "image", mimeType: "image/png", data: readFileSync(process.argv[2]).toString("base64") }] });
    });
  `);
  const defaults: Partial<SendTurnInput> = screenshot ? { approvalMode: "full",
    integrations: { custom: { shot: { command: process.execPath, args: [helper, imagePath], env: {} } } } } : {};
  const f = await fixture((_body, count) => {
    if (count === 3) return contextError();
    if (count === 4 && screenshot) return new Response(JSON.stringify({ choices: [{ message: { content: null, tool_calls: [{
      id: "capture", type: "function", function: { name: "shot_capture", arguments: "{}" },
    }] }, finish_reason: "tool_calls" }] }), { headers: { "content-type": "application/json" } });
    return answer(`answer ${count}`);
  }, defaults);
  try {
    await f.seed();
    expect(await f.send({ ...f.follow, images: [{ path: imagePath, mime: "image/png", bytes: png.length }] })).toMatchObject({ ok: !screenshot });
    expect(f.bodies).toHaveLength(4);
    for (const request of f.bodies.slice(2)) {
      const images = request.messages.flatMap((message: any) => Array.isArray(message.content)
        ? message.content.filter((part: any) => part.type === "image_url") : []);
      expect(images).toEqual([image]);
    }
    if (screenshot) {
      expect(f.events.filter(event => event.type === "item.started" && event.itemType === "tool")).toHaveLength(1);
      const budget = chatImageBudget();
      budget([image]);
      let refusal: string | undefined;
      try { budget([image]); } catch (error) { refusal = (error as Error).message; }
      expect(refusal).toBeDefined();
      expect(f.events.some(event => event.type === "runtime.error" && event.message === refusal)).toBe(true);
    }
  } finally { await f.instance.dispose(); rmSync(directory, { recursive: true, force: true }); }
}, 30_000);
