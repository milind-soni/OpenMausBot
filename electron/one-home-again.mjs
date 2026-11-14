// Coming home when My Cloud ends. While the Admin still holds it, the Admin starts it for its owner's export only (it
// boots frozen: server/move-freeze.ts); this computer takes My Cloud's own backup, and restores it with its own upload
// and restore, which keep this computer's credentials and make a safety copy first. A restore leaves automations off, so
// what was on at My Cloud is read first, for one-home.mjs to switch on here after. The same, from a My Cloud that goes on
// (`exportGrant` then gives an owner's code for it), brings this computer's bots home when the person keeps them here.
import { randomBytes } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const STARTING_MS = 15_000;
const NOT_HELD_MS = 5 * 60_000;
const BUSY_MS = 5_000;
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const sentence = (value) => (typeof value === "string" && value.trim() ? value.trim().slice(0, 300) : null);

/**
 * @param {{
 *   exportGrant(): Promise<{ starting: true } | { notHeld: true } | { deleted: true } | { grant: { origin: string, code: string, expiresAt: number } }>,
 *   open(grant: { origin: string, code: string, expiresAt: number }): Promise<{ call(method: string, route: string, body?: unknown): Promise<{ ok: boolean, status: number, body: any }>, fetch(route: string, init?: RequestInit): Promise<Response>, close(): Promise<void> }>,
 *   local: { json(method: string, route: string, body?: unknown): Promise<{ ok: boolean, status: number, body: any }>, upload(file: string, bytes: number): Promise<{ ok: boolean, status: number, body: any }> },
 *   tempRoot: string,
 * }} deps
 */
export function createHomeAgain({ exportGrant, open, local, tempRoot }) {
  /** My Cloud's backup, taken and staged here, kept while this computer is too busy to restore it. */
  let staged = null;

  async function take(grant) {
    const session = await open(grant);
    const password = randomBytes(24).toString("base64url");
    const file = join(tempRoot, `${randomBytes(8).toString("hex")}.ombbackup`);
    try {
      const manifest = await session.call("GET", "/api/cloud-send/manifest");
      const switches = Object.fromEntries((Array.isArray(manifest.body?.automations) ? manifest.body.automations : [])
        .filter((entry) => record(entry) && typeof entry.key === "string").map((entry) => [entry.key, entry.on === true]));
      const exported = await session.call("POST", "/api/workspace-backup/export", { password, clientState: {} });
      if (!exported.ok || typeof exported.body?.id !== "string") throw new Error(sentence(exported.body?.error) ?? "My Cloud could not make its backup.");
      const download = await session.fetch(`/api/workspace-backup/download/${exported.body.id}`);
      if (!download.ok || !download.body) throw new Error("My Cloud's backup could not be downloaded.");
      await mkdir(tempRoot, { recursive: true, mode: 0o700 });
      await pipeline(Readable.fromWeb(download.body), createWriteStream(file, { flags: "wx", mode: 0o600 }));
      const uploaded = await local.upload(file, (await stat(file)).size);
      if (!uploaded.ok || typeof uploaded.body?.id !== "string") throw new Error(sentence(uploaded.body?.error) ?? "This computer could not take My Cloud's backup.");
      const preview = await local.json("POST", "/api/workspace-backup/preview", { id: uploaded.body.id, password });
      if (!preview.ok || typeof preview.body?.id !== "string") throw new Error(sentence(preview.body?.error) ?? "This computer could not open My Cloud's backup.");
      return { id: preview.body.id, switches };
    } finally {
      await session.close().catch(() => {});
      await rm(file, { force: true }).catch(() => {});
    }
  }

  /** My Cloud's backup, taken and staged here unless it already is; `switches`: what was on there when it was taken. */
  async function stage() {
    if (!staged) {
      const asked = await exportGrant();
      if ("starting" in asked) return { later: STARTING_MS };
      if ("notHeld" in asked) return { later: NOT_HELD_MS };
      if ("deleted" in asked) return { deleted: true };
      staged = await take(asked.grant);
    }
    return { staged: true, switches: { ...staged.switches } };
  }

  return {
    stage,
    /** `restored`: this computer's restore of My Cloud's backup, ready once the app opens again; `switches`: what was on
     * there. `later`: My Cloud is still starting or not held yet, or this computer's bots are busy. `deleted`: there is
     * nothing left to bring. */
    async bring() {
      const ready = await stage();
      if (!("staged" in ready)) return ready;
      const restored = await local.json("POST", "/api/workspace-backup/restore", { id: staged.id, confirmation: "REPLACE" });
      if (restored.status === 409) return { later: BUSY_MS };
      const { id, switches } = staged;
      staged = null;
      if (!restored.ok) throw new Error(sentence(restored.body?.error) ?? "This computer could not restore My Cloud's backup.");
      return { restored: typeof restored.body?.restoreId === "string" ? restored.body.restoreId : id, switches };
    },
  };
}
