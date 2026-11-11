import { createHmac } from "node:crypto";
import { callJson, callOptions } from "@/lib/call-http";
import { requireLocalWorkspace } from "@/lib/workspace-session";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const user = await requireLocalWorkspace(request);
    const host = process.env.ORIGIN_TURN_HOST;
    const iceServers: RTCIceServer[] = host ? [{ urls: `stun:${host}:3478` }] : [];
    if (host && process.env.ORIGIN_TURN_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + 3600}:${user._id}`;
      const credential = createHmac("sha1", process.env.ORIGIN_TURN_SECRET).update(username).digest("base64");
      iceServers.push({ urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`], username, credential });
    }
    return callJson({ iceServers }, { headers: { "Cache-Control": "no-store" } });
  } catch { return callJson({ error: "Workspace access required" }, { status: 401 }); }
}

export function OPTIONS() { return callOptions(); }
