// No byte of app content precedes the CSP meta. A leading BOM, whitespace, comments, bogus comments
// (`<?xml …?>`, `<![CDATA[…]>`) and the app's own doctype are stripped first; the rest follows the meta,
// which already sits in the head the parser opened for it.
import type { AppCan, AppConnectorUse, AppDocument, AppToolDefinition, AppToolResult, AppUse } from "../app.ts";
import { BOT_HTML_CSP, BOT_HTML_NETWORK, folderPageCsp, folderPageNetwork, mcpAppCsp } from "./csp.ts";
import { APP_HELPER_SOURCE, APP_ROOM_HELPER_SOURCE, APP_THEME_STYLE, PUBLISHED_PAGE_NO_BOT } from "./helper.ts";
import { jsxPageHtml } from "./jsx-page.ts";
import { APP_POINT_SOURCE } from "./point.ts";

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

/** `base`: where a folder page's relative URLs resolve, ahead of anything of the page's. */
export function buildSrcdoc(input: { html: string; csp: string; botHelper?: boolean; room?: boolean; base?: string }): string {
  const head = `${CSP_META_PREFIX}${escapeAttribute(input.csp)}">`;
  const source = input.room ? APP_ROOM_HELPER_SOURCE : APP_HELPER_SOURCE;
  const helper = input.botHelper ? `<style>${APP_THEME_STYLE}</style><script>${source}</script><script>${APP_POINT_SOURCE}</script>` : "";
  const base = input.base ? `<base href="${escapeAttribute(input.base)}">` : "";
  return `${head}${base}${helper}${stripDocumentPreamble(input.html)}`;
}

/** `window.mausbot` on a published page, where no chat answers it: send and setContext do nothing, open opens a tab, and
 * data and state reject. */
const PUBLISHED_MAUSBOT = "(function(){var no=function(){return Promise.reject(new Error(" + JSON.stringify(PUBLISHED_PAGE_NO_BOT) + "))};" +
  "window.mausbot={theme:matchMedia(\"(prefers-color-scheme: dark)\").matches?\"dark\":\"light\"," +
  "send:function(){return Promise.resolve()},setContext:function(){return Promise.resolve()}," +
  "open:function(u){window.open(String(u),\"_blank\",\"noopener\");return Promise.resolve()}," +
  "data:{query:no},state:{get:no,set:no,keys:no},connectors:{call:no,list:no}};})();";

/** A bot's HTML page as a published page serves it: the theme colours the chat would give it, and a quiet mausbot. */
export function publishedBotHtml(html: string): string {
  return `<!DOCTYPE html><style>${APP_THEME_STYLE}</style><script>${PUBLISHED_MAUSBOT}</script>${stripDocumentPreamble(html)}`;
}

export const BOT_HTML_CAN: AppCan = { serverTools: false, serverResources: false, message: true, openLinks: true, modelContext: true };
/** Any app in a room: links open for whoever clicks them, and nothing acts for anyone. */
export const ROOM_CAN: AppCan = { serverTools: false, serverResources: false, message: false, openLinks: true, modelContext: false };

/** `format: "jsx"`: `html` is a React component file, served inside the page shell. `files`: a folder page, whose
 * other files load from that folder URL (the token route's, ending in "/"). `uses`: what the page declared; a room's
 * page gets none of it. */
export function botHtmlDocument(input: {
  messageId: string; rev: number; html: string; format?: "jsx"; title?: string; files?: string; room?: boolean; uses?: readonly AppUse[];
  connectors?: readonly AppConnectorUse[];
}): AppDocument {
  const html = input.format === "jsx" ? jsxPageHtml({ title: input.title ?? "Page", source: input.html }) : input.html;
  const csp = input.files ? folderPageCsp(input.files) : BOT_HTML_CSP;
  const network = input.files ? folderPageNetwork(input.files) : BOT_HTML_NETWORK;
  return {
    v: 1,
    messageId: input.messageId,
    rev: input.rev,
    srcdoc: buildSrcdoc({ html, csp, botHelper: true, room: input.room === true, ...(input.files ? { base: input.files } : {}) }),
    csp,
    network: { connect: [...network.connect], resources: [...network.resources] },
    can: input.room ? { ...ROOM_CAN } : declaredCan(input.uses ?? [], input.connectors ?? []),
    ...(input.room ? { room: true as const } : {}),
  };
}

function declaredCan(uses: readonly AppUse[], connectors: readonly AppConnectorUse[]): AppCan {
  return {
    ...BOT_HTML_CAN, ...(uses.includes("data") ? { data: true } : {}), ...(uses.includes("state") ? { state: true } : {}),
    ...(connectors.length ? { connectors: connectors.map((group) => ({ ...group, tools: [...group.tools] })) } : {}),
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
  room?: boolean;
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
    can: { ...(input.room ? ROOM_CAN : input.can) },
    ...(input.blocked && !input.room ? { blocked: input.blocked } : {}),
    ...(input.room ? { room: true as const } : {}),
  };
}
