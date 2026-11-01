import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { getConvexClient, getLocalFile, limitLocalAction, localDataDir, registerLocalFile, requireLocalChat, sessionTokenFromRequest } from "@/lib/localRealtime";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { BodyTooLarge, readBoundedBytes } from "@/lib/http-body";
import { errorText } from "@/lib/error-text";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const user = await requireLocalChat(request);
    if (user.workspaceRole === "viewer") throw new Error("View-only workspace access");
    const projectId = new URL(request.url).searchParams.get("projectId") as Id<"projects"> | null;
    if (projectId) {
      const project = await getConvexClient().query(api.projects.get, { sessionToken: sessionTokenFromRequest(request), projectId });
      if (project.teamId !== user.teamId || project.memberRole === "viewer") throw new Error("You have view-only access");
    }
    limitLocalAction(`upload:${user._id}`, 30, 60000);
    if (Number(request.headers.get("content-length")) > 16 * 1024 * 1024) throw new Error("Files must be smaller than 15 MB");
    const bytes = await readBoundedBytes(request, 16 * 1024 * 1024);
    const form = await new Response(bytes as BodyInit, { headers: { "content-type": request.headers.get("content-type") || "" } }).formData(); const file = form.get("file");
    if (!(file instanceof File) || file.size > 15 * 1024 * 1024 || file.size === 0) throw new Error("Choose a file between 1 byte and 15 MB");
    const metadata = { id: crypto.randomUUID(), name: file.name.slice(0, 200), contentType: file.type || "application/octet-stream", size: file.size, ...(projectId ? { projectId } : {}) };
    const dir = path.join(localDataDir(), "files"); await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, metadata.id), Buffer.from(await file.arrayBuffer()), { flag: "wx" });
    registerLocalFile(user, metadata); return NextResponse.json({ file: metadata });
  } catch (error) { return NextResponse.json({ error: errorText(error, "Upload failed") }, { status: error instanceof BodyTooLarge ? 413 : 400 }); }
}
export async function GET(request: Request) {
  try {
    const user = await requireLocalChat(request);
    const id = new URL(request.url).searchParams.get("id") || "";
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("File not found");
    const file = getLocalFile(user, id);
    const sessionToken = sessionTokenFromRequest(request);
    if (file.projectId) {
      const project = await getConvexClient().query(api.projects.get, { sessionToken, projectId: file.projectId });
      if (project.teamId !== user.teamId) throw new Error("File not found");
    } else await getConvexClient().query(api.tasks.authorizeLocalFile, { sessionToken, teamId: user.teamId, fileId: id });
    const data = await readFile(path.join(localDataDir(), "files", id));
    const image = /^image\/(png|jpeg|gif|webp)$/.test(file.contentType);
    return new Response(data, { headers: { "Content-Type": image ? file.contentType : "application/octet-stream", "Content-Disposition": `${image ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch { return NextResponse.json({ error: "File not found or access denied" }, { status: 404 }); }
}
