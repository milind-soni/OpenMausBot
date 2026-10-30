import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hook = vi.hoisted(() => ({
  subscribe: undefined as undefined | ((listener: () => void) => () => void),
  snapshot: undefined as undefined | (() => string | null),
  serverSnapshot: undefined as undefined | (() => string | null),
}));

vi.mock("react", () => ({
  useSyncExternalStore: (
    subscribe: (listener: () => void) => () => void,
    snapshot: () => string | null,
    serverSnapshot: () => string | null,
  ) => {
    Object.assign(hook, { subscribe, snapshot, serverSnapshot });
    return snapshot();
  },
}));

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, value)),
    removeItem: (key: string) => values.delete(key),
    clear: () => values.clear(),
  };
}

let local: ReturnType<typeof memoryStorage>;
let browser: EventTarget;

function storageEvent(key: string | null, storageArea: unknown = local) {
  browser.dispatchEvent(Object.assign(new Event("storage"), { key, storageArea }));
}

beforeEach(() => {
  vi.resetModules();
  local = memoryStorage();
  browser = new EventTarget();
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("window", browser);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("app language preference", () => {
  it("uses the server's language until this device picks one", async () => {
    const preference = await import("./language-preference");
    expect(preference.useLanguageChoice()).toBeNull();
    expect(hook.serverSnapshot!()).toBeNull();
    expect(preference.effectiveLanguage(preference.languageChoice(), "fr")).toBe("fr");
    expect(preference.effectiveLanguage(preference.languageChoice(), undefined)).toBe("");
  });

  it("saves the choice on this device without asking the server", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    let preference = await import("./language-preference");
    preference.setLanguageChoice("de");
    expect(local.getItem(preference.LANGUAGE_KEY)).toBe("de");
    expect(preference.effectiveLanguage(preference.useLanguageChoice(), "fr")).toBe("de");
    expect(fetch).not.toHaveBeenCalled();

    vi.resetModules();
    preference = await import("./language-preference");
    expect(preference.languageChoice()).toBe("de");
  });

  it("keeps an explicit follow-the-system choice over the server's language", async () => {
    const preference = await import("./language-preference");
    preference.setLanguageChoice("");
    expect(preference.languageChoice()).toBe("");
    expect(preference.effectiveLanguage(preference.languageChoice(), "fr")).toBe("");
  });

  it("notifies mounted consumers and follows another window's change", async () => {
    const preference = await import("./language-preference");
    preference.useLanguageChoice();
    const listener = vi.fn();
    const unsubscribe = hook.subscribe!(listener);
    preference.setLanguageChoice("ja");
    expect(listener).toHaveBeenCalledOnce();
    expect(hook.snapshot!()).toBe("ja");

    local.setItem(preference.LANGUAGE_KEY, "es");
    storageEvent(preference.LANGUAGE_KEY);
    expect(listener).toHaveBeenCalledTimes(2);
    expect(hook.snapshot!()).toBe("es");

    storageEvent("other-key");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it("keeps the choice for this session when storage is blocked", async () => {
    local.setItem.mockImplementation(() => { throw new Error("blocked"); });
    const preference = await import("./language-preference");
    preference.setLanguageChoice("uk");
    expect(preference.languageChoice()).toBe("uk");
  });
});

// The preload and main together: one pick for every page this desktop's window shows.
function desktopApp(saved: string | null = null) {
  const pages = new Set<(language: string) => void>();
  return {
    saved: () => saved,
    page() {
      let cached: string | null | undefined;
      let listener: ((language: string) => void) | undefined;
      const hear = (language: string) => { cached = language; listener?.(language); };
      pages.add(hear);
      return {
        choice: vi.fn(() => (cached === undefined ? (cached = saved) : cached)),
        set: vi.fn(async (language: string) => {
          cached = saved = language;
          for (const other of pages) if (other !== hear) other(language);
          return true;
        }),
        onChange: (next: (language: string) => void) => { listener = next; return () => { listener = undefined; }; },
      };
    },
  };
}

/** A page with its own storage, as each origin has: this computer's, a team's, My Cloud's. */
async function openPage(app: ReturnType<typeof desktopApp>, stored: string | null = null) {
  vi.resetModules();
  local = memoryStorage();
  if (stored !== null) local.setItem("omb-language", stored);
  const bridge = app.page();
  browser = Object.assign(new EventTarget(), { ogb: { desktopLanguage: bridge } });
  vi.stubGlobal("localStorage", local);
  vi.stubGlobal("window", browser);
  return { preference: await import("./language-preference"), storage: local, bridge };
}

describe("app language in the desktop app", () => {
  it("is the pick made on any page of the window, whichever place another page shows", async () => {
    const app = desktopApp();
    const thisComputer = await openPage(app);
    thisComputer.preference.setLanguageChoice("en");
    expect(thisComputer.preference.languageChoice()).toBe("en");
    expect(app.saved()).toBe("en");

    const team = await openPage(app);
    expect(team.storage.getItem("omb-language"), "the team's page has its own storage").toBeNull();
    expect(team.preference.languageChoice()).toBe("en");
    expect(team.preference.effectiveLanguage(team.preference.useLanguageChoice(), "de")).toBe("en");

    team.preference.setLanguageChoice("");
    const myCloud = await openPage(app, "ja");
    expect(myCloud.preference.languageChoice(), "System, picked on the team's page").toBe("");
    expect(myCloud.preference.effectiveLanguage(myCloud.preference.languageChoice(), "de")).toBe("");
  });

  it("follows a pick made on another page while this one is open", async () => {
    const app = desktopApp("de");
    const team = await openPage(app);
    team.preference.useLanguageChoice();
    const listener = vi.fn();
    const unsubscribe = hook.subscribe!(listener);
    expect(hook.snapshot!()).toBe("de");

    await app.page().set("en");
    expect(listener).toHaveBeenCalledOnce();
    expect(hook.snapshot!()).toBe("en");
    unsubscribe();
    await app.page().set("fr");
    expect(listener).toHaveBeenCalledOnce();
  });

  it("keeps System as the default, and the server's language, until a language is picked on this computer", async () => {
    const page = await openPage(desktopApp());
    expect(page.preference.languageChoice()).toBeNull();
    expect(page.preference.effectiveLanguage(page.preference.languageChoice(), "fr")).toBe("fr");
    expect(page.preference.effectiveLanguage(page.preference.languageChoice(), undefined)).toBe("");
    expect(page.bridge.set).not.toHaveBeenCalled();
  });

  it("carries a pick saved in a page's own storage into the app once", async () => {
    const app = desktopApp();
    const thisComputer = await openPage(app, "es");
    expect(thisComputer.preference.languageChoice()).toBe("es");
    expect(thisComputer.preference.languageChoice()).toBe("es");
    expect(thisComputer.bridge.set).toHaveBeenCalledOnce();
    expect(app.saved()).toBe("es");
    expect((await openPage(app)).preference.languageChoice()).toBe("es");
    const stale = await openPage(app, "fr");
    expect(stale.preference.languageChoice(), "the app's pick outranks a page's older one").toBe("es");
    expect(stale.bridge.set).not.toHaveBeenCalled();
  });
});
