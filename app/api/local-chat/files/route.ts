import { NextResponse } from "next/server";
import { api } from "@/convex/_generated/api";
import { BodyTooLarge, readBoundedJson } from "@/lib/http-body";
import { errorText } from "@/lib/error-text";
import { getConvexClient, workspaceScope } from "@/lib/workspace-session";

// Chat and issue attachments live in Convex file storage. POST starts an upload: Convex checks access and returns a
// single-use URL the browser sends the bytes to (frontend functions cannot accept 15 MB bodies). GET streams a file
// back after the same checks, so attachment URLs never reach the browser.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const scope = workspaceScope(request);
    const projectId = new URL(request.url).searchParams.get("projectId");
    const body = await readBoundedJson(request, 4000) as { name?: unknown; size?: unknown; contentType?: unknown };
    if (typeof body.name !== "string" || typeof body.size !== "number" || typeof body.contentType !== "string") throw new Error("Choose a file between 1 byte and 15 MB");
    const started = await getConvexClient().mutation(api.workspaceChat.beginUpload, { ...scope, ...(projectId ? { projectId } : {}), name: body.name, size: body.size, contentType: body.contentType });
    return NextResponse.json(started, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return NextResponse.json({ error: errorText(error, "Upload failed") }, { status: error instanceof BodyTooLarge ? 413 : 400 }); }
}

export async function GET(request: Request) {
  try {
    const id = new URL(request.url).searchParams.get("id") || "";
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("File not found");
    const file = await getConvexClient().query(api.workspaceChat.file, { ...workspaceScope(request), fileId: id });
    if (!file) throw new Error("File not found");
    const upstream = await fetch(file.url, { cache: "no-store", signal: AbortSignal.timeout(60000) });
    if (!upstream.ok || !upstream.body) throw new Error("File not found");
    const image = /^image\/(png|jpeg|gif|webp)$/.test(file.contentType);
    return new Response(upstream.body, { headers: {
      "Content-Type": image ? file.contentType : "application/octet-stream",
      "Content-Disposition": `${image ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
    } });
  } catch { return NextResponse.json({ error: "File not found or access denied" }, { status: 404 }); }
}
