// "Use my Mac" (my PC, this computer): one popup of this app's own that lets the person's bots on My Cloud use this
// computer as its own bots could, every part of "Let my bots use this Mac" at once: the internet connection, the usual
// folders read only, and apps and screen. It comes once per My Cloud on every computer signed in to it, when this app's
// page finds the moment, or after the move; again only from a bot's link.
import capabilitiesModule from "./capabilities.cjs";

const { linuxLocalControlSupport, localComputerReady } = capabilitiesModule;
const PANES = Object.freeze(["accessibility", "screen"]);
/** Nobody typed for this long before the popup shows, so a key meant for the page never answers it. */
export const QUIET_MS = 5_000;
/** How long the popup waits for a window to show in; the next run asks again. */
export const WINDOW_WAIT_MS = 2 * 60_000;
/** How long the walk through macOS's permissions waits for the person to come back from macOS's own prompt. */
export const BACK_WAIT_MS = 10 * 60_000;
/** The Clouds this computer was asked for, newest last. */
const CLOUDS_KEPT = 20;

/** The macOS permissions computer control lacks, in the order they are asked for, from its own start-up failure
 * ("Accessibility and Screen Recording required"): reading it never asks macOS anything. */
export function missingPermissions(reason) {
  const list = typeof reason === "string" ? /((?:Accessibility|Screen Recording)(?: and (?:Accessibility|Screen Recording))?) required\b/iu.exec(reason)?.[1] ?? "" : "";
  return PANES.filter((pane) => (pane === "screen" ? /Screen Recording/iu : /Accessibility/iu).test(list));
}

/** Every part is lent: the internet connection, folders, and apps and screen wherever computer control can work. The
 * terminal is no part of it: only this computer's own Settings turns it on. */
export function fullyLent(lending, screenPossible) {
  return lending.on === true && lending.internet === true && (lending.folders?.length ?? 0) > 0 && (lending.screen === true || !screenPossible);
}

/** Whether the popup is due for My Cloud `cloud` without a bot's link: once per computer and Cloud, unless every part is
 * lent already, the person turned lending off themselves, or the popup was answered for this Cloud (`kept.clouds`) or at
 * a move before answers were kept per Cloud (`kept.asked`). */
export function popupDue({ now, cloud, kept, screenPossible }) {
  if (typeof cloud !== "string" || !cloud || now?.available !== true || now.ownOff === true) return false;
  if (kept?.asked === true || (Array.isArray(kept?.clouds) && kept.clouds.includes(cloud))) return false;
  return !fullyLent(now, screenPossible);
}

/** The window to ask in: shown, loaded, and with nobody typing for QUIET_MS. Null when none is within WINDOW_WAIT_MS. */
export async function quietWindow({ window, lastInput, wait, now = Date.now }) {
  for (const started = now(); now() - started <= WINDOW_WAIT_MS; await wait(1_000)) {
    const win = window();
    if (win && !win.isDestroyed() && win.isVisible() && !win.webContents?.isLoading?.() && now() - lastInput() >= QUIET_MS) return win;
  }
  return null;
}

/** The person back in the window after macOS's own prompt or System Settings: at once when it kept focus, else when it
 * is focused again, at most BACK_WAIT_MS later. */
export async function backInWindow({ window, wait }) {
  await wait(1_500);
  const win = window();
  if (!win || win.isDestroyed() || win.isFocused()) return;
  await new Promise((resolve) => {
    let timer = null;
    const done = () => { win.removeListener("focus", done); if (timer) clearTimeout(timer); resolve(); };
    timer = setTimeout(done, BACK_WAIT_MS);
    timer.unref?.();
    win.once("focus", done);
  });
}

/**
 * @param {{
 *   lending: { state(): Promise<import("./cloud-lending-ipc.mjs").LendingNow>, lendByDefault(input?: { asked?: boolean }): Promise<import("./cloud-lending-ipc.mjs").PageLending | null>,
 *     lendScreen(): Promise<import("./cloud-lending-ipc.mjs").PageLending | null> },
 *   computerUse: { possible: boolean, ready(): Promise<boolean>, missing(): Promise<string[]>, request(): Promise<unknown>, returned(): Promise<void> },
 *   ask(input: { screen: boolean }): Promise<"use" | "later" | null>,
 *   store: { read(): unknown, write(value: unknown): void },
 *   cloud?(): string | null,
 *   log?(line: string): void,
 * }} deps `computerUse`: whether computer control can work on this computer at all, whether it works now, the macOS
 * permissions it still lacks, starting it again (which asks macOS for what it never asked), and the person coming back
 * to the window. `ask`: the popup, null when there is no window for it. `store`: for which Clouds the popup came, and
 * that apps and screen go on once computer control works. `cloud`: the My Cloud lending is for (its address), or null.
 */
export function createUseMyComputer({ lending, computerUse, ask, store, cloud = () => null, log = () => {} }) {
  /** The popup, and what its answer starts: one at a time. */
  let asking = null;
  const read = () => {
    let value = null;
    try { value = store.read(); } catch {}
    return value && typeof value === "object" && value.v === 1 ? value : { v: 1 };
  };
  const write = (patch) => store.write({ ...read(), ...patch });
  const askedHere = () => {
    const kept = read(), key = cloud();
    return kept.asked === true || (Boolean(key) && Array.isArray(kept.clouds) && kept.clouds.includes(key));
  };
  const answered = () => {
    const key = cloud();
    if (!key) return write({ asked: true });
    const before = Array.isArray(read().clouds) ? read().clouds.filter((entry) => typeof entry === "string" && entry !== key) : [];
    write({ clouds: [...before, key].slice(-CLOUDS_KEPT) });
  };
  const failed = (error) => log(`use my computer: ${error?.message ?? error}`);
  const alone = (work) => {
    asking ??= work().catch(failed).finally(() => { asking = null; });
    return asking;
  };

  /** Apps and screen once computer control works: each start of computer control asks macOS for what it never asked,
   * one permission after another, as long as the person allows each; nothing here opens System Settings. */
  async function grantScreen() {
    const works = async () => ((await computerUse.ready()) ? lending.lendScreen() : null);
    for (let missing = await computerUse.missing(); ;) {
      await computerUse.request();
      await computerUse.returned();
      const lent = await works();
      if (lent) return lent;
      const still = await computerUse.missing();
      if (!still.length || still.length >= missing.length) return null;
      missing = still;
    }
  }

  /** Every part at once: the internet connection and the usual folders now, apps and screen as soon as they work. */
  async function useAll() {
    const lent = await lending.lendByDefault({ asked: true });
    if (!lent?.on || lent.screen || !computerUse.possible) return;
    write({ screenWanted: true });
    if ((await grantScreen())?.screen) write({ screenWanted: undefined });
  }

  async function popup() {
    const answer = await ask({ screen: computerUse.possible });
    if (!answer) return;
    answered();
    if (answer === "use") await useAll();
  }

  /** Chosen before computer control worked: apps and screen go on once it does, unless lending is off by then. */
  async function screenOnceItWorks() {
    if (!read().screenWanted || !(await computerUse.ready())) return;
    const now = await lending.state();
    if (!now.available) return;
    if (now.on) await lending.lendScreen();
    write({ screenWanted: undefined });
  }

  async function firstTime() {
    if (askedHere()) return screenOnceItWorks();
    const now = await lending.state();
    if (!now.available || asking || askedHere()) return;
    if (!now.ownOff && !fullyLent(now, computerUse.possible)) {
      if (!(await computerUse.ready())) return alone(popup);
      await lending.lendByDefault();
    }
    answered();
  }

  async function due() {
    try { return popupDue({ now: await lending.state(), cloud: cloud(), kept: read(), screenPossible: computerUse.possible }); }
    catch (error) { failed(error); return false; }
  }

  return {
    /** Once after the move: nothing when every part is lent or the person turned lending off themselves, every part
     * silently when computer control already works here, else the popup. Called again on every run of the move. */
    offer: () => asking ?? firstTime().catch(failed),
    /** A bot's Use my Mac link: the same popup, whatever was answered before, unless every part is lent already. */
    again: () => asking ?? alone(async () => {
      const now = await lending.state();
      if (now.available && !fullyLent(now, computerUse.possible)) await popup();
    }),
    /** Computer control started, or started again. */
    changed: () => asking ?? screenOnceItWorks().catch(failed),
    /** Whether the popup is due for My Cloud now (popupDue). */
    due,
    /** This app's page found the moment (nothing else open, not mid-setup): the popup, if it is still due. */
    ask: () => asking ?? alone(async () => { if (await due()) await popup(); }),
  };
}

const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A language tag as a page names it ("de", "pt-BR"), or null. */
const languageTag = (value) => (typeof value === "string" && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/u.test(value) ? value : null);

/**
 * Main's side: computer control's running state (`connection`, never asking macOS) and its restart (`request`), the
 * window and this app's own popup (`dialogs`), in the language this app's page shows (else `locale()`), and the page's
 * two ways to ask for it: a bot's link, and the page's notices finding the moment for the popup that is due.
 * @param {{
 *   ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void },
 *   cloudPage(event: unknown): string | null,
 *   lending: Parameters<typeof createUseMyComputer>[0]["lending"],
 *   connection(): Promise<any>,
 *   request(): Promise<unknown>,
 *   window(): any,
 *   remote(): boolean,
 *   lastInput(): number,
 *   dialogs: { useMyComputer(parent: unknown, input: { screen: boolean, locale?: string }): Promise<"use" | "later"> },
 *   store: { read(): unknown, write(value: unknown): void },
 *   cloud?(): string | null,
 *   locale?(): string,
 *   log?(line: string): void,
 *   platform?: string,
 *   env?: Record<string, string | undefined>,
 *   wait?(ms: number): Promise<void>,
 * }} deps
 */
export function installUseMyComputer({ ipcMain, cloudPage, lending, connection, request, window, remote, lastInput, dialogs, store, cloud, locale = () => "en", log, platform = process.platform, env = process.env, wait = waitMs }) {
  const running = () => connection().catch(() => null);
  let shownIn = null;
  const useMyComputer = createUseMyComputer({
    lending,
    computerUse: {
      get possible() { return !remote() && (platform === "darwin" || platform === "win32" || linuxLocalControlSupport(platform, env).available); },
      ready: async () => localComputerReady(platform, await running()),
      missing: async () => (platform === "darwin" ? missingPermissions((await running())?.reason) : []),
      request: () => request(),
      returned: () => backInWindow({ window, wait }),
    },
    async ask({ screen }) {
      const win = remote() ? null : await quietWindow({ window, lastInput, wait });
      return win ? dialogs.useMyComputer(win, { screen, locale: shownIn ?? locale() }) : null;
    },
    store,
    cloud,
    log,
  });
  const fromPage = (channel, event, language) => {
    if (!cloudPage(event)) throw new Error(`${channel} is only available in this app's window`);
    shownIn = languageTag(language) ?? shownIn;
  };
  // Security: the page only says when, and in which language. Main decides whether the popup is due, draws it itself, and
  // lends only what the person chooses in it.
  ipcMain.handle("cloud-lending:offer", (event, language) => {
    fromPage("cloud-lending:offer", event, language);
    void useMyComputer.again();
  });
  ipcMain.handle("cloud-lending:due", (event) => {
    fromPage("cloud-lending:due", event);
    return useMyComputer.due();
  });
  ipcMain.handle("cloud-lending:ask", async (event, language) => {
    fromPage("cloud-lending:ask", event, language);
    await useMyComputer.ask();
  });
  return useMyComputer;
}
