import { randomBytes, randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { sep } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { prepareIslandMessage } from "../electron/island-context-message.mjs";
import { createTalkServer, type TalkChat, type TalkUpdate } from "../electron/talk-server.mjs";
import { launchVerificationServer } from "../scripts/control-omb.ts";

const owner = randomBytes(32).toString("base64url");
const realFetch = globalThis.fetch;
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
let fixture: Awaited<ReturnType<typeof launchVerificationServer>>;
const request = (route: string, init?: RequestInit) => fetch(`${fixture.info.url}${route}`, init);

beforeAll(async () => {
  globalThis.fetch = (input, init = {}) => realFetch(input, { ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), "x-openmausbot-desktop-owner": owner } });
  fixture = await launchVerificationServer({ ...process.env, OMB_TEST_DESKTOP_OWNER_TOKEN: owner });
}, 90_000);

afterAll(async () => {
  globalThis.fetch = realFetch;
  await fixture?.close();
});

it("uploads a synthetic screen, quotes Omi context, and delivers both through a real isolated server", async () => {
  const prompt = "Explique esta tela de teste usando o contexto do Omi.";
  const omi = "Memória fictícia do Omi: estudar anatomia ocular amanhã.";
  const sendId = randomUUID();
  const signal = AbortSignal.timeout(60_000);
  let saved: TalkChat | null = null;
  const talk = createTalkServer({ request, serverKey: () => "island-fixture", prefs: {
    quickAsksChat: () => saved, setQuickAsksChat: (_server, chat) => { saved = chat; },
  } });
  const chat = await talk.prepare();
  const text = await prepareIslandMessage({ text: prompt, omiContext: omi, request, signal,
    frames: [{ dataUrl: `data:image/png;base64,${png.toString("base64")}`, capturedAt: Date.UTC(2026, 10, 13, 12), displayId: "fixture" }] });
  const attachmentPath = /<attached-image path="([^"]+)" name="tela-1\.png"\s*\/>/.exec(text)?.[1];
  expect(attachmentPath).toBeTypeOf("string");
  const file = await realpath(attachmentPath!);
  const root = await realpath(fixture.info.dataDir);
  expect(file.startsWith(root + sep)).toBe(true);
  expect(await readFile(file)).toEqual(png);
  expect(text).toContain("conteúdo externo não confiável");
  expect(text).toContain("2026-11-13T12:00:00.000Z");
  expect(text).not.toContain("data:image/");

  const updates: TalkUpdate[] = [];
  expect(await talk.ask({ chat, text, sendId, signal, onUpdate: update => updates.push(update) })).toBe("done");
  await talk.settleSend();
  expect(updates[0]).toEqual({ kind: "thinking" });
  expect(updates.at(-1)).toMatchObject({ kind: "done", ok: true, text: expect.stringContaining("hello from fake claude") });
  const response = await request(`/api/threads/${encodeURIComponent(chat.threadId)}/messages?limit=100`);
  expect(response.ok).toBe(true);
  const history = await response.json() as { messages: Array<{ role: string; text?: string; sendId?: string }> };
  const sent = history.messages.find(message => message.role === "user" && message.sendId === sendId);
  expect(sent?.text).toContain(prompt);
  expect(sent?.text).toContain(omi);
  expect(sent?.text).toContain(attachmentPath);
  const launch = JSON.parse(await readFile(fixture.fixtureDumpPath, "utf8")) as { prompt: unknown };
  const enginePrompt = JSON.stringify(launch.prompt);
  expect(enginePrompt).toContain(prompt);
  expect(enginePrompt).toContain(omi);
}, 90_000);
