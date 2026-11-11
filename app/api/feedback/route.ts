import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { limitAction, TooManyRequests } from "@/lib/server-store";
import { clientAddress } from "@/lib/client-address";
import { integrationBridge, originUrl } from "@/lib/integration-bridge";
import { BodyTooLarge, readBoundedText } from "@/lib/http-body";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    if (request.headers.get("origin") !== new URL(originUrl()).origin) return NextResponse.json({ error: "Request rejected" }, { status: 403 });
    if (Number(request.headers.get("content-length") || 0) > 12000) return NextResponse.json({ error: "Feedback is too long" }, { status: 413 });
    const raw = await readBoundedText(request, 12000);
    const body = JSON.parse(raw);
    if (body.website) return NextResponse.json({ ok: true });
    if (typeof body.slug !== "string" || !/^[a-f0-9]{32}$/.test(body.slug) || typeof body.title !== "string" || typeof body.body !== "string" || !["bug", "idea"].includes(body.kind)) throw new Error("Invalid feedback");
    // Per visitor behind a trusted proxy (ORIGIN_TRUSTED_PROXY), otherwise per feedback form. Never retain raw addresses.
    const address = clientAddress(request);
    if (address) await limitAction(`feedback:${createHash("sha256").update(`${process.env.ORIGIN_INTEGRATION_SECRET}:${address}`).digest("hex")}`, 5, 3600000);
    else await limitAction(`feedback-form:${body.slug}`, 30, 3600000);
    await integrationBridge("feedback", { slug: body.slug, title: body.title, body: body.body, kind: body.kind });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof TooManyRequests) return NextResponse.json({ error: "Too many submissions. Try again in an hour." }, { status: 429 });
    return NextResponse.json({ error: "Unable to send feedback. Check your message or try again later." }, { status: error instanceof BodyTooLarge ? 413 : 400 });
  }
}
