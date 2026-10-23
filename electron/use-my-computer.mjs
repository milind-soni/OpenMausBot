// "Use my Mac" (my PC, this computer): one popup of this app's own that lets the person's bots on My Cloud use this
// computer as its own bots could, every part of "Let my bots use this Mac" at once: the internet connection, the usual
// folders read only, and apps and screen. It comes once after the move to My Cloud, and again only from a bot's link.
import capabilitiesModule from "./capabilities.cjs";

const { linuxLocalControlSupport, localComputerReady } = capabilitiesModule;
const PANES = Object.freeze(["accessibility", "screen"]);
/** Nobody typed for this long before the popup shows, so a key meant for the page never answers it. */
export const QUIET_MS = 5_000;
/** How long the popup waits for a window to show in; the next run asks again. */
export const WINDOW_WAIT_MS = 2 * 60_000;
/** How long the walk through macOS's permissions waits for the person to come back from System Settings. */
export const BACK_WAIT_MS = 10 * 60_000;

/** The macOS permissions computer control lacks, in the order they are asked for, from its own start-up failure
 * ("Accessibility and Screen Recording required"): reading it never asks macOS anything. */
export function missingPermissions(reason) {
  const list = typeof reason === "string" ? /((?:Accessibility|Screen Recording)(?: and (?:Accessibility|Screen Recording))?) required\b/iu.exec(reason)?.[1] ?? "" : "";
  return PANES.filter((pane) => (pane === "screen" ? /Screen Recording/iu : /Accessibility/iu).test(list));
}

/** Every part is lent: the internet connection, and apps and screen wherever computer control can work. */
export function fullyLent(lending, screenPossible) {
  return lending.on === true && lending.internet === true && (lending.screen === true || !screenPossible);
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
 *   computerUse: { possible: boolean, ready(): Promise<boolean>, missing(): Promise<string[]>, request(): Promise<unknown>, openSettings(pane: string): Promise<unknown>,
 *     returned(): Promise<void> },
 *   ask(input: { screen: boolean }): Promise<"use" | "later" | null>,
 *   store: { read(): unknown, write(value: unknown): void },
 *   log?(line: string): void,
 * }} deps `computerUse`: whether computer control can work on this computer at all, whether it works now, the macOS
 * permissions it still lacks, starting it again (which asks macOS for what it never asked), opening a permission's
 * System Settings pane, and the person coming back to the window. `ask`: the popup, null when there is no window for it.
 * `store`: that the popup came, and that apps and screen go on once computer control works.
 */
export function createUseMyComputer({ lending, computerUse, ask, store, log = () => {} }) {
  /** The popup, and what its answer starts: one at a time. */
  let asking = null;
  const read = () => {
    let value = null;
    try { value = store.read(); } catch {}
    return value && typeof value === "object" && value.v === 1 ? value : { v: 1 };
  };
  const write = (patch) => store.write({ ...read(), ...patch });
  const failed = (error) => log(`use my computer: ${error?.message ?? error}`);
  const alone = (work) => {
    asking ??= work().catch(failed).finally(() => { asking = null; });
    return asking;
  };

  /** Apps and screen once computer control works: macOS asks first for what it never asked; each permission still
   * missing then opens in System Settings, one after another, and computer control starts again each time the person
   * comes back. */
  async function grantScreen() {
    const works = async () => ((await computerUse.ready()) ? lending.lendScreen() : null);
    await computerUse.request();
    await computerUse.returned();
    for (const pane of PANES) {
      const lent = await works();
      if (lent) return lent;
      if (!(await computerUse.missing()).includes(pane)) continue;
      await computerUse.openSettings(pane);
      await computerUse.returned();
      await computerUse.request();
    }
    return works();
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
    write({ asked: true });
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
    if (read().asked) return screenOnceItWorks();
    const now = await lending.state();
    if (!now.available || asking || read().asked) return;
    if (!now.ownOff && !fullyLent(now, computerUse.possible)) {
      if (!(await computerUse.ready())) return alone(popup);
      await lending.lendByDefault();
    }
    write({ asked: true });
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
  };
}

const waitMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Main's side: computer control's running state (`connection`, never asking macOS) and its restart (`request`), System
 * Settings, the window and this app's own popup (`dialogs`), and a bot's link from My Cloud's page or this computer's.
 * @param {{
 *   ipcMain: { handle(channel: string, handler: (...args: any[]) => unknown): void },
 *   cloudPage(event: unknown): string | null,
 *   lending: Parameters<typeof createUseMyComputer>[0]["lending"],
 *   connection(): Promise<any>,
 *   request(): Promise<unknown>,
 *   openSettings(pane: string): unknown,
 *   window(): any,
 *   remote(): boolean,
 *   lastInput(): number,
 *   dialogs: { useMyComputer(parent: unknown, input: { screen: boolean }): Promise<"use" | "later"> },
 *   store: { read(): unknown, write(value: unknown): void },
 *   log?(line: string): void,
 *   platform?: string,
 *   env?: Record<string, string | undefined>,
 *   wait?(ms: number): Promise<void>,
 * }} deps
 */
export function installUseMyComputer({ ipcMain, cloudPage, lending, connection, request, openSettings, window, remote, lastInput, dialogs, store, log, platform = process.platform, env = process.env, wait = waitMs }) {
  const running = () => connection().catch(() => null);
  const useMyComputer = createUseMyComputer({
    lending,
    computerUse: {
      get possible() { return !remote() && (platform === "darwin" || platform === "win32" || linuxLocalControlSupport(platform, env).available); },
      ready: async () => localComputerReady(platform, await running()),
      missing: async () => (platform === "darwin" ? missingPermissions((await running())?.reason) : []),
      request: () => request(),
      openSettings: async (pane) => openSettings(pane),
      returned: () => backInWindow({ window, wait }),
    },
    async ask({ screen }) {
      const win = remote() ? null : await quietWindow({ window, lastInput, wait });
      return win ? dialogs.useMyComputer(win, { screen }) : null;
    },
    store,
    log,
  });
  // Security: the link only opens main's own popup, which the person answers; it never lends anything itself.
  ipcMain.handle("cloud-lending:offer", (event) => {
    if (!cloudPage(event)) throw new Error("cloud-lending:offer is only available in this app's window");
    void useMyComputer.again();
  });
  return useMyComputer;
}
