// Room tools: discovery (including the room-turn coordination pair), one
// message posts, and the Chief-only create/manage surface.
import type { Json, ToolContext, ToolHandler, ToolOutcome } from "./context.ts";

// Same spirit as MAX_CREATED_PER_TURN in teams.ts and MAX_QUEUED_PER_THREAD
// in delegations.ts: one turn's worth of a good idea is a handful, and a turn
// that wants more than that has stopped reporting and started broadcasting.
// The harness enforces its own per-room budget regardless; this one exists
// so the refusal reaches the model without a round trip.
const MAX_ROOM_POSTS_PER_TURN = 3;
let roomPostsThisTurn = 0;

export const handlers = {
  async list_room_targets(_args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const r = await ctx.api("/api/internal/room-targets");
    return { text: JSON.stringify(r), ...(r.error ? { isError: true } : {}) };
  },
  async coordinate_bots(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    // The tool's arguments are snake_case, but the harness wire they land on
    // is camelCase, and a caller can reach for that spelling. Map the aliases
    // to the canonical keys first - the documented snake_case spelling wins
    // when both arrive - then refuse an unusable call with the field names a
    // retry needs instead of a generic validation error (#1239).
    const canonical: Json = { ...args };
    delete canonical.botIds;
    delete canonical.requestKey;
    delete canonical.groupId;
    if (canonical.bot_ids === undefined) canonical.bot_ids = args.botIds;
    if (canonical.request_key === undefined) canonical.request_key = args.requestKey;
    if (canonical.group_id === undefined) canonical.group_id = args.groupId;
    const ids = canonical.bot_ids;
    const usable = Array.isArray(ids) && ids.length > 0 && ids.every((id) => typeof id === "string")
      && typeof canonical.message === "string" && canonical.message.trim().length > 0
      && typeof canonical.request_key === "string" && canonical.request_key.trim().length > 0;
    if (!usable) {
      return {
        text: `coordinate_bots takes snake_case arguments: bot_ids (an array of 1-4 teammate ids), message and request_key are required; group_id, rework and label are optional. Received: ${Object.keys(args).join(", ") || "none"}.`,
        isError: true,
      };
    }
    const r = await ctx.api("/api/internal/coordinate-bots", { method: "POST", body: JSON.stringify({
      groupId: canonical.group_id, botIds: ids, message: canonical.message,
      requestKey: canonical.request_key, rework: canonical.rework, label: canonical.label,
    }) });
    return { text: JSON.stringify(r), ...(r.error ? { isError: true } : {}) };
  },
  async list_rooms(_args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const query = new URLSearchParams({ fromBotId: ctx.botId, fromThreadId: ctx.threadId });
    const r = await ctx.api(`/api/internal/rooms?${query.toString()}`);
    const rooms = Array.isArray(r.rooms) ? r.rooms.filter(ctx.jsonRecord) : [];
    // A room the bot is in but may not post into comes back named, with the
    // refusal a post would meet, and without an id: the model gets the exact
    // reason to hand the user and nothing it could retry against.
    const unpostable = Array.isArray(r.unpostable) ? r.unpostable.filter(ctx.jsonRecord) : [];
    const blocked = unpostable.length
      ? `\n\nRooms you are in but cannot post into (no id — there is nothing to retry; give the user the reason instead):\n${
        unpostable.map((room) => `- ${String(room.name)}: ${String(room.reason)}`).join("\n")
      }`
      : "";
    if (!rooms.length) {
      return { text: `You are not in any room you can post into. Tell the user what you wanted to share and let them decide where it goes.${blocked}` };
    }
    const lines = rooms.map((room) => {
      const members = Array.isArray(room.members) ? room.members.map(String).join(", ") : "";
      return `- ${String(room.name)} [id: ${String(room.id)}]${members ? ` — members: ${members}` : ""}`;
    });
    return {
      text: `Rooms you can post into:\n${lines.join("\n")}\n\nUse post_to_room with one of these ids. A post adds one message to the room; it does not start anyone's turn, so nobody replies to it automatically.${blocked}`,
    };
  },
  async post_to_room(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    const groupId = String(args.group_id ?? "").trim();
    const message = String(args.message ?? "").trim();
    if (!groupId || !message) {
      return { text: "post_to_room needs group_id (from list_rooms) and message.", isError: true };
    }
    if (roomPostsThisTurn >= MAX_ROOM_POSTS_PER_TURN) {
      return {
        text: `You have already posted ${MAX_ROOM_POSTS_PER_TURN} times this turn, which is the limit. Do not retry — finish your turn and say anything further to the user directly.`,
        isError: true,
      };
    }
    const r = await ctx.api("/api/internal/post-to-room", {
      method: "POST",
      body: JSON.stringify({ fromBotId: ctx.botId, fromThreadId: ctx.threadId, groupId, message }),
    });
    if (r.error) return { text: String(r.error), isError: true };
    roomPostsThisTurn += 1;
    return {
      text: `Posted in ${r.roomName ?? "the room"}. Nobody's turn was started, so expect no reply — tell the user it is posted.`,
    };
  },
  async create_room(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    if (args.section !== undefined) return { text: "Room sections are fixed to your own section; ask the user to move rooms.", isError: true };
    const roomName = String(args.name ?? "").trim();
    const memberIds = Array.isArray(args.member_bot_ids)
      ? args.member_bot_ids.map((id) => String(id).trim()).filter(Boolean)
      : [];
    const bulletin = typeof args.bulletin === "string" ? args.bulletin.trim() : undefined;
    if (!roomName) {
      return { text: "create_room needs a room name.", isError: true };
    }
    if (!memberIds.length) {
      return { text: "create_room needs at least one bot ID in member_bot_ids.", isError: true };
    }
    const r = await ctx.api(`/api/internal/create-room`, {
      method: "POST",
      body: JSON.stringify({
        fromBotId: ctx.botId,
        fromThreadId: ctx.threadId,
        name: roomName,
        memberIds,
        bulletin,
      }),
    });
    if (r.error) return { text: `Couldn't create room: ${r.error}`, isError: true };
    return {
      text: `Created room “${r.name ?? roomName}” in section “${r.section ?? "General"}” [id: ${r.id}] with ${r.memberCount ?? memberIds.length} members.`,
    };
  },
  async manage_room(args: Json, ctx: ToolContext): Promise<ToolOutcome> {
    if (args.section !== undefined || args.action === "set_section") return { text: "Moving rooms between sections is user-only.", isError: true };
    const roomId = String(args.room_id ?? "").trim();
    const action = String(args.action ?? "").trim();
    if (!roomId || !action) {
      return { text: "manage_room needs room_id and action.", isError: true };
    }
    const memberIds = Array.isArray(args.member_bot_ids)
      ? args.member_bot_ids.map((id) => String(id).trim()).filter(Boolean)
      : undefined;
    const roomName = typeof args.name === "string" ? args.name.trim() : undefined;
    const bulletin = typeof args.bulletin === "string" ? args.bulletin.trim() : undefined;
    const r = await ctx.api(`/api/internal/manage-room`, {
      method: "POST",
      body: JSON.stringify({
        fromBotId: ctx.botId,
        fromThreadId: ctx.threadId,
        roomId,
        action,
        memberIds,
        name: roomName,
        bulletin,
      }),
    });
    if (r.error) return { text: `Couldn't manage room: ${r.error}`, isError: true };
    const message = typeof r.message === "string" ? r.message : `Updated room ${roomId}.`;
    return { text: message };
  },
} satisfies Record<string, ToolHandler>;
