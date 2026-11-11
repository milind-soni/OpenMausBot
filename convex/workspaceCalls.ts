import { ConvexError, v } from "convex/values";
import { internalMutation, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireChat, requireChatWriter, type ChatViewer } from "./lib/chatAccess";

// Workspace call presence and WebRTC signaling (app/api/local-voice/*). Clients poll; nothing holds a socket open.
// Rows live in teamCallParticipants/teamCallSignals with room "" (the workspace room).

type Ctx = QueryCtx | MutationCtx;
export type CallParticipant = {
  userId: Id<"users">; name: string; username?: string; email: string; avatarUrl?: string | null;
  audioEnabled: boolean; videoEnabled: boolean; screenSharing?: boolean; joinedAt: number; lastSeenAt: number;
};
export type CallSignal = { id: string; fromUserId: Id<"users">; toUserId: Id<"users">; fromJoinedAt?: number; toJoinedAt?: number; kind: "offer" | "answer" | "candidate"; payload: string; createdAt: number };

const ROOM = "";
const PRESENCE_MS = 30000;
const SIGNAL_MS = 120000;
const ROOM_SIZE = 8;
const scope = { sessionToken: v.string(), teamId: v.id("teams") };

async function active(ctx: Ctx, teamId: Id<"teams">) {
  const rows = await ctx.db.query("teamCallParticipants").withIndex("by_team_room_user", q => q.eq("teamId", teamId).eq("room", ROOM)).take(200);
  const fresh = Date.now() - PRESENCE_MS;
  return rows.filter(row => row.seen >= fresh).sort((a, b) => a.seen - b.seen);
}

async function dropSignals(ctx: MutationCtx, viewer: ChatViewer) {
  const me = viewer.user._id;
  for (const row of await ctx.db.query("teamCallSignals").withIndex("by_team_room_sender", q => q.eq("teamId", viewer.teamId).eq("room", ROOM).eq("sender", me)).take(500)) await ctx.db.delete(row._id);
  for (const row of await ctx.db.query("teamCallSignals").withIndex("by_team_room_recipient_created", q => q.eq("teamId", viewer.teamId).eq("room", ROOM).eq("recipient", me)).take(500)) await ctx.db.delete(row._id);
}

export const participants = query({
  args: scope, returns: v.array(v.string()),
  handler: async (ctx, a) => {
    await requireChat(ctx, a);
    return (await active(ctx, a.teamId)).map(row => row.payload);
  },
});

/** Joins the room, or refreshes presence and media state with `heartbeat`. A fresh join drops the caller's old signals. */
export const join = mutation({
  args: { ...scope, audioEnabled: v.boolean(), videoEnabled: v.boolean(), screenSharing: v.boolean(), heartbeat: v.boolean() },
  returns: v.object({ userId: v.id("users"), joinedAt: v.number() }),
  handler: async (ctx, a) => {
    const viewer = await requireChat(ctx, a);
    requireChatWriter(viewer);
    const rows = await active(ctx, a.teamId);
    const me = viewer.user._id;
    if (rows.length >= ROOM_SIZE && !rows.some(row => row.userId === me)) throw new ConvexError("This room is full (8 people)");
    const previousRow = rows.find(row => row.userId === me);
    const previous = previousRow ? JSON.parse(previousRow.payload) as CallParticipant : undefined;
    if (!a.heartbeat) await dropSignals(ctx, viewer);
    const now = Date.now();
    const participant: CallParticipant = {
      userId: me, name: viewer.user.name, username: viewer.user.username, email: viewer.user.email, avatarUrl: viewer.avatarUrl,
      audioEnabled: a.audioEnabled, videoEnabled: a.videoEnabled, screenSharing: a.screenSharing,
      joinedAt: a.heartbeat && previous ? previous.joinedAt : Math.max(now, (previous?.joinedAt || 0) + 1), lastSeenAt: now,
    };
    const existing = await ctx.db.query("teamCallParticipants").withIndex("by_team_room_user", q => q.eq("teamId", a.teamId).eq("room", ROOM).eq("userId", me)).first();
    if (existing) await ctx.db.patch(existing._id, { seen: now, payload: JSON.stringify(participant) });
    else await ctx.db.insert("teamCallParticipants", { teamId: a.teamId, room: ROOM, userId: me, seen: now, payload: JSON.stringify(participant) });
    return { userId: me, joinedAt: participant.joinedAt };
  },
});

export const leave = mutation({
  args: scope, returns: v.null(),
  handler: async (ctx, a) => {
    const viewer = await requireChat(ctx, a);
    for (const row of await ctx.db.query("teamCallParticipants").withIndex("by_team_room_user", q => q.eq("teamId", a.teamId).eq("room", ROOM).eq("userId", viewer.user._id)).take(10)) await ctx.db.delete(row._id);
    await dropSignals(ctx, viewer);
    return null;
  },
});

/** Queues an offer, answer or ICE candidate for one peer. Returns null when either side left or rejoined meanwhile. */
export const signal = mutation({
  args: { ...scope, toUserId: v.string(), kind: v.string(), payload: v.string(), fromJoinedAt: v.optional(v.number()), toJoinedAt: v.optional(v.number()) },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, a) => {
    const viewer = await requireChat(ctx, a);
    requireChatWriter(viewer);
    const me = viewer.user._id;
    if (a.toUserId === me || !["offer", "answer", "candidate"].includes(a.kind) || !a.payload || a.payload.length > 80000) throw new ConvexError("Invalid call signal");
    const rows = await active(ctx, a.teamId);
    const sender = rows.find(row => row.userId === me), recipient = rows.find(row => row.userId === a.toUserId);
    // A peer that just left (or a stale participant list on the sender) is a normal race, not a client error.
    if (!sender || !recipient) return null;
    const from = JSON.parse(sender.payload) as CallParticipant, to = JSON.parse(recipient.payload) as CallParticipant;
    if ((a.fromJoinedAt !== undefined && a.fromJoinedAt !== from.joinedAt) || (a.toJoinedAt !== undefined && a.toJoinedAt !== to.joinedAt)) return null;
    const signal: CallSignal = { id: crypto.randomUUID(), fromUserId: me, toUserId: to.userId, fromJoinedAt: from.joinedAt, toJoinedAt: to.joinedAt, kind: a.kind as CallSignal["kind"], payload: a.payload, createdAt: Date.now() };
    const payload = JSON.stringify(signal);
    await ctx.db.insert("teamCallSignals", { teamId: a.teamId, room: ROOM, recipient: to.userId, sender: me, signalId: signal.id, created: signal.createdAt, payload });
    return payload;
  },
});

export const signals = query({
  args: scope, returns: v.array(v.string()),
  handler: async (ctx, a) => {
    const viewer = await requireChat(ctx, a);
    const rows = await ctx.db.query("teamCallSignals")
      .withIndex("by_team_room_recipient_created", q => q.eq("teamId", a.teamId).eq("room", ROOM).eq("recipient", viewer.user._id).gt("created", Date.now() - SIGNAL_MS))
      .take(120);
    return rows.map(row => row.payload);
  },
});

export const ack = mutation({
  args: { ...scope, signalIds: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, a) => {
    const viewer = await requireChat(ctx, a);
    const ids = new Set(a.signalIds.slice(0, 120));
    if (!ids.size) return null;
    for (const row of await ctx.db.query("teamCallSignals").withIndex("by_team_room_recipient_created", q => q.eq("teamId", a.teamId).eq("room", ROOM).eq("recipient", viewer.user._id)).take(500)) {
      if (ids.has(row.signalId)) await ctx.db.delete(row._id);
    }
    return null;
  },
});

/** Cron: removes presence older than 30 s and signals older than two minutes, in bounded batches. */
export const prune = internalMutation({
  args: {}, returns: v.null(),
  handler: async ctx => {
    const now = Date.now();
    for (const row of await ctx.db.query("teamCallParticipants").withIndex("by_seen", q => q.lt("seen", now - PRESENCE_MS)).take(200)) await ctx.db.delete(row._id);
    for (const row of await ctx.db.query("teamCallSignals").withIndex("by_created", q => q.lt("created", now - SIGNAL_MS)).take(200)) await ctx.db.delete(row._id);
    return null;
  },
});
