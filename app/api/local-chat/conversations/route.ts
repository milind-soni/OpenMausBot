import { BodyTooLarge, readBoundedJson } from "@/lib/http-body";
import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { getConvexClient, listDirectConversations, markConversationRead, openDirectConversation, requireLocalChat, requireLocalWorkspace, sessionTokenFromRequest } from "@/lib/localRealtime";
import { errorText } from "@/lib/error-text";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const failure = (error: unknown) => NextResponse.json({ error: errorText(error, "Conversation unavailable") }, { status: error instanceof BodyTooLarge ? 413 : 400 });

export async function GET(request: Request) {
  try { return NextResponse.json({ conversations: listDirectConversations(await requireLocalWorkspace(request)) }); }
  catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const user = await requireLocalWorkspace(request);
    const { recipientId } = await readBoundedJson(request);
    const members = await getConvexClient().query(api.workspaces.members, { sessionToken: sessionTokenFromRequest(request), teamId: user.teamId });
    if (typeof recipientId !== "string" || !members.some(member => member.userId === recipientId)) throw new Error("Choose a member of this workspace");
    return NextResponse.json({ conversationId: openDirectConversation(user, recipientId) });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: Request) {
  try {
    const user = await requireLocalChat(request);
    const { messageId } = await readBoundedJson(request);
    if (typeof messageId !== "string") throw new Error("Message required");
    markConversationRead(user, messageId);
    return NextResponse.json({ ok: true });
  } catch (error) { return failure(error); }
}
