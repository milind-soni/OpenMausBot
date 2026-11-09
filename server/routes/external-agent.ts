import { randomUUID } from "node:crypto";
import { z } from "zod";
import { commandHandoff } from "../cloud-computer-tools.ts";
import type { Coordinator, RoomAddress } from "../coordinator.ts";
import { shellRequest } from "../drivers/permission-command.ts";
import { LOCAL_AGENT_BOX, type LocalAgentJobs } from "../local-agent-jobs.ts";
import { safetyFloorClears } from "../safety-floor-gate.ts";
import { PASS, type RouteHandler } from "./table.ts";

export function createExternalAgentRoutes(deps: {
  readBody: () => Promise<unknown>; allowed: () => boolean; cwd: () => string | undefined;
  source: RoomAddress; nodeId: string; assertActive: () => void; coordinator: Coordinator;
  jobs: LocalAgentJobs; stopFailed: () => void;
}): RouteHandler {
  return async ({ res, method, path, json }) => {
    if (method !== "POST" || path !== "/api/internal/external-agent") return PASS;
    const parsed = z.object({ executable: z.string().min(1).max(1024), args: z.array(z.string().max(4000)).max(64) }).strict().safeParse(await deps.readBody());
    if (!parsed.success || [parsed.data.executable, ...parsed.data.args].some(value => value.includes("\0")) || parsed.data.args.join("").length > 24_000) {
      return json(res, 400, { error: "Invalid executable or arguments." });
    }
    const { executable, args } = parsed.data;
    if (!deps.allowed()) return json(res, 403, { error: "Starting a local agent requires a local Claude turn with Full access, unrestricted tools and no custom or managed Claude policy." });
    const cwd = deps.cwd();
    if (!cwd || !safetyFloorClears(shellRequest([executable, ...args], cwd).commandLine)) return json(res, 403, { error: "This command cannot be started automatically." });
    const hooks = commandHandoff(deps.coordinator, deps.source, deps.nodeId, deps.assertActive);
    const processId = `local-${randomUUID()}`;
    if (!hooks.started(LOCAL_AGENT_BOX, processId)) return json(res, 403, { error: "This turn cannot start a tracked local agent." });
    try {
      deps.jobs.start(processId, executable, args, cwd, result => deps.coordinator.completeBackground(deps.nodeId, LOCAL_AGENT_BOX, processId, result), deps.stopFailed);
    } catch (error) {
      hooks.observed(LOCAL_AGENT_BOX, processId, JSON.stringify({ status: "unknown", error: "The process could not be started." }));
      return json(res, 500, { error: error instanceof Error ? error.message : "The process could not be started." });
    }
    return json(res, 200, { processId, status: "started", message: "The result will return to this task after the process exits." });
  };
}
