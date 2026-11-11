import { v } from "convex/values";
import { internalQuery } from "./_generated/server";

// UPGRADE STUB - remove once no frontend from before the Convex chat store (ORIGIN_LOCAL_DATA_DIR) is running.
// That frontend kept chat in a local sqlite store and copied a workspace's desktop-era rows from teamChatMessages,
// teamChatFiles, teamDirectConversations and teamChatReads once, through the signed bridge ("legacyChat"). The current
// web app reads those tables directly (convex/workspaceChat.ts), so only the old frontend still calls this during the
// cutover. Project conversations ("project:<id>") have no place in the web app and are not exported.

const PAGE = 200;
const kept = (conversation: string) => conversation === "" || conversation.startsWith("dm:");

export const exportPage = internalQuery({
  args: {
    teamId: v.id("teams"),
    table: v.union(v.literal("messages"), v.literal("files"), v.literal("directs"), v.literal("reads")),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({ rows: v.array(v.any()), isDone: v.boolean(), continueCursor: v.string() }),
  handler: async (ctx, a) => {
    const page = { numItems: PAGE, cursor: a.cursor };
    if (a.table === "messages") {
      const result = await ctx.db.query("teamChatMessages").withIndex("by_team_conversation_created", q => q.eq("teamId", a.teamId)).paginate(page);
      return { isDone: result.isDone, continueCursor: result.continueCursor, rows: result.page.filter(row => kept(row.conversation)).map(row => ({ conversation: row.conversation, id: row.messageId, created: row.created, payload: row.payload })) };
    }
    if (a.table === "files") {
      const result = await ctx.db.query("teamChatFiles").withIndex("by_team_conversation_file", q => q.eq("teamId", a.teamId)).paginate(page);
      const rows = [];
      for (const row of result.page) if (kept(row.conversation)) rows.push({ conversation: row.conversation, id: row.fileId, author: row.author, payload: row.payload, url: await ctx.storage.getUrl(row.storageId) });
      return { isDone: result.isDone, continueCursor: result.continueCursor, rows };
    }
    if (a.table === "directs") {
      const result = await ctx.db.query("teamDirectConversations").withIndex("by_team_conversation", q => q.eq("teamId", a.teamId)).paginate(page);
      return { isDone: result.isDone, continueCursor: result.continueCursor, rows: result.page.map(row => ({ id: row.conversation, userA: row.userA, userB: row.userB })) };
    }
    const result = await ctx.db.query("teamChatReads").withIndex("by_team_conversation_user", q => q.eq("teamId", a.teamId)).paginate(page);
    return { isDone: result.isDone, continueCursor: result.continueCursor, rows: result.page.filter(row => kept(row.conversation)).map(row => ({ conversation: row.conversation, userId: row.userId, seen: row.seen })) };
  },
});
