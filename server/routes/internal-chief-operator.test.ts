import { mkdtempSync, rmSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

import { ChiefOperator } from "../chief-operator.ts";
import { personKey } from "../person-key.ts";
import { createInternalChiefOperatorRoutes } from "./internal-chief-operator.ts";

it.each([null, personKey({ id: "client-a" }), personKey({ id: "local-owner" })])("P2 requires positive desktop owner provenance: %s", async (requester) => {
  const dataDir = mkdtempSync(join(tmpdir(), "omb-operator-provenance-"));
  const cfg = { language: "en" };
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
