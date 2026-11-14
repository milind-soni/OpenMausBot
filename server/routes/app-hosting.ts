// The internal call behind the agents server's publish_app and check_app_hosting tools.
//
// The handler runs inside index.ts's /api/internal/ block, after the capability bearer is checked: the bot comes from
// the capability, never the body, and only the bot's own folders for this turn are read.
import type { ServerResponse } from "node:http";
import { z } from "zod";

import { guestWorkspaceToHost } from "../bot-attachment.ts";
import { VM_WORKSPACE_GUEST } from "../container-computer.ts";
import type { json as sendJson } from "../harness/http.ts";
import type { AppPublisher } from "../host/app-publisher.ts";
import type { BotFolders } from "../pages/bundle.ts";
import { PASS } from "./table.ts";

export interface AppHostingContext {
  method: string;
  path: string;
  res: ServerResponse;
  json: typeof sendJson;
  botId: string;
  /** index.ts's readInternalBody: re-checks the capability after the read. */
  readBody: () => Promise<unknown>;
  folders: BotFolders;
}

const ROUTE = "/api/internal/apps/publish";
const folder = z.string().max(4096).optional();
const body = z.object({ action: z.enum(["publish", "status", "delete"]).optional(), path: folder, project: folder, title: z.string().max(1000).optional() });

export function createAppHostingInternalRoutes(publisher: AppPublisher) {
  return async (ctx: AppHostingContext): Promise<typeof PASS | void> => {
    if (ctx.method !== "POST" || ctx.path !== ROUTE) return PASS;
    const parsed = body.safeParse(await ctx.readBody() ?? {});
    if (!parsed.success) return void ctx.json(ctx.res, 400, { error: "publish_app takes action (publish or delete), path, project and title, all text." });
    const { roots, vmWorkspace } = await ctx.folders();
    const hostPath = (path: string | undefined) => (path && vmWorkspace ? guestWorkspaceToHost(path, VM_WORKSPACE_GUEST, vmWorkspace) ?? path : path);
    const { action = "publish", title } = parsed.data, path = hostPath(parsed.data.path), project = hostPath(parsed.data.project);
    const input = { botId: ctx.botId, roots: vmWorkspace ? [vmWorkspace, ...roots] : roots, ...(project ? { project } : {}) };
    if (action !== "status" && !path?.trim()) return void ctx.json(ctx.res, 400, { error: `publish_app ${action} needs path: the folder to ${action}.` });
    const answer = action === "status" ? await publisher.status({ ...input, ...(path ? { path } : {}) })
      : action === "delete" ? await publisher.remove({ ...input, path: path! })
        : await publisher.publish({ ...input, path: path!, ...(title ? { title } : {}) });
    ctx.json(ctx.res, answer.status, answer.body);
  };
}
