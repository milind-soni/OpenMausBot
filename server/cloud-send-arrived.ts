// POST /api/cloud-send/arrived, at the end of the move, over the owner's own session: My Cloud keeps which computer the
// bots came from, so each bot knows what stayed there (cloud-connections-prompt.ts), and each bot whose webhook has a new
// address here says so once in its own chat. The address itself never goes in a chat: it stays on the webhook's card.
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { writeFileAtomic } from "./atomic.ts";
import type { CloudOwner } from "./cloud-owner-lines.ts";
import type { RequestAuth } from "./request-auth.ts";
import type { RouteContext } from "./routes/table.ts";
import type { Store } from "./store.ts";
import type { WebhookManager } from "./webhooks.ts";

const FILE = "moved-from.json";

export interface MovedFrom { computer: string; at: number; told: string[] }

export function movedFrom(dataDir: string): MovedFrom | null {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, FILE), "utf8")) as Partial<MovedFrom>;
    if (typeof raw.computer !== "string" || !raw.computer.trim() || !Number.isSafeInteger(raw.at)) return null;
    return { computer: raw.computer, at: raw.at!, told: Array.isArray(raw.told) ? raw.told.filter((id): id is string => typeof id === "string") : [] };
  } catch { return null; }
}

export const webhookMovedLine = (name: string) =>
  `Now that I live on My Cloud, my webhook "${name}" has a new address. Open Automations, choose Copy address on "${name}", and paste it into the app that sends to it.`;

export const webhookHomeLine = (name: string) =>
  `I'm back on this computer, so my webhook "${name}" has an address here again. Open Automations, choose Copy address on "${name}", and paste it into the app that sends to it.`;

export interface ArrivedDeps {
  dataDir: string;
  store: Pick<Store, "bot" | "appendMessage">;
  webhooks(): Pick<WebhookManager, "list"> | null;
  owner(auth: RequestAuth): CloudOwner | null;
}

const arrivedBody = z.object({ v: z.literal(1), computer: z.string().trim().min(1).max(120), webhooks: z.array(z.string().regex(/^[\w-]{1,128}$/u)).max(500) });

/** False when the path is not this route. */
export async function arrivedRoute(deps: ArrivedDeps, { req, res, path, method, auth, json, readBody }: RouteContext): Promise<boolean> {
  if (path !== "/api/cloud-send/arrived") return false;
  const refuse = (status: number, error: string) => { json(res, status, { error }); return true; };
  if (method !== "POST") return refuse(405, "method not allowed");
  if (!deps.owner(auth)) return refuse(403, "Only My Cloud's owner can finish a move into it.");
  const body = arrivedBody.safeParse(await readBody(req, 64 * 1024));
  if (!body.success) return refuse(400, "send { v: 1, computer, webhooks }");
  const kept = movedFrom(deps.dataDir);
  const told = new Set(kept?.told ?? []);
  const hooks = deps.webhooks()?.list() ?? [];
  const telling = body.data.webhooks.flatMap((id) => {
    const hook = hooks.find((candidate) => candidate.id === id);
    const bot = hook && !told.has(id) ? deps.store.bot(hook.botId) : null;
    return hook && bot ? [{ id, name: hook.name, threadId: bot.threadId }] : [];
  });
  for (const { id } of telling) told.add(id);
  // Recorded before the lines go: a move cut short here never has a bot say it twice.
  writeFileAtomic(join(deps.dataDir, FILE), JSON.stringify({ computer: body.data.computer, at: kept?.at ?? Date.now(), told: [...told] }), { mode: 0o600 });
  for (const line of telling) deps.store.appendMessage(line.threadId, { role: "bot", kind: "text", text: webhookMovedLine(line.name) });
  json(res, 200, { v: 1, told: telling.length });
  return true;
}

/** POST /api/cloud-send/home, on this computer once My Cloud ended and the bots came home with what they did there: each bot
 * that said on My Cloud that its webhook had a new address says once that it has an address here again. The record of
 * where the bots came from came home with them and goes now. False when the path is not this route. */
export async function homeRoute(deps: Omit<ArrivedDeps, "owner">, { req, res, path, method, json, readBody }: RouteContext): Promise<boolean> {
  if (path !== "/api/cloud-send/home") return false;
  if (method !== "POST") { req.resume(); json(res, 405, { error: "method not allowed" }); return true; }
  if (!z.object({ v: z.literal(1) }).safeParse(await readBody(req, 1024)).success) { json(res, 400, { error: "send { v: 1 }" }); return true; }
  const told = movedFrom(deps.dataDir)?.told ?? [];
  const hooks = deps.webhooks()?.list() ?? [];
  const telling = told.flatMap((id) => {
    const hook = hooks.find((candidate) => candidate.id === id);
    const bot = hook ? deps.store.bot(hook.botId) : null;
    return hook && bot ? [{ name: hook.name, threadId: bot.threadId }] : [];
  });
  // Gone before the lines go: coming home again after a crash here never has a bot say it twice.
  rmSync(join(deps.dataDir, FILE), { force: true });
  for (const line of telling) deps.store.appendMessage(line.threadId, { role: "bot", kind: "text", text: webhookHomeLine(line.name) });
  json(res, 200, { v: 1, told: telling.length });
  return true;
}
