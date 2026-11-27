import type { MausColor } from "./wire.ts";

/** A bot's page the person saved as an app: it runs on the computer or Cloud that keeps it, privately, and lives on
 * without the chat it came from. */

/** Must match LOCAL_APP_ID in electron/app-link.mjs, the one parser of a saved app's link. */
export const LOCAL_APP_ID = /^la_[A-Za-z0-9_-]{16}$/;
export const LOCAL_APP_NAME_MAX = 80;
/** The versions an app keeps, oldest dropped first: a live page can make a new one every few seconds. */
export const LOCAL_APP_VERSIONS = 20;
export const LOCAL_APPS_MAX = 200;

/** What an app says about itself. `uses` carries what its page declared it uses, when the page declared any. */
export interface LocalAppManifest {
  name: string;
  description?: string;
  uses?: string[];
}

/** GET /api/local-apps lists these; one is the answer of every change to an app. */
export interface LocalApp {
  id: string;
  name: string;
  icon?: string;
  botId: string;
  /** The bot that made it, while it is still here. */
  bot: { name: string; color: MausColor } | null;
  /** The conversation and the page's message it was saved from. */
  threadId: string;
  messageId: string;
  /** The versions it keeps, oldest first, numbered as the page numbered them (0 is the first). */
  versions: Array<{ rev: number; at: number }>;
  /** The version it shows: `pinnedRev` when the person chose one, else the newest. */
  rev: number;
  pinnedRev?: number;
  createdAt: number;
  updatedAt: number;
  manifest: LocalAppManifest;
  /** The conversation it came from is still there, so "Go to chat" has somewhere to go. */
  chat: boolean;
  /** A sample app that came with MausBot: no bot made it and it has no chat (`botId`, `threadId` are empty). */
  sample?: true;
}

export interface LocalAppsList {
  apps: LocalApp[];
}
