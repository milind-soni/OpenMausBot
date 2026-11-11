import { BodyTooLarge, readBoundedJson } from "@/lib/http-body";
import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorText } from "@/lib/error-text";
import { getConvexClient, workspaceScope } from "@/lib/workspace-session";
import type { ChatReference, LocalChatMessage } from "@/lib/chat-types";

// Workspace and direct chat. Convex (convex/workspaceChat.ts) checks the session, workspace and conversation on every
// call, validates mentions, references and attachments, and queues mention notifications in the same transaction.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function failure(error: unknown) { return NextResponse.json({ error: errorText(error, "Request failed") }, { status: error instanceof BodyTooLarge ? 413 : 400 }); }
const parse = (payloads: string[]) => payloads.map(payload => JSON.parse(payload) as LocalChatMessage);

export async function GET(request: Request) {
  try {
    const scope = workspaceScope(request);
    const params = new URL(request.url).searchParams;
    const focus = params.get("focus"), search = params.get("search"), before = Number(params.get("before")) || undefined;
    const convex = getConvexClient();
    const messages = parse(search
      ? await convex.mutation(api.workspaceChat.search, { ...scope, search, ...(before ? { before } : {}) })
      : await convex.query(api.workspaceChat.list, { ...scope, ...(focus ? { focus } : before ? { before } : {}) }));
    return NextResponse.json({ messages, hasMore: messages.length === 100 });
  } catch (error) { return failure(error); }
}

export async function POST(request: Request) {
  try {
    const body = await readBoundedJson(request) as { sessionToken?: string; teamId?: string; body?: string; attachmentIds?: string[]; references?: ChatReference[]; replyTo?: string; mentionUserIds?: Id<"users">[] };
    const scope = workspaceScope(request, body);
    if (body.mentionUserIds !== undefined && !Array.isArray(body.mentionUserIds)) throw new Error("Too many mentions");
    if (body.references !== undefined && !Array.isArray(body.references)) throw new Error("Too many references");
    if (body.attachmentIds !== undefined && !Array.isArray(body.attachmentIds)) throw new Error("Attachment not found");
    const payload = await getConvexClient().mutation(api.workspaceChat.send, {
      ...scope,
      body: typeof body.body === "string" ? body.body : "",
      ...(body.attachmentIds ? { attachmentIds: body.attachmentIds.map(String) } : {}),
      ...(body.references ? { references: body.references.map(reference => ({ type: String(reference?.type), id: String(reference?.id), projectId: String(reference?.projectId) })) } : {}),
      ...(typeof body.replyTo === "string" ? { replyTo: body.replyTo } : {}),
      ...(body.mentionUserIds ? { mentionUserIds: body.mentionUserIds.map(String) } : {}),
    });
    return NextResponse.json({ message: JSON.parse(payload) as LocalChatMessage });
  } catch (error) { return failure(error); }
}

export async function PATCH(request: Request) {
  try {
    const body = await readBoundedJson(request) as { id?: unknown; body?: unknown; reaction?: unknown; pinned?: unknown; delete?: unknown };
    const payload = await getConvexClient().mutation(api.workspaceChat.edit, {
      ...workspaceScope(request, body as { sessionToken?: unknown }),
      id: String(body.id ?? ""),
      ...(typeof body.body === "string" ? { body: body.body } : {}),
      ...(typeof body.reaction === "string" ? { reaction: body.reaction } : {}),
      ...(typeof body.pinned === "boolean" ? { pinned: body.pinned } : {}),
      ...(body.delete === true ? { delete: true } : {}),
    });
    return NextResponse.json({ message: payload === null ? null : JSON.parse(payload) as LocalChatMessage });
  } catch (error) { return failure(error); }
}
