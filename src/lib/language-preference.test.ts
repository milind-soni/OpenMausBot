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

  it("starts the pairing and sign-in pages in the saved language, not the browser's", async () => {
    local.setItem("omb-language", "pt-br");
    const preference = await import("./language-preference");
    expect(preference.startupLocaleTag("en-US")).toBe("pt-br");
    const { setLocale, t } = await import("./i18n");
    expect(setLocale(preference.startupLocaleTag("en-US"))).toBe("pt-br");
    expect(t("pair.signIn")).toBe("Entrar");
    setLocale("en");
  });

  it("starts in the browser's language until this device picks one", async () => {
    const preference = await import("./language-preference");
    expect(preference.startupLocaleTag("de-DE")).toBe("de-DE");
    preference.setLanguageChoice("");
    expect(preference.startupLocaleTag("de-DE")).toBe("de-DE");
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
