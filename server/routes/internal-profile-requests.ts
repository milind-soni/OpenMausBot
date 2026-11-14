import { z } from "zod";
import type { BotRecord } from "../store.ts";
import type { ProfileRequestService } from "../profile-requests.ts";
import type { ProposedAvatars } from "../proposed-avatars.ts";
import { PASS, type RouteHandler } from "./table.ts";

type Proposed = ReturnType<ProfileRequestService["submit"]>;

/** propose_profile: a bot proposes a change to its own profile, or a Chief to a teammate's. The target is checked
 * before any picture file the proposal names is copied into the attachment store. */
export function createInternalProfileRequestRoutes(deps: {
  readBody(): Promise<unknown>;
  bot(botId: string): BotRecord | null | undefined;
  owner(botId: string, threadId: string): { group?: unknown } | null | undefined;
  requests: Pick<ProfileRequestService, "checkTarget" | "submit">;
  avatars(): ProposedAvatars;
  record(from: BotRecord, threadId: string, proposed: Proposed): void;
}): RouteHandler {
  return async ({ res, path, method, json }) => {
    if (method !== "POST" || path !== "/api/internal/profile-requests") return PASS;
    const parsed = z.object({
      fromBotId: z.string().min(1).max(128),
      fromThreadId: z.string().min(1).max(128),
      forBotId: z.string().max(128).optional(),
      changes: z.unknown(),
      reason: z.unknown(),
    }).strict().safeParse(await deps.readBody());
    if (!parsed.success) return json(res, 400, { error: "invalid profile proposal" });
    const body = parsed.data;
    const from = deps.bot(body.fromBotId);
    if (!from) return json(res, 403, { error: "unknown sender" });
    const owner = deps.owner(from.id, body.fromThreadId);
    if (!owner) return json(res, 403, { error: "source conversation does not belong to sender" });
    const targetBotId = body.forBotId?.trim() || from.id;
    deps.requests.checkTarget(from.id, targetBotId);
    const avatars = deps.avatars();
    const changes = await avatars.inChanges(body.changes);
    const proposed = await avatars.submit(() => deps.requests.submit({
      botId: from.id,
      threadId: body.fromThreadId,
      targetBotId,
      changes,
      reason: body.reason,
      from: owner.group ? { botId: from.id, name: from.name, color: from.color } : undefined,
    }));
    deps.record(from, body.fromThreadId, proposed);
    return json(res, 201, proposed);
  };
}
