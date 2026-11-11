import { BodyTooLarge, readBoundedJson } from "@/lib/http-body";
import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { errorText } from "@/lib/error-text";
import { getConvexClient, workspaceScope } from "@/lib/workspace-session";
import type { DirectConversation, LocalChatMessage } from "@/lib/chat-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const failure = (error: unknown) => NextResponse.json({ error: errorText(error, "Conversation unavailable") }, { status: error instanceof BodyTooLarge ? 413 : 400 });

export async function GET(request: Request) {
  try {
    const { sessionToken, teamId } = workspaceScope(request);
    const rows = await getConvexClient().query(api.workspaceChat.directs, { sessionToken, teamId });
    const conversations: DirectConversation[] = rows.map(({ lastMessage, ...row }) => ({ ...row, ...(lastMessage ? { lastMessage: JSON.parse(lastMessage) as LocalChatMessage } : {}) }));
    return NextResponse.json({ conversations });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const { sessionToken, teamId } = workspaceScope(request);
    const { recipientId } = await readBoundedJson(request);
    if (typeof recipientId !== "string") throw new Error("Choose a member of this workspace");
    return NextResponse.json({ conversationId: await getConvexClient().mutation(api.workspaceChat.openDirect, { sessionToken, teamId, recipientId }) });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request) {
  try {
    const scope = workspaceScope(request);
    const { messageId } = await readBoundedJson(request);
    if (typeof messageId !== "string") throw new Error("Message required");
    await getConvexClient().mutation(api.workspaceChat.markRead, { ...scope, messageId });
    return NextResponse.json({ ok: true });
  } catch (error) { return failure(error); }
}
