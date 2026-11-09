import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appointmentSchema, ChiefOperator, OperatorRefusal } from "./chief-operator.ts";
import type { AppConfig } from "./config.ts";

function fixture(run: (f: { operator: ChiefOperator; cfg: AppConfig; file: string; dataDir: string; identity(value: string | null): void; ownerActive(value: boolean): void }) => void): void {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-chief-operator-"));
  const file = join(dataDir, "config.json");
  const cfg: AppConfig = { language: "en", computerName: "Work Mac" };
  writeFileSync(file, JSON.stringify(cfg));
  let botIdentity: string | null = "bot-incarnation:owner:private";
  let ownerIsActive = true;
  const operator = new ChiefOperator({ dataDir, config: () => cfg,
    botIdentity: (id) => id === "chief" ? botIdentity : null,
    ownerActive: () => ownerIsActive,
    writeSetting: (setting, value) => { cfg[setting] = value; writeFileSync(file, JSON.stringify(cfg)); },
    changed: () => {},
  });
  try { run({ operator, cfg, file, dataDir, identity: (value) => { botIdentity = value; }, ownerActive: (value) => { ownerIsActive = value; } }); }
  finally { rmSync(dataDir, { recursive: true, force: true }); }
}

const source = { botId: "chief", threadId: "chief-thread", generation: "turn-1" };

describe("Chief Operator", () => {
  it("is opt-in, owner-appointed, and keeps read and write scopes independent", () => fixture(({ operator }) => {
    expect(operator.isAppointed("chief")).toBe(false);
    expect(() => operator.describe("chief")).toThrow(OperatorRefusal);
    const { revision } = operator.appoint({ botId: "chief", read: ["language"], write: ["computerName"], expectedRevision: "none" }, "owner@example.test");
    expect(operator.isAppointed("chief")).toBe(true);
    expect(operator.describe("chief")).toMatchObject({ read: ["language"], write: ["computerName"], settings: [{ setting: "language", value: "en" }] });
    expect(() => operator.preview({ ...source, setting: "language", value: "fr" })).toThrow(/outside this bot's write scope/);
    const preview = operator.preview({ ...source, setting: "computerName", value: "Office Mac" });
    expect(preview).not.toHaveProperty("before");
    expect(operator.apply({ ...source, previewId: preview.previewId, expectedRevision: preview.revision, active: () => true })).toMatchObject({ state: "applied", after: "Office Mac" });
    expect(() => operator.rollback({ botId: "chief", receiptId: operator.appointment().audit.at(-1)!.id, expectedRevision: "anything", active: () => true })).toThrow(/outside this bot's read scope/);
    expect(operator.appointment().revision).toBe(revision);
  }));

  it("uses a one-turn preview, rejects stale config and revocation, and persists an applied receipt", () => fixture(({ operator, cfg, file, dataDir }) => {
    operator.appoint({ botId: "chief", read: ["language"], write: ["language"], expectedRevision: "none" }, "owner@example.test");
    const preview = operator.preview({ ...source, setting: "language", value: "fr" });
    writeFileSync(file, JSON.stringify({ ...cfg, computerName: "Another Mac" }));
    expect(() => operator.apply({ ...source, previewId: preview.previewId, expectedRevision: preview.revision, active: () => true })).toThrow(/configuration changed/);
    expect(cfg.language).toBe("en");
    const next = operator.preview({ ...source, setting: "language", value: "fr" });
    expect(() => operator.apply({ ...source, previewId: next.previewId, expectedRevision: next.revision, active: () => false })).toThrow(/turn ended/);
    const current = operator.preview({ ...source, setting: "language", value: "fr" });
    const receipt = operator.apply({ ...source, previewId: current.previewId, expectedRevision: current.revision, active: () => true });
    expect(cfg.language).toBe("fr");
    expect(operator.appointment().audit.at(-1)).toMatchObject({ id: receipt.receiptId, owner: "owner@example.test", botId: "chief", setting: "language", before: "en", after: "fr", state: "applied" });
    const restarted = new ChiefOperator({ dataDir, config: () => cfg, botIdentity: () => "bot-incarnation:owner:private", writeSetting: () => {}, changed: () => {} });
    expect(restarted.appointment().audit.at(-1)?.id).toBe(receipt.receiptId);
  }));

  it("revalidates role, bot identity and visibility at execution and revokes lost identities", () => fixture(({ operator, cfg, identity }) => {
    const grant = operator.appoint({ botId: "chief", read: ["language"], write: ["language"], expectedRevision: "none" }, "owner@example.test");
    const preview = operator.preview({ ...source, setting: "language", value: "fr" });
    identity("bot-incarnation:owner:shared");
    expect(operator.isAppointed("chief")).toBe(false);
    expect(() => operator.apply({ ...source, previewId: preview.previewId, expectedRevision: preview.revision, active: () => true })).toThrow(/not the appointed/);
    expect(cfg.language).toBe("en");
    operator.revokeIfIdentityLost("chief");
    identity("bot-incarnation:owner:private");
    expect(operator.isAppointed("chief")).toBe(false);
    expect(operator.appointment().revision).toBe("none");
    expect(operator.appointment().audit.at(-1)).toMatchObject({ actor: "system", decision: "identity-lost" });
    expect(() => operator.appoint({ botId: "chief", read: ["language"], write: [], expectedRevision: grant.revision }, "owner@example.test")).toThrow(/appointment changed/);
  }));

  it("refuses a demoted appointing owner while leaving ordinary bot data untouched", () => fixture(({ operator, cfg, ownerActive }) => {
    operator.appoint({ botId: "chief", read: ["language"], write: ["language"], expectedRevision: "none" }, "owner@example.test");
    const preview = operator.preview({ ...source, setting: "language", value: "fr" });
    ownerActive(false);
    expect(operator.isAppointed("chief")).toBe(false);
    expect(() => operator.apply({ ...source, previewId: preview.previewId, expectedRevision: preview.revision, active: () => true })).toThrow(/not the appointed/);
    expect(cfg.language).toBe("en");
  }));

  it("rolls back only with the same grant, both scopes and unchanged current value", () => fixture(({ operator, cfg }) => {
    const grant = operator.appoint({ botId: "chief", read: ["language"], write: ["language"], expectedRevision: "none" }, "owner@example.test");
    const preview = operator.preview({ ...source, setting: "language", value: "fr" });
    const applied = operator.apply({ ...source, previewId: preview.previewId, expectedRevision: preview.revision, active: () => true });
    expect(() => operator.rollback({ botId: "chief", receiptId: applied.receiptId, expectedRevision: preview.revision, active: () => true })).toThrow(/configuration changed/);
    const restored = operator.rollback({ botId: "chief", receiptId: applied.receiptId, expectedRevision: applied.revision, active: () => true });
    expect(restored).toMatchObject({ state: "applied", after: "en" });
    expect(cfg.language).toBe("en");
    operator.revoke(grant.revision, "owner@example.test");
    expect(() => operator.rollback({ botId: "chief", receiptId: applied.receiptId, expectedRevision: restored.revision, active: () => true })).toThrow(/not the appointed/);
  }));

  it.each([false, true])("P2 rejects same-setting ABA rollback, including after restart=%s", (restart) => fixture(({ operator, cfg, file, dataDir }) => {
    operator.appoint({ botId: "chief", read: ["language"], write: ["language"], expectedRevision: "none" }, "owner@example.test");
    const receipts = ["fr", "de", "fr"].map(value => {
      const preview = operator.preview({ ...source, setting: "language", value });
      return operator.apply({ ...source, previewId: preview.previewId, expectedRevision: preview.revision, active: () => true });
    });
    const current = restart ? new ChiefOperator({ dataDir, config: () => cfg, botIdentity: () => "bot-incarnation:owner:private",
      writeSetting: (setting, value) => { cfg[setting] = value; writeFileSync(file, JSON.stringify(cfg)); }, changed: () => {} }) : operator;
    const before = [readFileSync(file, "utf8"), readFileSync(join(dataDir, "chief-operator.json"), "utf8")];
    expect(() => current.rollback({ botId: "chief", receiptId: receipts[0].receiptId, expectedRevision: current.describe("chief").settings[0].revision, active: () => true })).toThrow(/setting changed/);
    expect(cfg.language).toBe("fr");
    expect([readFileSync(file, "utf8"), readFileSync(join(dataDir, "chief-operator.json"), "utf8")]).toEqual(before);
    expect(current.rollback({ botId: "chief", receiptId: receipts[2].receiptId, expectedRevision: current.describe("chief").settings[0].revision, active: () => true }).after).toBe("de");
  }));

  it("P2 preserves rollback across unrelated settings and failed receipts, and refuses a trimmed receipt", () => fixture(({ operator, cfg, dataDir }) => {
    operator.appoint({ botId: "chief", read: ["language", "computerName"], write: ["language", "computerName"], expectedRevision: "none" }, "owner@example.test");
    const change = (setting: "language" | "computerName", value: string) => {
      const preview = operator.preview({ ...source, setting, value });
      return operator.apply({ ...source, previewId: preview.previewId, expectedRevision: preview.revision, active: () => true });
    };
    const first = change("language", "fr");
    change("computerName", "Office Mac");
    const auditFile = join(dataDir, "chief-operator.json");
    const state = JSON.parse(readFileSync(auditFile, "utf8"));
    state.audit.push({ ...state.audit[1], id: randomUUID(), state: "failed" });
    writeFileSync(auditFile, JSON.stringify(state));
    expect(operator.rollback({ botId: "chief", receiptId: first.receiptId, expectedRevision: operator.describe("chief").settings[0].revision, active: () => true }).after).toBe("en");
    expect(cfg.computerName).toBe("Office Mac");
    const old = change("language", "fr");
    const retained = JSON.parse(readFileSync(auditFile, "utf8"));
    retained.audit.push(...Array.from({ length: 1_000 }, () => ({ ...retained.audit[0], id: randomUUID() })));
    writeFileSync(auditFile, JSON.stringify(retained));
    change("computerName", "Another Mac");
    expect(JSON.parse(readFileSync(auditFile, "utf8")).audit).toHaveLength(1_000);
    expect(() => operator.rollback({ botId: "chief", receiptId: old.receiptId, expectedRevision: operator.describe("chief").settings[0].revision, active: () => true })).toThrow(/No reversible receipt/);
    expect(cfg.language).toBe("fr");
  }));

  it("rejects unsupported settings and bounds the owner audit response", () => fixture(({ operator, dataDir }) => {
    expect(appointmentSchema.safeParse({ botId: "chief", read: ["openai"], write: [], expectedRevision: "none" }).success).toBe(false);
    let revision = "none";
    for (let n = 0; n < 105; n += 1) revision = operator.appoint({ botId: "chief", read: ["language"], write: [], expectedRevision: revision }, "owner@example.test").revision;
    expect(operator.appointment().audit).toHaveLength(100);
    expect(operator.appointment().auditHasMore).toBe(true);
    expect(JSON.stringify(operator.appointment())).not.toContain("secret");
    expect(JSON.parse(readFileSync(join(dataDir, "chief-operator.json"), "utf8")).audit.length).toBe(105);
  }));

  it("accepts multilingual computer names but rejects invisible and control characters", () => fixture(({ operator }) => {
    operator.appoint({ botId: "chief", read: [], write: ["computerName"], expectedRevision: "none" }, "owner@example.test");
    expect(operator.preview({ ...source, setting: "computerName", value: "辦公室 Mac 🖥️" }).after).toBe("辦公室 Mac 🖥️");
    for (const name of ["Office\u0085Mac", "Office\u202eMac", "Office\u200bMac", "Office\u2028Mac"]) {
      expect(() => operator.preview({ ...source, setting: "computerName", value: name })).toThrow(/printable characters/);
    }
  }));

  it("keeps old pending receipts visible to the owner and blocks subsequent apply and rollback", () => fixture(({ operator, cfg, dataDir }) => {
    operator.appoint({ botId: "chief", read: ["language"], write: ["language"], expectedRevision: "none" }, "owner@example.test");
    const first = operator.preview({ ...source, setting: "language", value: "fr" });
    const applied = operator.apply({ ...source, previewId: first.previewId, expectedRevision: first.revision, active: () => true });
    const file = join(dataDir, "chief-operator.json");
    const state = JSON.parse(readFileSync(file, "utf8"));
    const pending = { id: randomUUID(), at: new Date().toISOString(), actor: "chief", action: "apply", botId: "chief", owner: "owner@example.test", setting: "language", before: "fr", after: "de", state: "pending", decision: "scope-allowed", grantId: state.grant.id, revision: applied.revision };
    state.audit.push(pending, ...Array.from({ length: 105 }, () => ({ ...state.audit[0], id: randomUUID() })));
    writeFileSync(file, JSON.stringify(state));
    const inspection = operator.appointment();
    expect(inspection.audit.some(row => row.id === pending.id)).toBe(false);
    expect(inspection.pending).toMatchObject([{ id: pending.id, state: "pending" }]);
    expect(operator.describe("chief").settings[0]).toMatchObject({ value: "fr" });
    const next = operator.preview({ ...source, setting: "language", value: "de" });
    expect(() => operator.apply({ ...source, previewId: next.previewId, expectedRevision: next.revision, active: () => true })).toThrow(/receipt is still pending/);
    expect(() => operator.rollback({ botId: "chief", receiptId: applied.receiptId, expectedRevision: applied.revision, active: () => true })).toThrow(/receipt is still pending/);
    expect(cfg.language).toBe("fr");
  }));

  it("bounds pending receipts without applying another change", () => fixture(({ operator, cfg, dataDir }) => {
    operator.appoint({ botId: "chief", read: ["language"], write: ["language"], expectedRevision: "none" }, "owner@example.test");
    const file = join(dataDir, "chief-operator.json");
    const state = JSON.parse(readFileSync(file, "utf8"));
    state.audit.push(...Array.from({ length: 100 }, () => ({ ...state.audit[0], id: randomUUID(), state: "pending" })));
    writeFileSync(file, JSON.stringify(state));
    expect(operator.appointment().pending).toHaveLength(100);
    const preview = operator.preview({ ...source, setting: "language", value: "fr" });
    expect(() => operator.apply({ ...source, previewId: preview.previewId, expectedRevision: preview.revision, active: () => true })).toThrow(/receipt is still pending/);
    expect(cfg.language).toBe("en");
    expect(JSON.parse(readFileSync(file, "utf8")).audit).toHaveLength(101);
    state.audit.push({ ...state.audit[0], id: randomUUID(), state: "pending" });
    writeFileSync(file, JSON.stringify(state));
    expect(() => operator.appointment()).toThrow(/unreadable/);
  }));
});
