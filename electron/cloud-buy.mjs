// The buying sheet's main-process side: the email sign-in, the kept checkout page, the Cloud's name and colour, and
// "{name} is ready". Every handler takes the page's words as plain text and checks them here; no token, checkout
// address or account leaves main (Copy link writes the clipboard from here).
import environments from "./environments.cjs";
import { CHECKOUT_SOURCES } from "./cloud-account.mjs";
import { CLOUD_HOME_NAME } from "./cloud-home.mjs";
import nativeText from "./native-text.cjs";
import { dotIcons } from "./color-dot.mjs";

export const CLOUD_COLORS = environments.ENTRY_COLORS;
export const DEFAULT_CLOUD_COLOR = "blue";
export const CLOUD_NAME_MAX = 28;
/** Each colour in the default skin (src/lib/mascot.ts MAUS_COLORS), for the native menu's dot; the page uses the skin's own. */
export const CLOUD_COLOR_HEX = Object.freeze({ blue: "#377FE6", teal: "#01A492", purple: "#8057C8", orange: "#E78531", red: "#D94B52", yellow: "#D8A729" });
// oxlint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/;

export function cleanCloudName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim().replace(/\s+/g, " ");
  return name && [...name].length <= CLOUD_NAME_MAX && !CONTROL.test(name) ? name : null;
}
export const cleanCloudColor = value => (CLOUD_COLORS.includes(value) ? value : null);

/** The native switcher's dot for a saved colour (14 pt, sharp at 2x), drawn once per colour; null where it cannot be drawn. */
export const colorDotIcons = nativeImage => dotIcons(nativeImage, CLOUD_COLOR_HEX);

/** The name and colour chosen while the Cloud is set up, kept for its account until the Cloud is listed (userData). */
export function lookFile(file, fs) {
  let cached;
  return {
    read() {
      if (cached !== undefined) return cached;
      try {
        const saved = JSON.parse(fs.readFileSync(file(), "utf8"));
        cached = typeof saved?.accountId === "string" && cleanCloudName(saved.name) && cleanCloudColor(saved.color)
          ? { accountId: saved.accountId, name: cleanCloudName(saved.name), color: saved.color } : null;
      } catch { cached = null; }
      return cached;
    },
    write(value) {
      cached = value;
      try { fs.writeFileSync(file(), JSON.stringify(value), { mode: 0o600 }); } catch {}
    },
  };
}

/** One answer to "what is this Cloud called, in which colour": its Servers entry once listed, else what was chosen, else My Cloud. */
export function createCloudLook({ store, accountId, homeEntry, saveEntry }) {
  const chosen = () => { const saved = store.read(); return saved && saved.accountId === accountId() ? { name: saved.name, color: saved.color } : null; };
  const current = () => {
    const entry = homeEntry();
    if (entry) return { name: entry.name, color: cleanCloudColor(entry.color) ?? DEFAULT_CLOUD_COLOR };
    return chosen() ?? { name: CLOUD_HOME_NAME, color: DEFAULT_CLOUD_COLOR };
  };
  return {
    /** For the Servers entry made when the Cloud is ready (cloud-home.mjs withCloudHome). */
    pending: chosen,
    current,
    save(name, color) {
      const look = { name: cleanCloudName(name), color: cleanCloudColor(color) };
      if (!look.name || !look.color) throw new Error(`Choose a name of up to ${CLOUD_NAME_MAX} characters and one of the colours.`);
      const id = accountId();
      if (id) store.write({ accountId: id, ...look });
      const entry = homeEntry();
      if (entry) saveEntry(entry.origin, look);
      return current();
    },
  };
}

/** openmausbot://cloud, the same with or without a checkout waiting: the sheet while a purchase made here is under way
 * (a checkout opened in the last day, a payment being linked, setup), else Settings, which signs in or opens the Cloud. */
export function cloudLinkOpensSheet(state) {
  return Boolean((state?.checkout && !state.checkout.done) || (state?.adding && !state.adding.done) || state?.purchase || state?.machine?.status === "provisioning");
}

/** Paid, and the Cloud still being made: a payment linked, no machine yet, or one setting up. */
const settingUp = state => state?.status === "connected" && (Boolean(state.purchase) || state.machine?.status === "provisioning"
  || (state.entitlement?.status === "active" && !state.machine));

/**
 * "{name} is ready", once per checkout this app opened, or once for a setup this app watched (bought elsewhere, or the
 * app restarted mid-setup). Not when the sheet is open in the focused window: the sheet opens the Cloud itself
 * ("Opening in 3…"). A click opens the Cloud.
 */
export function createCloudReadyNotice({ Notification, focused, sheetOpen, name, open, shown = () => {}, t = nativeText.englishText.t }) {
  let announced = null, watched = false;
  return state => {
    if (settingUp(state)) { watched = true; return false; }
    const key = state?.checkout?.startedAt ?? (watched ? "watched-setup" : null);
    if (!key || state.status !== "connected" || state.machine?.status !== "ready" || announced === key) return false;
    announced = key; watched = false;
    if ((focused() && sheetOpen()) || !Notification.isSupported()) return false;
    const note = new Notification({ title: t("native.cloud.ready.title", { name: name() }), body: t("native.cloud.ready.body") });
    note.on("click", () => open());
    note.show();
    shown();
    return true;
  };
}

const plain = value => (typeof value === "string" ? value : "");
/** The sheet's own channels, each behind main's local-window guard. */
export function installCloudBuy({ ipcMain, guard, client, offersReady, clipboard, look }) {
  let sheetOpen = false;
  // A page that navigates away (Open {name} loads the Cloud) never says it closed: that navigation closes it.
  const watched = new WeakSet();
  const handle = (method, handler) => ipcMain.handle(`cloud-account:${method}`, guard(`cloud-account:${method}`, handler));
  handle("signInStart", (_event, email) => client().emailStart(plain(email)));
  handle("signInVerify", (_event, code) => client().emailVerify(plain(code)));
  handle("signInCancel", () => { client().emailCancel(); });
  handle("reopenCheckout", async (_event, plan, source) => {
    if (!(await offersReady())) throw new Error("MausBot Cloud isn't offered in this app.");
    const account = client();
    if (account.checkoutLink()) return account.reopenCheckout();
    if (typeof plan !== "string" || !CHECKOUT_SOURCES.includes(source)) throw new Error("Choose a plan to continue.");
    const offer = await account.offer();
    if (!offer?.plans.some(entry => entry.tier === plan)) throw new Error("Choose a plan to continue.");
    return account.reopenCheckout(plan, source);
  });
  handle("copyCheckoutLink", () => {
    const url = client().checkoutLink();
    if (url) clipboard.writeText(url);
    return Boolean(url);
  });
  handle("interest", () => client().interest("another_cloud"));
  handle("look", () => look.current());
  handle("setLook", (_event, name, color) => look.save(plain(name), plain(color)));
  handle("readySeen", () => { client().checkoutDone(); });
  handle("sheet", (event, open) => {
    sheetOpen = open === true;
    const page = event?.sender;
    if (sheetOpen && typeof page?.on === "function" && !watched.has(page)) {
      watched.add(page);
      for (const done of ["did-navigate", "destroyed"]) page.on(done, () => { sheetOpen = false; });
    }
  });
  return { sheetOpen: () => sheetOpen };
}
