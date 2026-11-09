import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { ChiefOperator } from "../chief-operator.ts";
import type { AppConfig } from "../config.ts";
import { createActingPeople, HandedPeople, type ActingLine } from "../host/acting-person.ts";
import { personKey } from "../person-key.ts";
import { createInternalChiefOperatorRoutes } from "./internal-chief-operator.ts";

it.each([null, personKey({ id: "client-a" }), personKey({ id: "local-owner" })])("P2 requires positive desktop owner provenance: %s", async (requester) => {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-operator-provenance-"));
  const cfg: AppConfig = { language: "en" };
  const operator = new ChiefOperator({ dataDir, config: () => cfg, botIdentity: () => "chief-identity",
    writeSetting: (_setting, value) => { cfg.language = value; }, changed: () => {} });
  try {
    operator.appoint({ botId: "chief", read: ["language"], write: ["language"], expectedRevision: "none" }, "local-owner");
    let status = 0;
    const route = createInternalChiefOperatorRoutes({ operator, botId: "chief", threadId: "thread", generation: "turn", depth: 0,
      direct: true, personTurn: true, guest: false, requester, team: false, cloudHome: false, desktopManaged: true,
      provenCloudOwner: () => false, active: () => true, readBody: async () => ({ action: "preview", setting: "language", value: "fr" }) });
    await route({ req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL("http://127.0.0.1/api/internal/chief-operator"), path: "/api/internal/chief-operator", method: "POST",
      auth: { kind: "loopback", scopes: ["admin", "client"] }, readBody: async () => ({}), json: (_res, code) => { status = code; } });
    expect(status).toBe(requester === personKey({ id: "local-owner" }) ? 200 : 403);
    expect(cfg.language).toBe("en");
    expect(operator.appointment().audit).toHaveLength(1);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});

it.each(["read", "preview", "apply", "rollback"])("rechecks owner provenance after a gated %s body", async action => {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-operator-body-"));
  const cfg: AppConfig = { language: "en" };
  const owner = personKey({ id: "local-owner" });
  const lines: ActingLine[] = [{ id: "ask", at: 1, role: "user", sender: { id: owner } }];
  const people = createActingPeople({ store: { groupByThread: () => undefined, messagesFor: () => lines },
    direct: () => ({ generation: "turn", generations: new Set(["turn"]), messageId: "ask" }),
    roomRun: () => undefined, handed: new HandedPeople(join(dataDir, "handed.json")) });
  const operator = new ChiefOperator({ dataDir, config: () => cfg, botIdentity: () => "chief-identity",
    writeSetting: (_setting, value) => { cfg.language = value; writeFileSync(join(dataDir, "config.json"), JSON.stringify(cfg)); }, changed: () => {} });
  try {
    writeFileSync(join(dataDir, "config.json"), JSON.stringify(cfg));
    operator.appoint({ botId: "chief", read: ["language"], write: ["language"], expectedRevision: "none" }, "local-owner");
    const preview = operator.preview({ botId: "chief", threadId: "thread", generation: "turn", setting: "language", value: "fr" });
    const receipt = action === "rollback" ? operator.apply({ botId: "chief", threadId: "thread", generation: "turn",
      previewId: preview.previewId, expectedRevision: preview.revision, active: () => true }) : null;
    const body = action === "read" ? { action } : action === "preview" ? { action, setting: "language", value: "fr" }
      : action === "apply" ? { action, previewId: preview.previewId, expectedRevision: preview.revision }
        : { action, receiptId: receipt!.receiptId, expectedRevision: receipt!.revision };
    let entered = false;
    let release!: (body: unknown) => void;
    const gate = new Promise<unknown>(resolve => { release = resolve; });
    let status = 0;
    const route = createInternalChiefOperatorRoutes({ operator, botId: "chief", threadId: "thread", generation: "turn", depth: 0,
      direct: true, personTurn: true, guest: false, get requester() { return people.requester("thread", "turn"); },
      team: false, cloudHome: false, desktopManaged: true, provenCloudOwner: () => false, active: () => true,
      readBody: () => { entered = true; return gate; } });
    const bytes = () => ["config.json", "chief-operator.json"].map(file => readFileSync(join(dataDir, file)));
    const before = bytes();
    const response = route({ req: {} as IncomingMessage, res: {} as ServerResponse, url: new URL("http://127.0.0.1/api/internal/chief-operator"),
      path: "/api/internal/chief-operator", method: "POST", auth: { kind: "loopback", scopes: ["admin", "client"] },
      readBody: async () => ({}), json: (_res, code) => { status = code; } });
    expect(entered).toBe(true);
    expect(people.requester("thread", "turn")).toBe(owner);
    lines.push({ id: "steer", at: 2, role: "user", steered: true, sender: { id: personKey({ id: "client" }) } });
    expect(people.requester("thread", "turn")).toBeNull();
    release(body);
    await response;
    expect.soft(status).toBe(403);
    expect(bytes()).toEqual(before);
  } finally { rmSync(dataDir, { recursive: true, force: true }); }
});
