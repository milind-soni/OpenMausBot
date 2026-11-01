// The window's own frame in the real app, as the desktop window draws it on macOS and Windows: the top bar (the
// traffic lights or the caption buttons, the rail's button, the place on screen in its middle, an update, Settings),
// the rail of places beside it, the sidebar on the frame's colour beside the app's card, the sidebar's edge dragged to
// its avatars and back, the same window with the frame turned off, and the rail's tiles up close. Against a disposable fake-engine server, with the desktop bridge
// of scripts/testing/rail-preview.tsx (the window's own rail drawn by its own page, in a frame).
// Run: node --experimental-strip-types scripts/verify-window-frame.ts --shots <dir> [--only <view,view>] [--skins all]
// Each view is photographed in Daylight and Midnight (every skin with --skins all) at 1280x800, at twice that size,
// and the views of the bar also as a strip of the bar alone. `tiles` draws each state of a rail tile with every pixel
// as a square, at 1x and 2x; `colours` puts the frame's colour today, the colour derived from the app's and the app's
// own side by side; `skins` shows the window's corner in every skin, and `corners` the card's three round corners in
// every skin, three times their size.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { launchVerificationServer, runControlOmb } from "./control-omb.ts";
import { openHeadlessChrome, type HeadlessPage } from "./testing/headless-chrome.ts";
import { zoomedCrop } from "./testing/png.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const argument = (name: string) => { const at = process.argv.indexOf(name); return at === -1 ? null : process.argv[at + 1] ?? ""; };
const shots = argument("--shots") === null ? null : resolve(argument("--shots")!);
const only = argument("--only") === null ? null : new Set(argument("--only")!.split(",").filter(Boolean));
const WIDTH = 1280, HEIGHT = 800;
const ALL_SKINS = ["daylight", "midnight", "atelier", "foundry", "lagoon", "graphite", "linen", "dusk", "meadow", "pop", "halloween"];
const SKINS = argument("--skins") === "all" ? ALL_SKINS : ["daylight", "midnight"];
const LOOK: Record<string, string> = { daylight: "light", midnight: "dark" };
const BAR = "[data-window-frame-bar]";
const RAIL_PAGE = "document.querySelector('iframe[data-rail-page]')?.contentDocument";
const RAIL_READY = `${RAIL_PAGE}?.querySelector('[data-rail-place]')`;

type Step = (page: HeadlessPage) => Promise<void>;
/** Each view: its query, what must be on screen before the picture, the window's width, and what to do first. */
const VIEWS: Array<{ name: string; query: string; ready: string; width?: number; bar?: true; act?: Step }> = [
  { name: "frame", query: "chrome=1", ready: RAIL_READY, bar: true },
  { name: "frame-simple", query: "chrome=1&mode=simple", ready: RAIL_READY, bar: true },
  { name: "frame-windows", query: "chrome=1&platform=win32", ready: RAIL_READY, bar: true },
  { name: "frame-windows-simple", query: "chrome=1&platform=win32&mode=simple", ready: RAIL_READY, bar: true },
  { name: "frame-update", query: "chrome=1&update=downloaded", ready: `${RAIL_READY} && document.querySelector('${BAR} [data-update-indicator]')`, bar: true },
  { name: "frame-downloading", query: "chrome=1&update=downloading", ready: `${RAIL_READY} && document.querySelector('${BAR} [data-update-indicator]')`, bar: true },
  { name: "frame-team", query: "chrome=1&team=1", ready: RAIL_READY, bar: true },
  { name: "frame-team-windows", query: "chrome=1&team=1&platform=win32&update=downloaded", ready: `${RAIL_READY} && document.querySelector('${BAR} [data-update-indicator]')`, bar: true },
  { name: "frame-computer", query: "chrome=1&place=computer&rail=1", ready: RAIL_READY, bar: true },
  { name: "frame-long-name", query: "chrome=1&team=1&teamname=Northwind%20Analytics%20Research%20and%20Planning%20Group", ready: RAIL_READY, width: 900, bar: true },
  { name: "frame-icons", query: "chrome=1&density=icons", ready: RAIL_READY },
  { name: "frame-icons-simple", query: "chrome=1&density=icons&mode=simple", ready: RAIL_READY },
  // The sidebar's edge, dragged: narrower (the edge lit), then past the point where it becomes the column of avatars.
  { name: "frame-drag", query: "chrome=1", ready: `${RAIL_READY} && document.querySelector('[data-sidebar-resize]')`, act: (page) => dragEdge(page, 250) },
  { name: "frame-drag-simple", query: "chrome=1&mode=simple", ready: `${RAIL_READY} && document.querySelector('[data-sidebar-resize]')`, act: (page) => dragEdge(page, 250) },
  { name: "frame-drag-avatars", query: "chrome=1", ready: `${RAIL_READY} && document.querySelector('[data-sidebar-resize]')`, act: (page) => dragEdge(page, 110) },
  { name: "frame-drag-out", query: "chrome=1&density=icons", ready: `${RAIL_READY} && document.querySelector('[data-sidebar-resize]')`, act: (page) => dragEdge(page, 170, true) },
  { name: "frame-edge-hover", query: "chrome=1&density=icons&mode=simple", ready: `${RAIL_READY} && document.querySelector('[data-sidebar-resize]')`, act: hoverEdge },
  // The frame turned off: macOS's window as it was before the frame, and Windows' own title bar once the app started again.
  { name: "frame-off", query: "chrome=1&frame=off", ready: RAIL_READY },
  { name: "frame-off-simple", query: "chrome=1&frame=off&mode=simple", ready: RAIL_READY },
  { name: "frame-off-icons", query: "chrome=1&frame=off&density=icons", ready: RAIL_READY },
  { name: "frame-off-windows", query: "chrome=1&frame=off&platform=win32", ready: RAIL_READY },
  { name: "frame-setting", query: "chrome=1&settings=frame", ready: `${RAIL_READY} && document.querySelector('[data-window-frame-switch]')` },
  { name: "frame-setting-windows", query: "chrome=1&settings=frame&platform=win32&framepending=1", ready: `${RAIL_READY} && document.querySelector('[data-window-frame-restart]')` },
];

/** Where an element of the window's rail page is, in the window. */
const railRect = (page: HeadlessPage, selector: string) =>
  page.evaluate(`(() => { const box = ${RAIL_PAGE}.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; })()`) as Promise<{ x: number; y: number; width: number; height: number }>;
const rectOf = (page: HeadlessPage, selector: string) =>
  page.evaluate(`(() => { const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: box.x, y: box.y, width: box.width, height: box.height }; })()`) as Promise<{ x: number; y: number; width: number; height: number }>;
const mouse = (page: HeadlessPage, type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number, pressed = false) =>
  page.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" && !pressed ? "none" : "left", buttons: pressed ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 });

/** Presses on the sidebar's edge and drags it until the sidebar would be `width` wide; still pressed unless `release`. */
async function dragEdge(page: HeadlessPage, width: number, release = false) {
  const edge = await rectOf(page, "[data-sidebar-resize]"), sidebar = await rectOf(page, "[data-sidebar]");
  const y = sidebar.y + sidebar.height / 2, from = edge.x + edge.width / 2;
  await mouse(page, "mouseMoved", from, y);
  await mouse(page, "mousePressed", from, y, true);
  const to = sidebar.x + width;
  for (let step = 1; step <= 12; step++) await mouse(page, "mouseMoved", from + ((to - from) * step) / 12, y, true);
  if (release) await mouse(page, "mouseReleased", to, y);
  await delay(400);
}

async function hoverEdge(page: HeadlessPage) {
  const edge = await rectOf(page, "[data-sidebar-resize]");
  await mouse(page, "mouseMoved", edge.x + edge.width / 2, edge.y + edge.height / 2);
  await delay(300);
}

async function open(page: HeadlessPage, url: string, ready: string, width = WIDTH, scale = 2) {
  await page.send("Emulation.setDeviceMetricsOverride", { width, height: HEIGHT, deviceScaleFactor: scale, mobile: false });
  await mouse(page, "mouseMoved", width - 4, HEIGHT - 4);
  await page.send("Page.navigate", { url });
  await page.until(`(${ready}) && document.querySelector("[data-sidebar-bot-row], [data-sidebar-hero]")`);
  await delay(900);
}

type Picture = { label: string; png: Buffer; width: number };
/** A page of labelled pictures, photographed at twice its size: `rows` of pictures side by side, each `width` CSS pixels
 * wide (a picture taken at twice the window's size shows at half its pixels, so pixel for pixel). */
async function sheet(page: HeadlessPage, title: string, rows: Array<{ label: string; pictures: Picture[] }>, file: string) {
  const cell = ({ label, png, width }: Picture) => `<figure><img width="${width}" src="data:image/png;base64,${png.toString("base64")}"><figcaption>${label}</figcaption></figure>`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; padding: 24px; background: #8a8f98; font: 13px/1.4 -apple-system, "Segoe UI", sans-serif; color: #fff; }
    h1 { font-size: 15px; margin: 0 0 12px; } h2 { font-size: 13px; margin: 18px 0 8px; font-weight: 600; }
    .row { display: flex; gap: 16px; align-items: flex-start; } figure { margin: 0; flex: none; } figcaption { margin-top: 6px; }
    img { display: block; image-rendering: pixelated; }
  </style></head><body><div id="sheet" style="display:inline-block">${title ? `<h1>${title}</h1>` : ""}${rows.map((row) => `${row.label ? `<h2>${row.label}</h2>` : ""}<div class="row">${row.pictures.map(cell).join("")}</div>`).join("")}</div></body></html>`;
  // A file, not a data: URL, which Chrome caps far below a page of pictures.
  const sheetFile = `${file}.html`;
  writeFileSync(sheetFile, html);
  await page.send("Emulation.setDeviceMetricsOverride", { width: 3000, height: 2000, deviceScaleFactor: 2, mobile: false });
  await page.send("Page.navigate", { url: pathToFileURL(sheetFile).href });
  await page.until("document.getElementById('sheet') && [...document.images].every((image) => image.complete)");
  const box = await rectOf(page, "#sheet");
  writeFileSync(file, await page.capture({ x: 0, y: 0, width: Math.ceil(box.x + box.width + 24), height: Math.ceil(box.y + box.height + 24) }));
  rmSync(sheetFile, { force: true });
}

const TILES: Array<{ state: string; id: string; hover?: true }> = [
  { state: "rest", id: "a" }, { state: "rest, no colour", id: "mini" }, { state: "hover", id: "a", hover: true },
  { state: "selected", id: "home" }, { state: "attention", id: "b" }, { state: "setting up", id: "pending:c" },
];

/** Every state of a rail tile, each pixel drawn as a square: at 1x eight times, at 2x four times. */
async function tiles(page: HeadlessPage, base: string, skin: string, file: string) {
  const rows: Array<{ label: string; pictures: Picture[] }> = [];
  for (const scale of [1, 2]) {
    await open(page, `${base}?skin=${skin}&chrome=1`, RAIL_READY, WIDTH, scale);
    const pictures: Picture[] = [];
    for (const tile of TILES) {
      const box = await railRect(page, `[data-rail-place="${tile.id}"]`);
      await mouse(page, "mouseMoved", tile.hover ? box.x + box.width / 2 : WIDTH - 4, tile.hover ? box.y + box.height / 2 : HEIGHT - 4);
      await delay(350);
      const clip = { x: 0, y: Math.round(box.y) - 6, width: 36, height: 36 };
      pictures.push({ label: tile.state, png: zoomedCrop(await page.capture(clip), { x: 0, y: 0, width: clip.width * scale, height: clip.height * scale }, 8 / scale), width: 144 });
    }
    rows.push({ label: `${scale}x (${scale === 1 ? "100%" : "200%"})`, pictures });
  }
  await sheet(page, `Rail tiles, ${skin}`, rows, file);
}

const CORNER = { x: 0, y: 0, width: 560, height: 300 };
type Box = { x: number; y: number; width: number; height: number };
/** The card's round corners, each with the frame round it. */
const cardCorners = (card: Box): Array<[string, Box]> => [
  ["top left", { x: card.x - 24, y: card.y - 16, width: 96, height: 64 }],
  ["top right", { x: card.x + card.width - 72, y: card.y - 16, width: 72, height: 64 }],
  ["bottom left", { x: card.x - 24, y: card.y + card.height - 48, width: 96, height: 48 }],
];
const FRAME_COLOURS: Array<[string, string]> = [["today's frame grey", "&framecolor=today"], ["derived from the app's colour", ""], ["the app's own colour", "&framecolor=app"]];

const fixture = await launchVerificationServer();
let ui: MountedPreview | undefined;
try {
  for (const name of ["Chief of Staff", "Research", "Inbox"]) await runControlOmb(["new-bot", "--name", name, "--url", fixture.info.url]);
  ui = await mountPreview(fixture, { entry: "/scripts/testing/rail-preview.tsx", route: "/__window-frame.html", title: "Isolated window frame", logLevel: "warn" });
  if (!shots) {
    console.log(JSON.stringify({ ...fixture.info, previewUrl: ui.previewUrl }, null, 2));
    await parkUntilSignal();
  } else {
    mkdirSync(shots, { recursive: true });
    const profile = mkdtempSync(join(tmpdir(), "omb-frame-chrome-"));
    const page = await openHeadlessChrome(profile);
    const wanted = (name: string) => !only || only.has(name);
    try {
      for (const view of VIEWS.filter((entry) => wanted(entry.name))) for (const skin of SKINS) {
        await open(page, `${ui.previewUrl}?skin=${skin}&${view.query}`, view.ready, view.width);
        await view.act?.(page);
        const name = `${view.name}-${LOOK[skin] ?? skin}`;
        writeFileSync(join(shots, `${name}.png`), await page.capture());
        if (view.bar) writeFileSync(join(shots, `${name}-bar.png`), await page.capture({ x: 0, y: 0, width: view.width ?? WIDTH, height: 40 }));
        await mouse(page, "mouseReleased", (view.width ?? WIDTH) - 4, HEIGHT - 4);
        console.log(join(shots, `${name}.png`));
      }
      if (wanted("tiles")) for (const skin of SKINS) {
        const file = join(shots, `tiles-${LOOK[skin] ?? skin}.png`);
        await tiles(page, ui.previewUrl, skin, file);
        console.log(file);
      }
      if (wanted("colours")) for (const skin of SKINS) {
        const pictures: Picture[] = [];
        for (const [label, query] of FRAME_COLOURS) {
          await open(page, `${ui.previewUrl}?skin=${skin}&chrome=1${query}`, RAIL_READY);
          pictures.push({ label, png: await page.capture(CORNER), width: CORNER.width });
        }
        const file = join(shots, `colours-${LOOK[skin] ?? skin}.png`);
        await sheet(page, `The frame's colour, ${skin}`, [{ label: "Advanced", pictures }], file);
        console.log(file);
      }
      if (wanted("skins")) {
        const rows: Array<{ label: string; pictures: Picture[] }> = [];
        for (const mode of ["", "&mode=simple"]) {
          const pictures: Picture[] = [];
          for (const skin of ALL_SKINS) {
            await open(page, `${ui.previewUrl}?skin=${skin}&chrome=1${mode}`, RAIL_READY);
            pictures.push({ label: skin, png: await page.capture({ x: 0, y: 0, width: 520, height: 300 }), width: 520 });
          }
          for (let at = 0; at < pictures.length; at += 4) rows.push({ label: `${mode ? "Simple" : "Advanced"} ${at / 4 + 1}`, pictures: pictures.slice(at, at + 4) });
        }
        const file = join(shots, "skins.png");
        await sheet(page, "The frame in every skin", rows, file);
        console.log(file);
      }
      if (wanted("corners")) {
        const rows: Array<{ label: string; pictures: Picture[] }> = [];
        for (let at = 0; at < ALL_SKINS.length; at += 2) {
          const pictures: Picture[] = [];
          for (const skin of ALL_SKINS.slice(at, at + 2)) {
            await open(page, `${ui.previewUrl}?skin=${skin}&chrome=1`, RAIL_READY);
            for (const [corner, clip] of cardCorners(await rectOf(page, "[data-window-card]"))) {
              pictures.push({ label: `${skin}, ${corner}`, png: await page.capture(clip), width: clip.width * 3 });
            }
          }
          rows.push({ label: "", pictures });
        }
        const file = join(shots, "corners.png");
        await sheet(page, "The card's round corners in every skin, three times their size", rows, file);
        console.log(file);
      }
    } finally {
      page.close();
      await delay(500);
      rmSync(profile, { recursive: true, force: true });
    }
  }
} finally {
  await ui?.close();
  await fixture.close();
}
