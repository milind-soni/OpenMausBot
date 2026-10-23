// The agents tools that put something in front of the person: the Watcher's options card, the widget tools, the
// page tools and raise_escalation.
import { parseShowHtmlInput, parseUpdateHtmlInput } from "../../shared/app.ts";
import { parseOptionsCardInput, WATCHER_OPTIONS_CARD_BOT_ID } from "../../shared/options-card.ts";
import { parseWidgetInput, widgetAdvice } from "../../shared/widget.ts";

import type { ToolCallContext, ToolCallResult } from "./agents-call.ts";
import type { Json } from "./agents-client.ts";

export const CARD_TOOL_NAMES: ReadonlySet<string> = new Set(["create_options_card", "show_widget", "update_widget", "show_html", "update_html", "raise_escalation"]);

const CARD_ROUTE = "/api/internal/options-card";

const MASKED = " Something in it read as a secret and was masked before it was stored. Never put secrets in a page or a widget.";

async function callAppTool(name: "show_html" | "update_html", args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const updating = name === "update_html";
  const parsed = updating ? parseUpdateHtmlInput(args) : parseShowHtmlInput(args);
  if (!parsed.ok) return { text: parsed.error, isError: true };
  const page = parsed.value.jsx !== undefined ? { jsx: args.jsx } : parsed.value.path !== undefined ? { path: args.path } : { html: args.html };
  const body = updating
    ? { tool: name, app_id: args.app_id, ...page, ...(typeof args.title === "string" ? { title: args.title } : {}) }
    : {
        tool: name, ...page, title: args.title,
        ...(typeof args.height === "number" ? { height: args.height } : {}),
        ...(typeof args.fallback_text === "string" ? { fallback_text: args.fallback_text } : {}),
      };
  const answer = await context.client.apiResponse(CARD_ROUTE, { method: "POST", body: JSON.stringify(body) });
  if (!answer.ok) return { text: String(answer.body.error ?? (updating ? "Could not update that page." : "Could not show that page.")), isError: true };
  const messageId = String(answer.body.messageId ?? "");
  const masked = answer.body.masked === true ? MASKED : "";
  return {
    text: (updating
      ? `Updated app ${messageId}.`
      : `Shown as app ${messageId}. To change it, call update_html with app_id "${messageId}".`) + masked,
  };
}

export async function callCardTool(name: string, args: Json, context: ToolCallContext): Promise<ToolCallResult> {
  const { api, apiResponse } = context.client;
  if (name === "raise_escalation") {
    const reason = args.reason === undefined || args.reason === null ? "" : String(args.reason).trim();
    if (!reason) {
      return { text: 'raise_escalation takes "reason": one line saying what you need from the person and why your work is parked on it. If the person could simply answer you instead, end your turn on the question rather than raising a flag.', isError: true };
    }
    const { ok, status, body } = await apiResponse("/api/internal/escalate", { method: "POST", body: JSON.stringify({ reason: reason.slice(0, 500) }) });
    if (!ok) {
      const why = status === 429 ? "This conversation has already raised several escalations in the last hour; the person was told about the first ones. Stop here and wait — do not keep flagging the same gate."
        : String(body.error ?? `HTTP ${status}`);
      return { text: why, isError: true };
    }
    return { text: `Escalated: ${String(body.message ?? "the Chief of Staff (or the person) was told.")}` };
  }
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

  if (name === "show_html" || name === "update_html") return callAppTool(name, args, context);

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
