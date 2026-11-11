import { ConvexError, v } from "convex/values";
import { internalAction, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireTeamAdmin, requireTeamMember } from "./lib/permissions";
import { seal, sealingConfigured, SEALING_MISSING, unseal } from "./lib/sealing";
import { ISSUE_WEBHOOK_MIN_SECRET, issueWebhookUrlError, postIssueWebhook, signIssueWebhook } from "../lib/issue-webhook";

// Outgoing issue webhooks. Issue writes (convex/lib/issueEvents.ts) build the payload in the mutation and schedule
// `deliver`, which signs and POSTs it, so a slow or failing endpoint never fails the issue change. A workspace's own
// URL and secret (Settings > Workspace) win over the deployment's ORIGIN_ISSUE_WEBHOOK_URL / _SECRET.

const purpose = (teamId: string) => `issue-webhook:${teamId}`;
const ADMIN_ROLES = new Set(["owner", "admin"]);
/** Delays before the second and third attempt. */
const RETRY_MS = [30_000, 300_000];

/** The deployment-wide webhook, when both variables are usable. */
export function globalIssueWebhook() {
  const url = process.env.ORIGIN_ISSUE_WEBHOOK_URL?.trim();
  const secret = process.env.ORIGIN_ISSUE_WEBHOOK_SECRET ?? "";
  return url && !issueWebhookUrlError(url) && secret.length >= ISSUE_WEBHOOK_MIN_SECRET ? { url, secret } : null;
}

export const get = query({
  args: { sessionToken: v.string(), teamId: v.id("teams") },
  returns: v.object({ url: v.union(v.string(), v.null()), canManage: v.boolean(), globalDefault: v.boolean(), sealing: v.boolean() }),
  handler: async (ctx, a) => {
    const { member } = await requireTeamMember(ctx, a.teamId, a.sessionToken);
    const canManage = ADMIN_ROLES.has(member.role);
    const row = canManage ? await ctx.db.query("issueWebhooks").withIndex("by_teamId", q => q.eq("teamId", a.teamId)).unique() : null;
    return { url: row?.url ?? null, canManage, globalDefault: Boolean(globalIssueWebhook()), sealing: sealingConfigured() };
  },
});

/** Saves the workspace's webhook. The secret may be left out to keep the saved one. */
export const save = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams"), url: v.string(), secret: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, a) => {
    const { user } = await requireTeamAdmin(ctx, a.teamId, a.sessionToken);
    const url = a.url.trim();
    const urlError = issueWebhookUrlError(url);
    if (urlError) throw new ConvexError(urlError);
    if (url.length > 2000) throw new ConvexError("Use a shorter webhook URL");
    const row = await ctx.db.query("issueWebhooks").withIndex("by_teamId", q => q.eq("teamId", a.teamId)).unique();
    const secret = a.secret?.trim();
    if (!secret && !row) throw new ConvexError("Enter a signing secret");
    if (secret && (secret.length < ISSUE_WEBHOOK_MIN_SECRET || secret.length > 512)) throw new ConvexError(`Use a secret of at least ${ISSUE_WEBHOOK_MIN_SECRET} characters`);
    if (secret && !sealingConfigured()) throw new ConvexError(SEALING_MISSING);
    const sealedSecret = secret ? await seal(secret, purpose(a.teamId)) : row!.sealedSecret;
    if (row) await ctx.db.patch(row._id, { url, sealedSecret, updatedBy: user._id, updatedAt: Date.now() });
    else await ctx.db.insert("issueWebhooks", { teamId: a.teamId, url, sealedSecret, updatedBy: user._id, updatedAt: Date.now() });
    return null;
  },
});

export const remove = mutation({
  args: { sessionToken: v.string(), teamId: v.id("teams") },
  returns: v.null(),
  handler: async (ctx, a) => {
    await requireTeamAdmin(ctx, a.teamId, a.sessionToken);
    const row = await ctx.db.query("issueWebhooks").withIndex("by_teamId", q => q.eq("teamId", a.teamId)).unique();
    if (row) await ctx.db.delete(row._id);
    return null;
  },
});

export const target = internalQuery({
  args: { teamId: v.id("teams") },
  returns: v.union(v.null(), v.object({ url: v.string(), sealedSecret: v.string() })),
  handler: async (ctx, a) => {
    const row = await ctx.db.query("issueWebhooks").withIndex("by_teamId", q => q.eq("teamId", a.teamId)).unique();
    return row ? { url: row.url, sealedSecret: row.sealedSecret } : null;
  },
});

/**
 * Signs and POSTs one event body as built by the issue write. A network error, timeout or non-2xx answer is retried
 * twice (after 30 s and 5 min). Logs name the event and status only, never the secret.
 */
export const deliver = internalAction({
  args: { teamId: v.id("teams"), event: v.union(v.literal("issue.created"), v.literal("issue.updated")), deliveryId: v.string(), body: v.string(), attempt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, a) => {
    const row = await ctx.runQuery(internal.issueWebhooks.target, { teamId: a.teamId });
    let destination = globalIssueWebhook();
    if (row) {
      try { destination = { url: row.url, secret: await unseal(row.sealedSecret, purpose(a.teamId)) }; }
      catch { console.warn(`Issue webhook ${a.deliveryId}: the workspace secret cannot be unsealed; save it again in Settings.`); return null; }
    }
    if (!destination) return null;
    const attempt = a.attempt ?? 1;
    let outcome: string;
    try {
      const status = await postIssueWebhook(destination.url, {
        body: a.body,
        headers: { "Content-Type": "application/json", "X-Origin-Event": a.event, "X-Origin-Delivery": a.deliveryId, "X-Origin-Signature": await signIssueWebhook(a.body, destination.secret) },
      });
      if (status >= 200 && status < 300) return null;
      outcome = `HTTP ${status}`;
    } catch (error) { outcome = error instanceof Error && error.name === "AbortError" ? "timed out" : "network error"; }
    const retry = RETRY_MS[attempt - 1];
    console.warn(`Issue webhook ${a.event} ${a.deliveryId} attempt ${attempt} failed: ${outcome}${retry ? "; retrying" : ""}`);
    if (retry) await ctx.scheduler.runAfter(retry, internal.issueWebhooks.deliver, { ...a, attempt: attempt + 1 });
    return null;
  },
});
