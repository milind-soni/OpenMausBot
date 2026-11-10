// The extensions installed in a bot browser's own profile, for the person's Extensions menu. Only the person opens these
// pages, from the panel's toolbar; a bot's navigation stays limited to http(s), about:blank and data: (cdp/page.ts).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { CdpPage } from "./cdp/page.ts";

export interface InstalledExtension {
  id: string;
  name: string;
  /** The extension's own page: its options page, else its toolbar popup. */
  url: string;
}

const ID = /^[a-p]{32}$/;
const MAX_EXTENSIONS = 50;

/** A chrome-extension:// address of an extension with a valid id, with no credentials, port or other origin. */
export function extensionPage(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "chrome-extension:" && ID.test(parsed.hostname) && !parsed.username && !parsed.password && !parsed.port;
  } catch {
    return false;
  }
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^﻿/u, ""));
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);
const field = (value: unknown, key: string) => (value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined);

/** "__MSG_appName__" read from the extension's default locale, as Chrome shows it. */
function localized(name: string, dir: string, manifest: Record<string, unknown>): string | null {
  const key = /^__MSG_(\w+)__$/u.exec(name)?.[1];
  if (!key) return name;
  const locale = text(manifest.default_locale);
  if (!locale || !/^[\w-]{1,20}$/u.test(locale)) return null;
  const messages = readJson(join(dir, "_locales", locale, "messages.json"));
  const entry = messages && Object.entries(messages).find(([candidate]) => candidate.toLowerCase() === key.toLowerCase())?.[1];
  return text(field(entry, "message"));
}

function pageOf(manifest: Record<string, unknown>): string | null {
  const page = text(field(manifest.options_ui, "page")) ?? text(manifest.options_page)
    ?? text(field(manifest.action, "default_popup")) ?? text(field(manifest.browser_action, "default_popup"));
  return page && !/^[a-z][\w+.-]*:/iu.test(page) && !page.startsWith("//") ? page.replace(/^\/+/u, "") : null;
}

function newestVersion(dir: string): string | null {
  const versions = readdirSync(dir).filter((name) => !name.startsWith("."));
  versions.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs);
  return versions[0] ? join(dir, versions[0]) : null;
}

/** Each installed extension with a page to open, by name. Unreadable or page-less extensions are left out. */
export function installedExtensions(userDataDir: string): InstalledExtension[] {
  const root = join(userDataDir, "Default", "Extensions");
  let ids: string[];
  try { ids = readdirSync(root).filter((id) => ID.test(id)); } catch { return []; }
  const found: InstalledExtension[] = [];
  for (const id of ids) {
    try {
      const dir = newestVersion(join(root, id));
      const manifest = dir ? readJson(join(dir, "manifest.json")) : null;
      if (!dir || !manifest) continue;
      const page = pageOf(manifest);
      if (!page) continue;
      const name = text(manifest.name);
      const shown = name ? localized(name, dir, manifest) : null;
      const url = new URL(page, `chrome-extension://${id}/`).href;
      if (extensionPage(url) && new URL(url).hostname === id) found.push({ id, name: (shown ?? id).slice(0, 120), url });
    } catch {
      continue;
    }
  }
  return found.sort((a, b) => a.name.localeCompare(b.name)).slice(0, MAX_EXTENSIONS);
}

/** The person's Extensions menu: "extensions" lists them; "openExtension" opens one picked by id. Never an address the
 * viewer sends, and never chrome:// pages. */
export async function extensionInput(
  message: Record<string, unknown>, installed: InstalledExtension[],
  viewer: { push(output: { type: "extensions"; extensions: InstalledExtension[] }): void }, page: Pick<CdpPage, "navigate">,
): Promise<void> {
  if (message.type === "extensions") return viewer.push({ type: "extensions", extensions: installed });
  const extension = installed.find((candidate) => candidate.id === message.id);
  if (extension) await page.navigate(extension.url, { readiness: "none", timeoutMs: 15_000, personExtension: true });
}
