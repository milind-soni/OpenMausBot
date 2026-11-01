import { BodyTooLarge, readBoundedJson } from "@/lib/http-body";
import { NextResponse } from "next/server";
import { editLocalMessage, flushChatNotifications, getConvexClient, listLocalMessages, localMessageContext, requireLocalChat, searchLocalMessages, sendLocalMessage, sessionTokenFromRequest, type ChatReference } from "@/lib/localRealtime";
import { after } from "next/server";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { errorText } from "@/lib/error-text";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
function failure(error: unknown) { return NextResponse.json({ error: errorText(error, "Request failed") }, { status: error instanceof BodyTooLarge ? 413 : 400 }); }
export async function GET(request: Request) {
  try { const user = await requireLocalChat(request); const params = new URL(request.url).searchParams; const focus = params.get("focus"); const search = params.get("search"); const before = Number(params.get("before")) || undefined; const messages = search ? await searchLocalMessages(user, search, before) : focus ? await localMessageContext(user, focus) : await listLocalMessages(user, before); return NextResponse.json({ messages, hasMore: messages.length === 100 }); } catch (error) { return failure(error); }
}
export async function POST(request: Request) {
  try {
    const body = await readBoundedJson(request) as { sessionToken?: string; teamId?: string; body?: string; attachmentIds?: string[]; references?: ChatReference[]; replyTo?: string; mentionUserIds?: Id<"users">[] };
    const user = await requireLocalChat(request, body);
    const sessionToken = sessionTokenFromRequest(request, body);
    if (body.mentionUserIds && (!Array.isArray(body.mentionUserIds) || body.mentionUserIds.length > 20)) throw new Error("Too many mentions");
    const members = await getConvexClient().query(api.workspaces.members, { sessionToken, teamId: user.teamId });
    if (user.conversation && !user.conversation.slice(3).split(":").every(id => members.some(member => member.userId === id))) throw new Error("This member is no longer in the workspace");
    const mentions = [...new Set(body.mentionUserIds || [])].map(id => { const member = members.find(m => m.userId === id); if (!member?.userId) throw new Error("Mention must belong to this workspace"); return { userId: member.userId, name: member.username || member.name }; });
    const notifyUserIds: Id<"users">[] = [];
    if (body.references) {
      if (!Array.isArray(body.references) || body.references.length > 12) throw new Error("Too many references");
      body.references = await Promise.all(body.references.map(async reference => {
        const projectId = reference.projectId as Id<"projects">;
        const project = await getConvexClient().query(api.projects.get, { sessionToken, projectId });
        if (project.teamId !== user.teamId) throw new Error("Reference must belong to this workspace");
        if (reference.type === "project") return { type: "project" as const, projectId, id: projectId, label: project.name };
        if (reference.type !== "issue") throw new Error("Unknown reference");
        const { task } = await getConvexClient().query(api.tasks.details, { sessionToken, projectId, taskId: reference.id as Id<"tasks"> });
        const assignee = members.find(m => m.email === task.assignedToEmail); if (assignee?.userId) notifyUserIds.push(assignee.userId);
        return { type: "issue" as const, projectId, id: task._id, label: task.title };
      }));
    }
    const message = await sendLocalMessage(user, body.body || "", { ...body, mentions, notifyUserIds });
    after(async () => { try { await flushChatNotifications(); } catch { console.warn("Chat notification delivery deferred"); } });
    return NextResponse.json({ message });
  } catch (error) { return failure(error); }
}
export async function PATCH(request: Request) {
  try { const body = await readBoundedJson(request); const user = await requireLocalChat(request, body); return NextResponse.json({ message: await editLocalMessage(user, body.id, body) }); } catch (error) { return failure(error); }
}
