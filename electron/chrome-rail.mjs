// The rail of places as the window's own chrome: this app's small page in a view of its own at the window's left edge,
// beside whichever place's page the window shows. Every place gets it, whatever that server runs, and no place's page
// ever reads the list of places: the rail's page is this app's own, and only main switches places.
//
// The page beside it leaves the rail its width: main tells each of its documents how wide the rail is (`rail:beside`),
// and the app's preload, which every page in the window gets, moves the page over by that much at any zoom. The rail's
// sheets (＋, the list past eight) open over the whole window: while one is open the view covers the window,
// transparent but for the sheet, and goes back to its strip when it closes.
//
// The page beside the rail draws the window's frame (its top bar, with the traffic lights in it) when it says so, as each
// document does once it is on screen. One that doesn't, a Cloud or a server of the person's own on an older release,
// gets the window as that release made it: the traffic lights back where it left room for them, and the rail's places
// under them. A new document has the same few seconds as for the button before the window changes back.
//
// The person may hide it with a button on the page beside it. That page may be a Cloud or a server of their own on an
// older release with no such button, so the rail hides only beside a document that offered one; a new document has a
// few seconds to offer it, and the rail comes back beside one that doesn't, or that stops responding.

import { TRAFFIC_LIGHTS } from "./window-chrome.mjs";

export const CHROME_RAIL_WIDTH = 36;
export const CHROME_RAIL_PATH = "/rail";
/** How long a rail the person hid stays hidden, and a framed window stays framed, for the page's next document. */
export const RAIL_OFFER_GRACE_MS = 5_000;

/** Chromium's net::ERR_ABORTED: a load replaced by another, not a page that failed. */
const ABORTED = -3;

/**
 * @param {{
 *   createView: (options: object) => any,
 *   preload: string,
 *   args: () => string[],
 *   url: () => string,
 *   wanted: () => boolean,
 *   prefs?: () => { railHidden(): boolean, setRailHidden(hidden: boolean): void, windowFrame?(): boolean } | null,
 *   changed?: () => void,
 *   log?: (line: string) => void,
 * }} deps `url()`: the rail's page on this app's own server; `wanted()`: whether the window has two places or more to
 * show it for (railPlaces); `args()`: the preload's arguments, as the window's own page gets them; `prefs()`: where this
 * desktop keeps the person's choice to hide it; `changed()`: the rail came or went beside the page.
 */
export function createChromeRail({ createView, preload, args, url, wanted, prefs = () => null, changed = () => {}, log = () => {} }) {
  let view = null, win = null, shown = false, expanded = false;
  // Whether the page beside draws the frame; the window opens as if it does (windowChromeOptions).
  let framed = true, frameGrace = null;
  // The document beside the rail offered its button; a new one may still (`grace`); the page stopped responding.
  let offered = false, grace = null, hung = false, told = "";
  const alive = () => Boolean(win && !win.isDestroyed());
  const layout = () => {
    if (!view || !shown || !alive()) return;
    const [width, height] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width: expanded ? width : Math.min(CHROME_RAIL_WIDTH, width), height });
  };
  const page = () => (alive() && !win.webContents.isDestroyed() ? win.webContents : null);
  /** The page beside the rail moves over by its width (0: it has the whole window again). */
  const tellPage = () => page()?.send("rail:beside", shown ? CHROME_RAIL_WIDTH : 0);
  const choseHidden = () => prefs()?.railHidden() === true;
  /** Hidden by the person's choice, beside a document that can bring it back. */
  const hidden = () => choseHidden() && !hung && (offered || grace !== null);
  const pageState = () => ({ available: alive() && wanted(), hidden: choseHidden() });
  /** The document that offered the button hears when it would change. */
  const tellState = () => {
    const state = pageState(), key = JSON.stringify(state);
    if (!offered || key === told) return;
    told = key;
    page()?.send("rail:state", state);
  };
  const stopGrace = () => { clearTimeout(grace); grace = null; };
  const startGrace = () => {
    stopGrace();
    grace = setTimeout(() => { grace = null; rail.refresh(); }, RAIL_OFFER_GRACE_MS);
  };
  /** The traffic lights where the page beside makes room for them (macOS only), and the rail's page told. */
  const frameDrawn = (next) => {
    clearTimeout(frameGrace); frameGrace = null;
    if (next === framed) return;
    framed = next;
    if (alive()) win.setWindowButtonPosition?.(framed ? TRAFFIC_LIGHTS.framed : TRAFFIC_LIGHTS.unframed);
    rail.send("rail:framed", framed);
  };
  /** A framed window stays framed while the next document has its few seconds to say it draws the frame too. */
  const awaitFrame = () => {
    clearTimeout(frameGrace);
    frameGrace = framed ? setTimeout(() => frameDrawn(false), RAIL_OFFER_GRACE_MS) : null;
  };
  /** The page beside the rail has another document, or lost the one it had. */
  const nextDocument = () => {
    const keep = hidden();
    offered = false; hung = false; told = "";
    if (keep) startGrace(); else stopGrace();
    awaitFrame();
    rail.refresh();
  };
  /** The page beside the rail asks: the window's own page, in its main frame (never a frame inside it). */
  const pageBeside = (event) => Boolean(page() && event?.sender === win.webContents && event.senderFrame === win.webContents.mainFrame);
  const ensureView = () => {
    if (view) return view;
    view = createView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload, additionalArguments: args() } });
    view.setBackgroundColor?.("#00000000");
    const contents = view.webContents;
    contents.setWindowOpenHandler(() => ({ action: "deny" }));
    const stay = (event, target) => { if (target !== url()) event.preventDefault(); };
    contents.on("will-navigate", stay);
    contents.on("will-redirect", stay);
    contents.on("render-process-gone", () => { log("chrome rail: its page went away; loading it again"); void contents.loadURL(url()).catch(() => {}); });
    contents.on("did-finish-load", () => contents.send("rail:framed", framed));
    void contents.loadURL(url()).catch((error) => log(`chrome rail: ${error?.message ?? error}`));
    return view;
  };
  const rail = {
    /** The window the rail stands beside: its size moves the rail, and each of its documents gets the room again. */
    attach(next) {
      win = next;
      shown = false; expanded = false; offered = false; hung = false; told = "";
      framed = prefs()?.windowFrame?.() !== false;
      // The window's first document has the same time as any other to offer the button and to draw the frame.
      if (choseHidden()) startGrace(); else stopGrace();
      awaitFrame();
      win.on("resize", layout);
      const contents = win.webContents;
      // Each new document is told again, once it is ready.
      contents.on("dom-ready", () => { if (shown) tellPage(); });
      contents.on("did-navigate", nextDocument);
      contents.on("render-process-gone", nextDocument);
      // Electron 43 reports an error page that replaced the document here, not as did-navigate.
      contents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => { if (mainFrame && code !== ABORTED) nextDocument(); });
      contents.on("unresponsive", () => { hung = true; rail.refresh(); });
      contents.on("responsive", () => { hung = false; rail.refresh(); });
      win.once("closed", () => {
        if (view && !view.webContents.isDestroyed()) view.webContents.close?.({ waitForBeforeUnload: false });
        stopGrace(); clearTimeout(frameGrace); frameGrace = null;
        view = null; win = null; shown = false; expanded = false; offered = false;
      });
      rail.refresh();
    },
    /** Shown while there are two places or more (railPlaces) and the person hasn't hidden it; the page beside it has the
     * whole window otherwise. */
    refresh() {
      const on = alive() && wanted() && !hidden();
      if (on === shown) layout();
      else {
        shown = on;
        if (on) {
          win.contentView.addChildView(ensureView());
          layout();
        } else {
          expanded = false;
          if (view) win.contentView.removeChildView(view);
        }
        tellPage();
        changed();
      }
      tellState();
    },
    /** A sheet of the rail's is open: the view covers the window until it closes. */
    expand(on) {
      const was = expanded;
      expanded = on === true && shown;
      layout();
      // The keyboard goes with the sheet, and back to the page once it closes.
      if (expanded) view?.webContents.focus();
      else if (was) page()?.focus?.();
    },
    /** The rail's own page asks (never a place's page). */
    owns: (event) => Boolean(view && event?.sender === view.webContents && event.senderFrame === view.webContents.mainFrame),
    shown: () => shown,
    framed: () => framed,
    expanded: () => expanded,
    /** The rail's page asks for the whole window while a sheet of its own is open, and gives it back after. The page
     * beside it offers the button that hides and shows it; asking is the offer, made again by each document. */
    install(ipcMain) {
      ipcMain.handle("rail:expand", (event, on) => {
        if (!rail.owns(event)) throw new Error("rail:expand is only available to the window's rail");
        rail.expand(on === true);
      });
      // Security: the page beside the rail learns only whether there is one to hide, never the places on it.
      const fromPage = (channel, act) => ipcMain.handle(channel, (event, ...values) => {
        if (!pageBeside(event)) throw new Error(`${channel} is only available to the page beside the window's rail`);
        offered = true; stopGrace();
        act(...values);
        const state = pageState();
        told = JSON.stringify(state);
        rail.refresh();
        return state;
      });
      fromPage("rail:offer", () => {});
      fromPage("rail:hide", (hide) => prefs()?.setRailHidden(hide === true));
      ipcMain.handle("rail:draws-frame", (event, drawn) => {
        if (!pageBeside(event)) throw new Error("rail:draws-frame is only available to the page beside the window's rail");
        frameDrawn(drawn !== false);
      });
    },
    /** Tells the rail's page something (the places changed, the skin of the page beside it). */
    send(channel, ...values) {
      if (view && !view.webContents.isDestroyed()) view.webContents.send(channel, ...values);
    },
  };
  return rail;
}
