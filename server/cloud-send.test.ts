import { describe, expect, it } from "vitest";
import { BOT_PARTS, EMPTY, PICTURE_PART, itemKey } from "../electron/cloud-send-parts.mjs";
import { botParts, cloudSendSummary, partHash, unused, type CloudSendSources } from "./cloud-send.ts";
import { keptBotIds } from "./routes/bots-create.ts";
import type { BotRecord } from "./store.ts";

const bot = (extra: Partial<BotRecord> = {}): BotRecord => ({
  id: "ember-0001", threadId: "thread-0001", name: "Ember", title: "", description: "", soul: "Be brief.", notifications: true, color: "blue",
  unread: false, modelSelection: { instanceId: "claude", model: "claude-sonnet-5" }, resumeCursors: {}, createdAt: 1, tasks: [{ threadId: "thread-0001" }],
  ...extra,
} as unknown as BotRecord);

const sources = (extra: Partial<CloudSendSources> = {}): CloudSendSources => ({
  appVersion: "0.1.117",
  bots: () => [bot()],
  greetingOnly: () => false,
  skills: () => [{ name: "weekly-summary", sha256: "a".repeat(64), enabled: true }],
  picture: () => new Uint8Array([1, 2, 3]),
  logins: () => [{ id: "l1", site: "example.test", hosts: ["accounts.example.test"], exactHost: false, username: "Alice", updatedAt: 5 }],
  onePassword: () => ({ connectedAt: 7, grants: { v1: ["ember-0001"] } }),
  settings: () => ({ profile: { name: "Amit", aboutMe: "Solo developer." }, language: undefined }),
  ...extra,
});

describe("what a server reports for Send to My Cloud", () => {
  it("hashes each part of a bot on its own, and says '-' for a part it has no value for", () => {
    const parts = botParts(bot(), () => null);
    expect(Object.keys(parts).sort()).toEqual([...Object.keys(BOT_PARTS), PICTURE_PART].sort());
    expect(parts[PICTURE_PART]).toBe(EMPTY);
    const changed = botParts(bot({ soul: "Be very brief." }), () => null);
    expect(Object.entries(changed).filter(([part, hash]) => parts[part] !== hash).map(([part]) => part)).toEqual(["soul"]);
    expect(botParts(bot({ voice: "" }), () => null).voice).toBe(parts.voice);
    expect(partHash(undefined)).toBe(EMPTY);
    expect(partHash({ a: null, b: [] })).toBe(EMPTY);
    expect(partHash({ b: 1, a: 2 })).toBe(partHash({ a: 2, b: 1 }));
    // A working folder is this computer's: it is not part of what is compared.
    expect(botParts(bot({ cwd: "/Users/amit/work" }), () => null)).toEqual(parts);
  });

  it("lists bots, their skills, logins, 1Password and settings, without a secret or a picture's bytes", () => {
    const summary = cloudSendSummary(sources());
    expect(summary.items.map((item) => item.key)).toEqual([
      itemKey.bot("ember-0001"), itemKey.skill("ember-0001", "weekly-summary"), itemKey.login("example.test", "alice"), "1password",
      itemKey.setting("profile"), itemKey.setting("language"),
    ]);
    expect(summary.items.find((item) => item.kind === "login")).toMatchObject({ label: "accounts.example.test", detail: "Alice", id: "l1" });
    expect(summary.items.find((item) => item.key === "setting:language")!.parts).toEqual({ value: EMPTY });
    expect(summary.items.find((item) => item.key === "setting:profile")!.parts.email).toBe(EMPTY);
    const text = JSON.stringify(summary);
    for (const secret of ["Be brief.", "Solo developer.", "Amit", "AQID"]) expect(text).not.toContain(secret);
  });

  it("leaves out a bot nobody has touched since it was made, so a fresh install's starter never lands beside My Cloud's own", () => {
    const starter = bot({ soul: "" });
    expect(unused(starter, 0, () => true)).toBe(true);
    expect(unused(starter, 0, () => true, (botId) => botId === starter.id), "a starter put in a room is in use").toBe(false);
    expect(unused(starter, 0, () => false)).toBe(false);
    expect(unused(starter, 1, () => true)).toBe(false);
    expect(unused(bot({ soul: "", title: "Research" }), 0, () => true)).toBe(false);
    expect(cloudSendSummary(sources({ bots: () => [starter], greetingOnly: () => true, skills: () => [] })).items.some((item) => item.kind === "bot")).toBe(false);
  });

  it("keys a login kept to one exact host apart from another account on the same site", () => {
    const summary = cloudSendSummary(sources({ logins: () => [
      { id: "l1", site: "example.test", hosts: ["a.example.test"], exactHost: true, username: "ops", updatedAt: 1 },
      { id: "l2", site: "example.test", hosts: ["b.example.test"], exactHost: true, username: "ops", updatedAt: 1 },
    ] }));
    expect(summary.items.filter((item) => item.kind === "login").map((item) => item.key))
      .toEqual(["login:example.test|ops|a.example.test", "login:example.test|ops|b.example.test"]);
  });
});

describe("a bot sent from the person's other computer keeps its id", () => {
  const store = { bot: (id: string) => (id === "taken-0001" ? ({} as BotRecord) : null), botByThread: (id: string) => (id === "thread-taken" ? ({} as BotRecord) : null), groupByThread: () => undefined };
  it("takes the server's own id form, only while nothing here uses it", () => {
    expect(keptBotIds({}, store)).toEqual({});
    expect(keptBotIds({ id: "ember-0001", threadId: "thread-0001" }, store)).toEqual({ id: "ember-0001", threadId: "thread-0001" });
    expect(keptBotIds({ id: "ember-0001" }, store)).toEqual({ id: "ember-0001" });
    expect(keptBotIds({ id: "taken-0001" }, store)).toEqual({ error: "a bot with this id already exists here" });
    expect(keptBotIds({ id: "ember-0001", threadId: "thread-taken" }, store)).toEqual({ error: "this conversation id is already used here" });
    expect(keptBotIds({ id: "ember-0001", threadId: "ember-0001" }, store)).toEqual({ error: "this conversation id is already used here" });
    for (const id of ["short", "../../etc/passwd", "x".repeat(129), 42]) expect(keptBotIds({ id }, store)).toHaveProperty("error");
    expect(keptBotIds({ threadId: "thread-0001" }, store)).toHaveProperty("error");
  });
});
