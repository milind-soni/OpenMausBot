// The name a call made through the agents tool bridge is read as. Imports no engine driver.
import { WATCHER_OPTIONS_CARD_BOT_ID } from "../shared/options-card.ts";

import { bridgedCallTitle } from "./drivers/agents-bridge.ts";
import { availableTools } from "./drivers/agents-catalog.ts";

/** Every catalog tool's name, whoever may call it. */
export const CATALOG_TOOL_NAMES: ReadonlySet<string> = new Set(availableTools({
  skillAuthoring: true, sharedComputers: true, voiceNotes: true, cloudHome: false, chief: true, mausbot: true, botId: WATCHER_OPTIONS_CARD_BOT_ID,
}).map((tool) => tool.name));

/** A call's name with a bridged call read as the tool it ran. With `serverNamed`, only a title that names
 * the agents server is read: a bare `use_tool` on an engine that omits the server (Codex) could be any server's. */
export function bridgedCallName(title: string, input: unknown, options: { serverNamed?: boolean } = {}): string {
  return bridgedCallTitle(title, input, (name) => CATALOG_TOOL_NAMES.has(name), options.serverNamed !== true);
}
