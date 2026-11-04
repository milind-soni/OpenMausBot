import { z } from "zod";

import { claudeUserMcpEnabled, DATA_DIR, type AppConfig } from "../config.ts";
import { lookForGrokBot, removeOldCursorSignIn } from "../grok-local.ts";
import { applySetupImport, detectSetup, thisMachine, type SetupHost, type SetupMachine } from "../setup-import.ts";
import type { BusyFlag } from "./config.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface SetupImportRouteDeps {
  /** True only on the desktop app's own server. Never on `openmausbot serve`, where any local process, a bot's shell
   * among them, is the owner's loopback; nor on a Cloud home or a hosted organization server, whose files are not the
   * person's own. */
  local: boolean;
  cfg: Pick<AppConfig, "mcpServers" | "features">;
  mcpConfigBusy: BusyFlag;
  mcpPolicyRefusal(name: string, server: object): string | undefined;
  persistMcpServers(next: Record<string, unknown>): void;
  /** The computer whose files are read; tests point it at a fixture home. */
  machine?: () => SetupMachine;
  dataDir?: string;
}

export const SETUP_IMPORT_PATH = "/api/setup-import";
export const GROK_LOOK_PATH = "/api/setup-import/grok";
const LOCAL_ONLY = "Only the desktop app on the computer running OpenMausBot can bring in that computer's skills and tools.";
const requestSchema = z.object({ skills: z.boolean().optional(), tools: z.boolean().optional() }).strict();

/** GET finds what is new here; POST brings in the chosen kinds. Only the owner's own loopback, never a paired device,
 * a browser elsewhere, a bot's shell on a service server, a Cloud home or a hosted server. */
export function createSetupImportRoutes(deps: SetupImportRouteDeps): RouteHandler {
  removeOldCursorSignIn(deps.dataDir ?? DATA_DIR);
  const machine = deps.machine ?? thisMachine;
  const host: SetupHost = {
    mcpServers: () => deps.cfg.mcpServers ?? {},
    mcpPolicyRefusal: deps.mcpPolicyRefusal,
    persistMcpServers: deps.persistMcpServers,
    mcpConfigBusy: deps.mcpConfigBusy,
    claudeUserMcp: () => claudeUserMcpEnabled(deps.cfg),
  };
  return async ({ req, res, path, method, auth, json, readBody }) => {
    if (path === GROK_LOOK_PATH) {
      if (method !== "GET") return json(res, 405, { error: "method not allowed" });
      if (!deps.local || auth.kind !== "loopback" || auth.trust === "service") return json(res, 403, { error: LOCAL_ONLY });
      res.setHeader("Cache-Control", "no-store");
      return json(res, 200, lookForGrokBot(machine()));
    }
    if (path !== SETUP_IMPORT_PATH) return PASS;
    if (method !== "GET" && method !== "POST") return json(res, 405, { error: "method not allowed" });
    if (!deps.local || auth.kind !== "loopback" || auth.trust === "service") return json(res, 403, { error: LOCAL_ONLY });
    res.setHeader("Cache-Control", "no-store");
    if (method === "GET") return json(res, 200, detectSetup(machine(), host));
    if (!String(req.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
      return json(res, 415, { error: "content-type must be application/json" });
    }
    const parsed = requestSchema.safeParse(await readBody(req, 4_096));
    if (!parsed.success || (!parsed.data.skills && !parsed.data.tools)) {
      return json(res, 400, { error: "Choose skills, tools or both." });
    }
    return json(res, 200, applySetupImport(machine(), host, parsed.data));
  };
}
