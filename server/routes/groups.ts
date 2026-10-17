import type { WireGroup } from "../../shared/wire.ts";
import { validateBotCwd } from "../bot-cwd.ts";
import type { VisibleSet } from "../bot-visibility.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { GroupDefaultResponder, GroupRecord, Store } from "../store.ts";
import type { ThreadStarters } from "../thread-starters.ts";
import { PASS, type RouteHandler } from "./table.ts";

export interface GroupRouteDeps {
  store: Pick<Store, "bot" | "group" | "messagesFor" | "patchGroup">;
  cloudHome: boolean;
  /** A member may only put bots they can see in a room. */
  visibleFor(auth: RequestAuth): VisibleSet;
  actorKey(auth: RequestAuth & { kind: "session" }): string;
  threadStarters: Pick<ThreadStarters, "set">;
  createChannel(value: unknown): GroupRecord;
  publicGroupState(record: GroupRecord): WireGroup;
}

/** A room's default responder from a request body; null when it is not one, or names a bot outside the room. */
export function checkedGroupResponder(value: unknown, memberIds: string[]): GroupDefaultResponder | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const responder = value as { kind?: unknown; botId?: unknown; fallbackBotId?: unknown };
  if (responder.kind === "everyone") return { kind: "everyone" };
  if (responder.kind === "mentions") return { kind: "mentions" };
  if (responder.kind === "auto") {
    if (responder.fallbackBotId === undefined || responder.fallbackBotId === null) return { kind: "auto" };
    return typeof responder.fallbackBotId === "string" && memberIds.includes(responder.fallbackBotId)
      ? { kind: "auto", fallbackBotId: responder.fallbackBotId }
      : null;
  }
  if (
    responder.kind === "member" &&
    typeof responder.botId === "string" &&
    memberIds.includes(responder.botId)
  ) {
    return { kind: "member", botId: responder.botId };
  }
  return null;
}

export function createGroupRoutes(deps: GroupRouteDeps): RouteHandler {
  const { store, actorKey, threadStarters, createChannel, publicGroupState } = deps;
  const CLOUD_HOME = deps.cloudHome;
  return async ({ req, res, path, method, auth, json, readBody }) => {
    let m: RegExpMatchArray | null = null;
    const visible = deps.visibleFor(auth);
    if (method === "POST" && path === "/api/groups") {
      const body = await readBody(req);
      const hiddenMember = Array.isArray(body?.memberIds) ? body.memberIds.find((id: unknown) => typeof id === "string" && store.bot(id) && !visible.bot(id)) : undefined;
      if (hiddenMember) return json(res, 400, { error: `unknown channel member: ${String(hiddenMember)}` });
      const group = createChannel(body);
      // On a Cloud home whoever opens a room names it (cloudThreadRefusal).
      if (CLOUD_HOME && auth.kind === "session") threadStarters.set(group.threadId, actorKey(auth));
      return json(res, 201, { group: { ...publicGroupState(group), messages: [] } });
    }
    m = path.match(/^\/api\/groups\/([\w-]+)\/setup$/);
    if (m && method === "PATCH") {
      const group = store.group(m[1]);
      if (!group) return json(res, 404, { error: "no such room" });
      if (group.dm) return json(res, 400, { error: "direct-message channels do not have room setup" });
      const body = await readBody(req);
      if (body.action !== "complete" && body.action !== "skip") {
        return json(res, 400, { error: "action must be complete or skip" });
      }
      if (group.setupCompletedAt != null || group.setupSkippedAt != null) {
        return json(res, 200, { group: publicGroupState(group) });
      }
      if (store.messagesFor(group.threadId).length > 0) {
        return json(res, 409, { error: "room setup must be finished before the first message" });
      }

      const patch: Partial<Pick<GroupRecord, "cwd" | "defaultResponder" | "bulletin" | "setupCompletedAt" | "setupSkippedAt">> = {};
      if (body.action === "complete") {
        const checked = validateBotCwd(body.cwd ?? null);
        if (!checked.ok) return json(res, 400, { error: checked.error });
        if (typeof body.bulletin !== "string") return json(res, 400, { error: "bulletin must be a string" });
        if (body.bulletin.length > 12_000) return json(res, 400, { error: "bulletin must be at most 12000 characters" });
        const responder = checkedGroupResponder(body.defaultResponder, group.memberIds);
        if (!responder) return json(res, 400, { error: "invalid default responder" });
        patch.cwd = checked.cwd ?? undefined;
        patch.defaultResponder = responder;
        patch.bulletin = body.bulletin;
        patch.setupCompletedAt = Date.now();
      } else {
        patch.setupSkippedAt = Date.now();
      }
      const updated = store.patchGroup(m[1], patch);
      if (!updated) return json(res, 404, { error: "no such room" });
      return json(res, 200, { group: publicGroupState(updated) });
    }
    return PASS;
  };
}
