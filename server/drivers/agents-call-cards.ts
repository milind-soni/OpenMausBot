// The agents tools that draw a chat card: the Watcher's options card, the widget tools and a bug report draft.
import { BUG_REPORT_LIMITS } from "../../shared/bug-report.ts";
import { parseOptionsCardInput, WATCHER_OPTIONS_CARD_BOT_ID } from "../../shared/options-card.ts";
import { parseWidgetInput, widgetAdvice } from "../../shared/widget.ts";

import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const CARD_TOOL_NAMES: ReadonlySet<string> = new Set(["create_options_card", "show_widget", "update_widget", "draft_bug_report"]);

const CARD_ROUTE = "/api/internal/options-card";

export async function callCardTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { api, apiResponse } = context.client;
  if (name === "create_options_card") {
    if (context.botId !== WATCHER_OPTIONS_CARD_BOT_ID) {
      return { text: "create_options_card is not enabled for this bot.", isError: true };
    }
    const parsed = parseOptionsCardInput(args);
    if (!parsed.ok) return { text: parsed.error, isError: true };
    const result = await api(CARD_ROUTE, {
      method: "POST",
      body: JSON.stringify(parsed.value),
    });
    return {
      text: `Rendered the native options card in this Watcher thread (message ${String(result.messageId ?? "created")}). Wait for the person's click or custom response; the card itself authorizes no external action.`,
    };
  }
  if (name === "draft_bug_report") return draftBugReport(args, context);

  const parsed = parseWidgetInput(args.widget);
  if (!parsed.ok) return { text: parsed.error, isError: true };
  const updating = name === "update_widget";
  if (updating && (typeof args.widget_id !== "string" || !args.widget_id.trim())) {
    return { text: "widget_id: is required, the id show_widget returned.", isError: true };
  }
  const { ok, body } = await apiResponse(CARD_ROUTE, {
    method: "POST",
    body: JSON.stringify(updating
      ? { tool: "update_widget", widget_id: args.widget_id, widget: args.widget }
      : { tool: "show_widget", widget: args.widget, ...(typeof args.fallback_text === "string" ? { fallback_text: args.fallback_text } : {}) }),
  });
  if (!ok) return { text: String(body.error ?? (updating ? "Could not update that widget." : "Could not show that widget.")), isError: true };
  const messageId = String(body.messageId ?? "");
  // Said only when it happened: the bot reads this back and can rename a field it called `key` for an id.
  const masked = body.masked === true
    ? " Something in it read as a secret and was masked before it was stored. Never put secrets in a widget, and name a payload field key, token or password only when it holds one."
    : "";
  // What parses but misleads: a list with nothing to choose, a time or a date to type.
  const advice = widgetAdvice(parsed.value);
  return {
    text: (updating
      ? `Updated widget ${messageId}.`
      : `Shown as widget ${messageId}. If it asks the person something, end your turn now: their press arrives as their next message. To change it later, call update_widget with widget_id "${messageId}".`) + masked + (advice ? ` ${advice}` : ""),
  };
}

async function draftBugReport(args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const summary = typeof args.summary === "string" ? args.summary.trim() : "";
  if (!summary) return { text: "draft_bug_report needs summary: one line on what failed in OpenMausBot.", isError: true };
  if (summary.length > BUG_REPORT_LIMITS.summary) {
    return { text: `summary is limited to ${BUG_REPORT_LIMITS.summary} characters; this one is ${summary.length}. Put the rest in details.`, isError: true };
  }
  const details = typeof args.details === "string" ? args.details.trim() : "";
  const { ok, body } = await context.client.apiResponse(CARD_ROUTE, {
    method: "POST",
    body: JSON.stringify({ tool: "draft_bug_report", summary, details }),
  });
  if (!ok) return { text: String(body.error ?? "Could not draft that bug report."), isError: true };
  return {
    text: "The person sees your bug report draft and can edit, send or dismiss it; nothing is sent unless they press Send. Your turn ends now: say in one short line that a draft is ready for them to review, then stop. OpenMausBot resumes you when they send or dismiss it.",
  };
}
