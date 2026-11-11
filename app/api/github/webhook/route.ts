import { githubAppConfig } from "@/lib/github-workspace";
import { syncGitHubEvent } from "@/lib/github-sync";
import { syncPREvent } from "@/lib/github-prs";
import { integrationBridge } from "@/lib/integration-bridge";
import { parseGitHubEvent, verifyGitHubSignature } from "@/lib/github-webhook";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request) {
  const secret = githubAppConfig()?.webhookSecret;
  if (!secret) return new Response("Unavailable", { status: 503 });
  const reader = request.body?.getReader();
  let size = 0; const chunks: Uint8Array[] = [];
  if (reader) while (true) {
    const chunk = await reader.read(); if (chunk.done) break;
    size += chunk.value.byteLength;
    if (size > 1000000) { await reader.cancel(); return new Response("Too large", { status: 413 }); }
    chunks.push(chunk.value);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!verifyGitHubSignature(body, request.headers.get("x-hub-signature-256") ?? "", secret)) return new Response("Unauthorized", { status: 401 });
  const kind = request.headers.get("x-github-event") ?? "";
  if (!["issues", "pull_request", "pull_request_review", "check_suite", "check_run"].includes(kind)) return Response.json({ accepted: true });
  let event;
  try { event = parseGitHubEvent(body, kind, request.headers.get("x-github-delivery") ?? ""); }
  catch { return new Response("Invalid event", { status: 400 }); }
  const { deliveryId, fingerprint } = event;
  try {
    const lease = await integrationBridge<number | null>("githubDelivery", { deliveryId, fingerprint });
    if (lease === null) return Response.json({ accepted: true, duplicate: true });
    // Acknowledge only after syncing; a crash leaves a recoverable lease.
    if (kind === "issues") await syncGitHubEvent(event.repoUrl, event.numbers[0]);
    else await syncPREvent(event.repoUrl, event.numbers, event.headSha);
    await integrationBridge("githubDelivery", { deliveryId, fingerprint, finishLease: lease });
    return Response.json({ accepted: true });
  } catch { return Response.json({ error: "GitHub sync pending; retry delivery or reconcile" }, { status: 503 }); }
}
