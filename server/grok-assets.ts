import { mkdirSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

import { jsxFolderPageHtml } from "../shared/app-frame/jsx-page.ts";
import type { GrokAssetsAnswer } from "../shared/grok-import.ts";
import { writeFileAtomic } from "./atomic.ts";
import type { ChatApps } from "./chat-apps.ts";
import { grokPageSlug, type MoveAsset } from "./grok-move-mcp.ts";
import { containedBy } from "./pages/bundle.ts";
import type { Store } from "./store.ts";
import type { MausColor } from "../shared/wire.ts";

export const GROK_PAGES_TITLE = "Pages from Grok Bot";
export const GROK_FOLDER = "from-grok";
export const GROK_PAGE_FILE = "page.js";

export interface GrokAssetsHost {
  store: Pick<Store, "bot" | "createTask" | "messagesFor">;
  apps: Pick<ChatApps, "createAppCard" | "docs">;
  workspace(botId: string): string;
}

/** Security: a folder on the way may have been swapped for a link by the bot, so a file is written only where its
 * folder still resolves inside the bot's own. */
function writeInside(root: string, path: string, data: string | Uint8Array): boolean {
  const target = join(root, ...path.split("/"));
  mkdirSync(dirname(target), { recursive: true });
  if (!containedBy(root, realpathSync(dirname(target)))) return false;
  writeFileAtomic(target, data);
  return true;
}

export async function importGrokAssets(host: GrokAssetsHost, botId: string, assets: readonly MoveAsset[]): Promise<GrokAssetsAnswer | null> {
  const bot = host.store.bot(botId);
  if (!bot) return null;
  const answer: GrokAssetsAnswer = { pages: 0, files: 0, skipped: [] };
  if (!assets.length) return answer;
  const workspace = host.workspace(bot.id);
  mkdirSync(join(workspace, GROK_FOLDER), { recursive: true });
  const root = realpathSync(join(workspace, GROK_FOLDER));
  if (!containedBy(realpathSync(workspace), root)) return { ...answer, skipped: assets.map((asset) => (asset.kind === "page" ? asset.title : asset.path)) };

  for (const asset of assets) {
    if (asset.kind !== "file") continue;
    if (writeInside(root, asset.path, asset.data)) answer.files += 1;
    else answer.skipped.push(asset.path);
  }
  const pages = assets.filter((asset) => asset.kind === "page");
  if (!pages.length) return answer;
  const thread = (bot.tasks?.find((task) => task.title === GROK_PAGES_TITLE) ?? host.store.createTask(bot.id, GROK_PAGES_TITLE))?.threadId;
  for (const page of pages) {
    if (thread && await showPage(host, { id: bot.id, name: bot.name, color: bot.color }, thread, workspace, root, page)) answer.pages += 1;
    else answer.skipped.push(page.title);
  }
  return answer;
}

type Page = Extract<MoveAsset, { kind: "page" }>;

async function showPage(host: GrokAssetsHost, bot: { id: string; name: string; color: MausColor }, threadId: string, workspace: string, root: string, page: Page): Promise<boolean> {
  const folder = `pages/${grokPageSlug(page.title)}`;
  const original = page.source && (/^\s*(?:import|export)\b/m.test(page.source) ? "source.canvas.tsx" : "source.md");
  const written = writeInside(root, `${folder}/index.html`, jsxFolderPageHtml({ title: page.title, file: GROK_PAGE_FILE }))
    && writeInside(root, `${folder}/${GROK_PAGE_FILE}`, page.page)
    && (!original || writeInside(root, `${folder}/${original}`, page.source!));
  if (!written) return false;
  const path = realpathSync(join(root, folder));
  const has = host.store.messagesFor(threadId).some((row) => row.kind === "app" && Boolean(row.app?.doc) && host.apps.docs.read(row.app!.doc)?.data?.folder === path);
  if (has) return true;
  const card = await host.apps.createAppCard({ bot, threadId, input: { tool: "show_html", path, title: page.title, live: true }, folders: async () => ({ roots: [workspace], vmWorkspace: null }) });
  return card.ok;
}
