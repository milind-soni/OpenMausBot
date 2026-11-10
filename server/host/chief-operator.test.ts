import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, it } from "vitest";

import { DATA_DIR, loadConfig, parseConfigPatch, saveConfig, type AppConfig } from "../config.ts";
import { Store, type BotRecord } from "../store.ts";
import { chiefOperatorBotIdentity, cleanChiefOperatorBot, createChiefOperatorHost } from "./chief-operator.ts";

beforeEach(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  mkdirSync(DATA_DIR, { recursive: true });
});

it.each([undefined, ""])("restores the language override's presence in persisted and live config: %s", (language) => {
  const cfg: AppConfig = language === undefined ? {} : { language };
  const file = join(DATA_DIR, "config.json");
  writeFileSync(file, JSON.stringify(cfg));
  const operator = createChiefOperatorHost({ dataDir: DATA_DIR, config: () => cfg,
    bot: () => ({ id: "chief", threadId: "thread", createdAt: 1 }),
    changed: () => {} });
  operator.appoint({ botId: "chief", read: ["language"], write: ["language"], expectedRevision: "none" }, "owner@example.test");
  const source = { botId: "chief", threadId: "thread", generation: "turn" };
  const preview = operator.preview({ ...source, setting: "language", value: "fr" });
  const applied = operator.apply({ ...source, previewId: preview.previewId, expectedRevision: preview.revision, active: () => true });
  expect(cfg.language).toBe("fr");
  operator.rollback({ botId: "chief", receiptId: applied.receiptId, expectedRevision: applied.revision, active: () => true });
  const disk = JSON.parse(readFileSync(file, "utf8"));
  expect({ present: Object.hasOwn(disk, "language"), value: disk.language }).toEqual({ present: language !== undefined, value: language });
  expect({ present: Object.hasOwn(cfg, "language"), value: cfg.language }).toEqual({ present: language !== undefined, value: language });
});

it("keeps the appointment across conversation creation, task selection and reload", () => {
  const store = new Store(() => ({ instanceId: "claude", model: "fixture" }));
  const bot = store.createBot({ name: "Operator" });
  const originalThread = bot.threadId;
  const cfg: AppConfig = {};
  const operator = createChiefOperatorHost({ dataDir: DATA_DIR, config: () => cfg, bot: id => store.bot(id), changed: () => {} });
  store.onChange(change => { if (change.type === "bot" || change.type === "bot.deleted") cleanChiefOperatorBot(operator, change.botId); });
  const grant = operator.appoint({ botId: bot.id, read: ["language"], write: ["language"], expectedRevision: "none" }, "owner@example.test");
  const identity = chiefOperatorBotIdentity(bot);
  const next = store.createTask(bot.id, "Another conversation")!;
  expect(bot.threadId).toBe(next.threadId);
  expect(operator.isAppointed(bot.id)).toBe(true);
  expect(chiefOperatorBotIdentity(bot)).toBe(identity);
  store.switchTask(bot.id, originalThread);
  expect(operator.appointment().revision).toBe(grant.revision);
  const loaded = new Store(() => ({ instanceId: "claude", model: "fixture" }));
  expect(createChiefOperatorHost({ dataDir: DATA_DIR, config: () => cfg, bot: id => loaded.bot(id), changed: () => {} }).isAppointed(bot.id)).toBe(true);
});

it.each<Partial<BotRecord>>([
  { createdBy: "another@example.test" }, { reportsTo: "another@example.test" }, { section: "Engineering" },
  { visibility: "admins" }, { hidden: true }, { createdAt: 2 },
  { movedTo: { team: { id: "team", name: "Other team" }, state: "moved", at: 2 } },
])("revokes an appointment when stable ownership or audience changes: %j", patch => {
  const store = new Store(() => ({ instanceId: "claude", model: "fixture" }));
  const bot = store.createBot({ name: "Operator" });
  const operator = createChiefOperatorHost({ dataDir: DATA_DIR, config: () => ({}), bot: id => store.bot(id), changed: () => {} });
  store.onChange(change => { if (change.type === "bot" || change.type === "bot.deleted") cleanChiefOperatorBot(operator, change.botId); });
  operator.appoint({ botId: bot.id, read: ["language"], write: ["language"], expectedRevision: "none" }, "owner@example.test");
  store.patchBot(bot.id, patch);
  expect(operator.isAppointed(bot.id)).toBe(false);
  expect(operator.appointment()).toMatchObject({ grant: null, revision: "none" });
  expect(operator.appointment().audit.at(-1)).toMatchObject({ decision: "identity-lost" });
});

it.each(["language", "computerName"] as const)("blocks stale rollback after ordinary config API ABA and host restart: %s", setting => {
  saveConfig({ language: "en", computerName: "Work Mac" });
  const cfg = loadConfig();
  const deps = { dataDir: DATA_DIR, config: () => cfg, bot: () => ({ id: "chief", threadId: "thread", createdAt: 1 }), changed: () => {} };
  const operator = createChiefOperatorHost(deps);
  operator.appoint({ botId: "chief", read: [setting], write: [setting], expectedRevision: "none" }, "owner@example.test");
  const source = { botId: "chief", threadId: "thread", generation: "turn" };
  const preview = operator.preview({ ...source, setting, value: "fr" });
  const applied = operator.apply({ ...source, previewId: preview.previewId, expectedRevision: preview.revision, active: () => true });
  for (const value of ["de", "fr"]) {
    saveConfig(parseConfigPatch({ [setting]: value }));
    Object.assign(cfg, loadConfig());
  }
  const restarted = createChiefOperatorHost(deps);
  const bytes = () => ["config.json", "chief-operator.json"].map(file => readFileSync(join(DATA_DIR, file), "utf8"));
  const before = bytes();
  expect(() => restarted.rollback({ botId: "chief", receiptId: applied.receiptId, expectedRevision: restarted.describe("chief").settings[0].revision, active: () => true })).toThrow(/setting changed/);
  expect(bytes()).toEqual(before);
  expect(cfg[setting]).toBe("fr");
});

it("preserves a valid rollback across unrelated ordinary config writes and host restart", () => {
  saveConfig({ language: "en" });
  const cfg = loadConfig();
  const deps = { dataDir: DATA_DIR, config: () => cfg, bot: () => ({ id: "chief", createdAt: 1 }), changed: () => {} };
  const operator = createChiefOperatorHost(deps);
  operator.appoint({ botId: "chief", read: ["language"], write: ["language"], expectedRevision: "none" }, "owner@example.test");
  const source = { botId: "chief", threadId: "thread", generation: "turn" };
  const preview = operator.preview({ ...source, setting: "language", value: "fr" });
  const applied = operator.apply({ ...source, previewId: preview.previewId, expectedRevision: preview.revision, active: () => true });
  saveConfig(parseConfigPatch({ computerName: "Office Mac" }));
  Object.assign(cfg, loadConfig());
  const restarted = createChiefOperatorHost(deps);
  expect(restarted.rollback({ botId: "chief", receiptId: applied.receiptId, expectedRevision: restarted.describe("chief").settings[0].revision, active: () => true })).toMatchObject({ state: "applied", after: "en" });
  expect(cfg).toMatchObject({ language: "en", computerName: "Office Mac" });
  expect(loadConfig()).toMatchObject({ language: "en", computerName: "Office Mac" });
});
