import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { BodyTooLarge, readBoundedText } from "../lib/http-body";
import { upload, uploadOptions } from "./storage";

const http = httpRouter();
http.route({ path: "/uploads", method: "POST", handler: upload });
http.route({ path: "/uploads", method: "OPTIONS", handler: uploadOptions });
http.route({ path: "/integrations", method: "POST", handler: httpAction(async (ctx, request) => {
  const secret = process.env.ORIGIN_INTEGRATION_SECRET;
  if (!secret || secret.length < 32) return new Response("Unavailable", { status: 503 });
  let body: string;
  try { body = await readBoundedText(request, 100000); }
  catch (error) { return new Response("Request rejected", { status: error instanceof BodyTooLarge ? 413 : 400 }); }
  const signature = request.headers.get("x-origin-signature") || "";
  if (body.length > 100000 || !/^[a-f0-9]{64}$/.test(signature)) return new Response("Unauthorized", { status: 401 });
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const bytes = Uint8Array.from(signature.match(/../g)!, x => parseInt(x, 16));
  if (!await crypto.subtle.verify("HMAC", key, bytes, new TextEncoder().encode(body))) return new Response("Unauthorized", { status: 401 });
  try {
    const p = JSON.parse(body);
    if (typeof p.at !== "number" || Math.abs(Date.now() - p.at) > 60000) return new Response("Expired", { status: 401 });
    let result: unknown;
    switch (p.operation) {
      case "executionContext": result = JSON.parse(await ctx.runQuery(internal.executionAccess.runContext, p.args)); break;
      case "lifecycleClaim": result = JSON.parse(await ctx.runMutation(internal.githubLifecycle.claim, p.args)); break;
      case "lifecycleStart": result = await ctx.runMutation(internal.githubLifecycle.start, p.args); break;
      case "lifecycleFinish": result = await ctx.runMutation(internal.githubLifecycle.finish, p.args); break;
      case "lifecycleReconcile": result = JSON.parse(await ctx.runMutation(internal.githubLifecycle.reconcile, p.args)); break;
      case "lifecycleIncoming": result = await ctx.runMutation(internal.githubLifecycle.incoming, p.args); break;
      case "lifecycleProjects": result = JSON.parse(await ctx.runQuery(internal.githubLifecycle.projects, p.args)); break;
      case "lifecycleError": result = await ctx.runMutation(internal.githubLifecycle.syncError, p.args); break;
      case "lifecycleBegin": result = await ctx.runMutation(internal.githubLifecycle.begin, p.args); break;
      case "prHumanContext": result = JSON.parse(await ctx.runMutation(internal.taskPRs.humanContext, p.args)); break;
      case "prFinalize": result = JSON.parse(await ctx.runMutation(internal.taskPRs.finalize, p.args)); break;
      case "prTargets": result = JSON.parse(await ctx.runQuery(internal.taskPRs.targets, p.args)); break;
      case "prEventTargets": result = await ctx.runQuery(internal.taskPRs.eventTargets, p.args); break;
      case "prBeginSync": result = await ctx.runMutation(internal.taskPRs.beginSync, p.args); break;
      case "prSync": result = await ctx.runMutation(internal.taskPRs.sync, p.args); break;
      case "githubDelivery": result = await ctx.runMutation(internal.taskPRs.delivery, p.args); break;
      case "context": result = JSON.parse(await ctx.runQuery(internal.integrations.context, p.args)); break;
      case "targets": result = JSON.parse(await ctx.runQuery(internal.integrations.targets, p.args)); break;
      case "webhookTargets": result = JSON.parse(await ctx.runQuery(internal.integrations.webhookTargets, p.args)); break;
      case "instanceOperator": result = await ctx.runQuery(internal.integrations.instanceOperator, {}); break;
      case "pending": result = await ctx.runQuery(internal.integrations.pending, {}); break;
      case "unlinkedTasks": result = JSON.parse(await ctx.runQuery(internal.integrations.unlinkedTasks, p.args)); break;
      case "repoResult": result = await ctx.runMutation(internal.integrations.repoResult, p.args); break;
      case "linkIssue": result = await ctx.runMutation(internal.integrations.linkIssue, p.args); break;
      case "completeMergedIssue": result = await ctx.runMutation(internal.integrations.completeMergedIssue, p.args); break;
      case "githubToken": result = await ctx.runAction(internal.teamGitHub.operatorToken, p.args); break;
      case "createRepository": result = await ctx.runAction(internal.teamGitHub.operatorCreateRepository, p.args); break;
      case "chatMentions": result = await ctx.runMutation(internal.notifications.chatMentions, p.args); break;
      case "feedback": result = await ctx.runMutation(internal.feedback.submit, p.args); break;
      case "legacyChat": result = await ctx.runQuery(internal.legacyChat.exportPage, p.args); break;
      default: return new Response("Unknown operation", { status: 400 });
    }
    return Response.json(result);
  } catch { return new Response("Integration request rejected", { status: 400 }); }
}) });
export default http;
