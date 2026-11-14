// The tools that put something the person sees into the chat: widgets, pages shown inline, and pages published to a link.
import { APP_TOOL_DEFINITIONS } from "./agents-app-tools.ts";
import { PAGE_TOOL_DEFINITIONS } from "./agents-pages-tools.ts";
import { WIDGET_TOOL_DEFINITIONS } from "./agents-widget-tools.ts";

export const CHAT_CARD_TOOL_DEFINITIONS = [...WIDGET_TOOL_DEFINITIONS, ...APP_TOOL_DEFINITIONS, ...PAGE_TOOL_DEFINITIONS];
