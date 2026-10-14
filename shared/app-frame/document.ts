// No byte of app content precedes the CSP meta. A leading BOM, whitespace, comments, bogus comments
// (`<?xml …?>`, `<![CDATA[…]>`) and the app's own doctype are stripped first; the rest follows the meta,
// which already sits in the head the parser opened for it.
import type { AppCan, AppDocument, AppToolDefinition, AppToolResult } from "../app.ts";
import { BOT_HTML_CSP, BOT_HTML_NETWORK, mcpAppCsp } from "./csp.ts";
import { APP_HELPER_SOURCE, APP_THEME_STYLE } from "./helper.ts";

export const CSP_META_PREFIX = "<!DOCTYPE html><meta http-equiv=\"Content-Security-Policy\" content=\"";

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** An unterminated comment swallows the rest, as a browser's parser would. */
export function stripDocumentPreamble(html: string): string {
  let rest = html;
  for (;;) {
    const before = rest;
    rest = rest.replace(/^[﻿\s]+/, "");
    if (rest.startsWith("<!--")) {
      const end = rest.indexOf("-->", 4);
      rest = end === -1 ? "" : rest.slice(end + 3);
    } else if (/^<[!?]/.test(rest)) {
      const end = rest.indexOf(">");
      rest = end === -1 ? "" : rest.slice(end + 1);
    }
    if (rest === before) return rest;
  }
}

export function buildSrcdoc(input: { html: string; csp: string; botHelper?: boolean }): string {
  const head = `${CSP_META_PREFIX}${escapeAttribute(input.csp)}">`;
  const helper = input.botHelper ? `<style>${APP_THEME_STYLE}</style><script>${APP_HELPER_SOURCE}</script>` : "";
  return `${head}${helper}${stripDocumentPreamble(input.html)}`;
}

export const BOT_HTML_CAN: AppCan = { serverTools: false, serverResources: false, message: true, openLinks: true, modelContext: true };

export function botHtmlDocument(input: { messageId: string; rev: number; html: string; approval: "full" | "confirm" }): AppDocument {
  return {
    v: 1,
    messageId: input.messageId,
    rev: input.rev,
    srcdoc: buildSrcdoc({ html: input.html, csp: BOT_HTML_CSP, botHelper: true }),
    csp: BOT_HTML_CSP,
    network: { connect: [...BOT_HTML_NETWORK.connect], resources: [...BOT_HTML_NETWORK.resources] },
    can: { ...BOT_HTML_CAN },
    approval: input.approval,
  };
}

export function mcpAppDocument(input: {
  messageId: string;
  rev: number;
  html: string;
  network: { connect: string[]; resources: string[] };
  tool: AppToolDefinition;
  toolInput?: Record<string, unknown>;
  toolResult?: AppToolResult;
  can: AppCan;
  blocked?: AppDocument["blocked"];
  approval: "full" | "confirm";
}): AppDocument {
  const network = { connect: [...input.network.connect], resources: [...input.network.resources] };
  const csp = mcpAppCsp(network);
  return {
    v: 1,
    messageId: input.messageId,
    rev: input.rev,
    srcdoc: buildSrcdoc({ html: input.html, csp }),
    csp,
    network,
    tool: input.tool,
    ...(input.toolInput ? { toolInput: input.toolInput } : {}),
    ...(input.toolResult ? { toolResult: input.toolResult } : {}),
    can: { ...input.can },
    ...(input.blocked ? { blocked: input.blocked } : {}),
    approval: input.approval,
  };
}
