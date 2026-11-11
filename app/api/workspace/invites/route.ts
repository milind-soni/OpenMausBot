import { BodyTooLarge, readBoundedJson } from "@/lib/http-body";
import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { getConvexClient, requireLocalWorkspace, sessionTokenFromRequest } from "@/lib/workspace-session";
import { limitAction } from "@/lib/server-store";
import { sendInviteMail } from "@/lib/invite-mail";
import { errorText } from "@/lib/error-text";
export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    const body = await readBoundedJson(request) as { email?: string; role?: "admin" | "member" | "viewer" };
    const user = await requireLocalWorkspace(request);
    if (!["owner", "admin"].includes(user.workspaceRole)) throw new Error("Only admins can do this");
    await limitAction(`invite:${user.teamId}:${user._id}`, 20, 60000);
    const email = body.email?.trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Enter a valid email address");
    const invite = await getConvexClient().mutation(api.workspaces.createInvite, { sessionToken: sessionTokenFromRequest(request), teamId: user.teamId, email, role: body.role || "member" });
    return NextResponse.json(await sendInviteMail(invite, email, user.name));
  } catch (error) { return NextResponse.json({ error: errorText(error, "Invitation failed") }, { status: error instanceof BodyTooLarge ? 413 : 400 }); }
}
