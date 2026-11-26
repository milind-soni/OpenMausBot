// The before and after pictures a UI PR carries: one page of the running `pnpm dev` app at a phone, a tablet and a
// desktop width, in Midnight and Daylight, with a headless Chrome in a throwaway profile (OMB_CDP_CHROME, else the
// installed Google Chrome).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { removeTempDir } from "../server/testing/cleanup.ts";
import { openHeadlessChrome, type HeadlessPage } from "./testing/headless-chrome.ts";

export const SIZES = [
  { width: 390, height: 844, mobile: true },
  { width: 768, height: 1024, mobile: true },
  { width: 1440, height: 900, mobile: false },
] as const;
export const SKINS = [
  { id: "midnight", scheme: "dark" },
  { id: "daylight", scheme: "light" },
] as const;

export interface ShotsOptions {
  path: string;
  name: string;
  url: string;
  out: string;
  wait: string;
}

export interface Shot {
  url: string;
  file: string;
  width: number;
  height: number;
  mobile: boolean;
  skin: (typeof SKINS)[number]["id"];
  scheme: (typeof SKINS)[number]["scheme"];
}

const USAGE = "usage: pnpm shots [PATH] [--name NAME] [--url http://127.0.0.1:5199] [--out shots] [--wait SELECTOR]";

/** "/room-card-preview.html?state=memory" → "room-card-preview-state-memory"; the app's own page is "app". */
export const nameFor = (path: string) => path.replace(/\.html\b/, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "app";

export function parseShotsArgs(argv: string[]): ShotsOptions {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      name: { type: "string" },
      url: { type: "string", default: "http://127.0.0.1:5199" },
      out: { type: "string", default: "shots" },
      wait: { type: "string", default: "#root > *" },
    },
  });
  if (positionals.length > 1) throw new Error(USAGE);
  const path = positionals[0] ?? "/";
  if (!path.startsWith("/")) throw new Error(`PATH starts with "/", such as /room-card-preview.html\n${USAGE}`);
  // "//host/page" and "/\host/page" start with "/" too, yet name another site.
  if (new URL(path, values.url).origin !== new URL(values.url!).origin) throw new Error(`PATH is a page of ${values.url}, not another site\n${USAGE}`);
  if (values.name !== undefined && !/^[\w-]+$/.test(values.name)) throw new Error("--name takes letters, digits, - and _");
  return { path, name: values.name ?? nameFor(path), url: values.url!, out: values.out!, wait: values.wait! };
}

/** Every size in every skin: the page's address with `skin=` set (the previews read it) and the picture's file. */
export function shotPlan(options: ShotsOptions): Shot[] {
  return SKINS.flatMap(({ id, scheme }) => SIZES.map((size) => {
    const url = new URL(options.path, options.url);
    url.searchParams.set("skin", id);
    return { ...size, url: url.href, skin: id, scheme, file: join(options.out, `${options.name}-${size.width}-${id}.png`) };
  }));
}

async function main(argv: string[]): Promise<void> {
  const options = parseShotsArgs(argv);
  mkdirSync(resolve(options.out), { recursive: true });
  const profile = mkdtempSync(join(tmpdir(), "omb-shots-chrome-"));
  let page: HeadlessPage | undefined;
  try {
    page = await openHeadlessChrome(profile);
    for (const shot of shotPlan(options)) {
      // The app keeps its skin in localStorage; set before its first paint, like a person's own choice.
      const { identifier } = await page.send("Page.addScriptToEvaluateOnNewDocument", { source: `try { localStorage.setItem("omb-skin", ${JSON.stringify(shot.skin)}) } catch {}` });
      await page.send("Emulation.setDeviceMetricsOverride", { width: shot.width, height: shot.height, deviceScaleFactor: 2, mobile: shot.mobile });
      await page.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: shot.scheme }] });
      await page.evaluate("globalThis.ombShotsLeft = true");
      const went = await page.send("Page.navigate", { url: shot.url });
      if (went.errorText) throw new Error(`${shot.url} did not load: ${went.errorText}`);
      // The same address with a #fragment moves within the page; a new page is what clears the marker.
      if (!went.loaderId) await page.send("Page.reload");
      await page.until(`!globalThis.ombShotsLeft && document.readyState === "complete" && document.querySelector(${JSON.stringify(options.wait)})`, 30_000);
      await page.evaluate("document.fonts.ready.then(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))");
      const worn = await page.evaluate("globalThis.ombShotsChecked = true, document.documentElement.dataset.skin");
      if (worn !== shot.skin) throw new Error(`${shot.url} wears "${worn}", not ${shot.skin}`);
      const png = await page.capture();
      if (await page.evaluate("globalThis.ombShotsChecked") !== true) throw new Error(`${shot.url} reloaded while it was photographed; run again`);
      writeFileSync(resolve(shot.file), png);
      await page.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
      console.log(shot.file);
    }
  } finally {
    if (page) {
      // Killing Chrome leaves its profile locked on Windows while its children wind down; closing it and waiting for it to
      // exit lets them go first.
      await Promise.race([page.send("Browser.close").catch(() => undefined), delay(5_000, undefined, { ref: false })]);
      await page.exited(5_000);
      page.close();
    }
    await removeTempDir(profile);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main(process.argv.slice(2));
