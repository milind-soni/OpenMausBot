import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { BodyTooLarge, readBoundedText } from "../lib/http-body";
import { upload, uploadOptions } from "./storage";
import { storeOperation } from "./serverStore";

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
    if (typeof p.operation === "string" && /^(store|mcp|migrate)\./.test(p.operation)) {
      const handled = await storeOperation(ctx, p.operation, p.args && typeof p.args === "object" ? p.args : {});
      if (!handled) return new Response("Unknown operation", { status: 400 });
      return Response.json(handled.result);
    }
    switch (p.operation) {
      case "prHumanContext": result = JSON.parse(await ctx.runMutation(internal.taskPRs.humanContext, p.args)); break;
      case "prFinalize": result = JSON.parse(await ctx.runMutation(internal.taskPRs.finalize, p.args)); break;
      case "prTargets": result = JSON.parse(await ctx.runQuery(internal.taskPRs.targets, p.args)); break;
      case "prEventTargets": result = await ctx.runQuery(internal.taskPRs.eventTargets, p.args); break;
      case "prBeginSync": result = await ctx.runMutation(internal.taskPRs.beginSync, p.args); break;
      case "prSync": result = await ctx.runMutation(internal.taskPRs.sync, p.args); break;
      case "prRepositoryProjects": result = await ctx.runQuery(internal.taskPRs.repositoryProjects, p.args); break;
      case "prLinkReferences": result = await ctx.runMutation(internal.taskPRs.linkReferences, p.args); break;
      case "commitClosers": result = await ctx.runMutation(internal.taskPRs.completeFromCommits, p.args); break;
      case "githubDelivery": result = await ctx.runMutation(internal.taskPRs.delivery, p.args); break;
      case "context": result = JSON.parse(await ctx.runQuery(internal.integrations.context, p.args)); break;
      case "targets": result = JSON.parse(await ctx.runQuery(internal.integrations.targets, p.args)); break;
      case "webhookTargets": result = JSON.parse(await ctx.runQuery(internal.integrations.webhookTargets, p.args)); break;
      case "instanceOperator": result = await ctx.runQuery(internal.integrations.instanceOperator, {}); break;
      case "pending": result = await ctx.runQuery(internal.integrations.pending, {}); break;
      case "unlinkedTasks": result = JSON.parse(await ctx.runQuery(internal.integrations.unlinkedTasks, p.args)); break;
      case "repoResult": result = await ctx.runMutation(internal.integrations.repoResult, p.args); break;
      case "linkIssue": result = await ctx.runMutation(internal.integrations.linkIssue, p.args); break;
      case "unlinkIssue": result = await ctx.runMutation(internal.integrations.unlinkIssue, p.args); break;
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
