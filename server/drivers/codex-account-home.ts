// An added ChatGPT account (`authMode: "chatgpt-plan"`) keeps its sign-in in a folder of its own. On the person's own
// computer it signs in in their browser, and MausBot holds its tokens. Where that browser cannot reach this server back
// (a Cloud, a hosted workspace), Codex's own device-code login writes into the account's own Codex home instead, so
// several ChatGPT accounts stay signed in side by side and none of them uses another's login. The first Codex account
// keeps the person's Codex home ($CODEX_HOME or ~/.codex).
import { createHash } from "node:crypto";
import { join } from "node:path";

import { DATA_DIR } from "../config.ts";
import { cloudHomeConfigured } from "../cloud-home.ts";
import { hostedWorkspaceConfigured } from "../enterprise.ts";

/** One folder per added account, named by a hash of its instance id. */
export function chatgptAccountDirectory(instanceId: string, dataDir: string = DATA_DIR): string {
  return join(dataDir, "providers", "chatgpt-plan", createHash("sha256").update(instanceId).digest("hex"));
}

/** The account's own Codex home: its login (auth.json), model list and chats. */
export function chatgptAccountHome(instanceId: string, dataDir: string = DATA_DIR): string {
  return join(chatgptAccountDirectory(instanceId, dataDir), "codex");
}

/** A ChatGPT-plan account on a server whose browser sign-in cannot call back: it signs in with Codex's device code. */
export function chatgptAccountSignsInByDevice(config: unknown, env: NodeJS.ProcessEnv = process.env): boolean {
  return (config as { authMode?: unknown } | null | undefined)?.authMode === "chatgpt-plan"
    && (hostedWorkspaceConfigured(env) || cloudHomeConfigured(env));
}
