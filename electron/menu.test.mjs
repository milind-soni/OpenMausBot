import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { name: "OpenMausBot" },
  Menu: { buildFromTemplate: (template) => template },
}));

import { readFileSync } from "node:fs";
import nativeText from "./native-text.cjs";
import { buildApplicationMenu } from "./menu.mjs";

describe("buildApplicationMenu", () => {
  const originalPlatform = process.platform;

  function withPlatform(platform, fn) {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      return fn();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }
  }

  const environments = [{ id: "x", name: "X", origin: "http://localhost" }];
  const build = (platform, overrides = {}) =>
    withPlatform(platform, () =>
      buildApplicationMenu({
        environments,
        activeId: "x",
        onSwitch: vi.fn(),
        onAddFromClipboard: vi.fn(),
        onForget: vi.fn(),
        ...overrides,
      }),
    );

  it.each(["darwin", "linux", "win32"])("lists a saved local environment by its folder, so switching servers never fails on %s", platform => {
    const onSwitch = vi.fn();
    const local = { id: "e1", kind: "local", name: "Work", dataDir: "/Users/me/.openmausbot-work" };
    const tailnet = { id: "t1", name: "Mac mini", origin: "https://mac-mini.tail1f3f14.ts.net" };
    const template = build(platform, { environments: [local, tailnet], activeId: "t1", onSwitch });
    const items = template.find(entry => entry.label === "Server").submenu;
    expect(items.find(entry => entry.label === "Work — /Users/me/.openmausbot-work")).toMatchObject({ checked: false });
    expect(items.find(entry => entry.label === "Mac mini — mac-mini.tail1f3f14.ts.net")).toMatchObject({ checked: true });
    items.find(entry => entry.label.startsWith("Work")).click();
    expect(onSwitch).toHaveBeenCalledWith("e1");
  });

  it.each(["darwin", "linux", "win32"])("offers Open at Login on %s, in the app menu on macOS and the File menu elsewhere", (platform) => {
    const onToggle = vi.fn();
    const template = build(platform, { openAtLogin: { checked: false, onToggle } });
    const item = template[0].submenu.find((entry) => entry.id === "open-at-login");
    expect(template[0].label).toBe(platform === "darwin" ? "OpenMausBot" : "File");
    expect(item).toMatchObject({ label: "Open at Login", type: "checkbox", checked: false });
    item.click();
    expect(onToggle).toHaveBeenCalledWith(true);
    expect(build(platform).flatMap((menu) => menu.submenu ?? []).some((entry) => entry.id === "open-at-login")).toBe(false);
  });

  it("macOS app menu wires an explicit Preferences item to the settings callback", () => {
    const onOpenSettings = vi.fn();
    const template = build("darwin", { onOpenSettings });
    const item = template[0].submenu.find((entry) => entry.label === "Preferences…");
    expect(item).toBeDefined();
    expect(item.accelerator).toBe("CmdOrCtrl+,");
    expect(item.click).toBeTypeOf("function");
    item.click();
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it.each(["linux", "win32"])("does not add an app menu on %s", (platform) => {
    const template = build(platform);
    expect(template[0].role).toBe("fileMenu");
    for (const item of template) {
      expect(item.label).not.toBe("OpenMausBot");
    }
  });

  it.each(["darwin", "linux", "win32"])("offers native organisation sign-in while a hosted workspace is active on %s", platform => {
    const onOrganizationSignIn = vi.fn();
    const template = build(platform, { onOrganizationSignIn });
    const item = template.find(entry => entry.label === "Server").submenu.find(entry => entry.id === "organization-sign-in");
    expect(item.label).toBe("Sign in with your organization…");
    item.click();
    expect(onOrganizationSignIn).toHaveBeenCalledOnce();
  });

  it("mirrors Add a Cloud… under the saved servers only when main offers it, and names My Cloud's line", () => {
    const servers = [{ id: "cloud", name: "My Cloud", origin: "https://omb-u-1.fly.dev" }];
    const without = build("darwin", { environments: servers }).find(entry => entry.label === "Server").submenu;
    expect(without.some(entry => entry.id === "add-cloud")).toBe(false);
    expect(without.find(entry => entry.type === "radio" && entry.label.startsWith("My Cloud")).label).toBe("My Cloud — omb-u-1.fly.dev");
    const onAddCloud = vi.fn();
    const submenu = build("darwin", { environments: servers, onAddCloud, sublabels: { cloud: "Always on" } }).find(entry => entry.label === "Server").submenu;
    expect(submenu.map(entry => entry.id ?? entry.label ?? entry.type).slice(0, 4)).toEqual(["This computer", "My Cloud — Always on", "add-cloud", "separator"]);
    submenu.find(entry => entry.id === "add-cloud").click();
    expect(onAddCloud).toHaveBeenCalledOnce();
    expect(submenu.find(entry => entry.id === "add-cloud").label).toBe("Add a Cloud…");
  });

  it("once My Cloud is home, lists only the other saved servers with Back to My Cloud, and has no Server menu without any", () => {
    const home = { origin: "https://omb-t-1.fly.dev", onBack: vi.fn() };
    const cloud = { id: "c", name: "My Cloud", origin: home.origin };
    const office = { id: "o", name: "Office", origin: "https://office.example.test" };
    const alone = build("darwin", { environments: [cloud], activeId: "c", home });
    expect(alone.find((entry) => entry.label === "Server")).toBeUndefined();
    const onSwitch = vi.fn();
    const both = build("darwin", { environments: [cloud, office], activeId: "o", home, onSwitch });
    const items = both.find((entry) => entry.label === "Server").submenu.filter((entry) => entry.label);
    expect(items.map((entry) => entry.label)).toEqual(["Back to My Cloud", "Office — office.example.test", "Add Server from Copied Pairing Link…", "Forget “Office”"]);
    items[0].click();
    expect(home.onBack).toHaveBeenCalledOnce();
    expect(items.some((entry) => /This computer|organization|Add a Cloud|Connect to a server/.test(entry.label))).toBe(false);
    const onCloud = build("darwin", { environments: [cloud, office], activeId: "c", home }).find((entry) => entry.label === "Server").submenu;
    expect(onCloud.find((entry) => entry.id === "back-to-my-cloud").enabled).toBe(false);
  });

  it("speaks Brazilian Portuguese: Servidor, Configurações… and This computer as the app names it", () => {
    const { t } = nativeText.createNativeText({ saved: "pt-br" });
    const pt = JSON.parse(readFileSync(new URL("../src/locales/pt-br.json", import.meta.url), "utf8"));
    const template = build("darwin", { t, activeId: "local", onAddCloud: vi.fn() });
    const server = template.find((entry) => entry.label === "Servidor");
    expect(server.submenu[0].label).toBe(pt["place.local"]);
    expect(server.submenu.find((entry) => entry.id === "add-cloud").label).toBe("Adicionar um Cloud…");
    expect(template[0].submenu.find((entry) => entry.accelerator === "CmdOrCtrl+,").label).toBe("Configurações…");
    expect(template[0].submenu.at(-1)).toEqual({ role: "quit", label: "Sair do app OpenMausBot" });
    expect(template.map((entry) => entry.label)).toEqual(["OpenMausBot", "Arquivo", "Editar", "Servidor", "Visualizar", "Janela"]);
    for (const platform of ["win32", "linux"]) expect(build(platform, { t })[0].submenu[0].label).toBe("Sair do OpenMausBot");
  });

  // Electron 43.7.9 lib/browser/api/menu-item-roles.ts: each role menu's default items, in order.
  const ELECTRON_DEFAULTS = {
    darwin: {
      fileMenu: ["close"],
      editMenu: ["undo", "redo", "-", "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll", "-",
        ["showSubstitutions", "-", "toggleSmartQuotes", "toggleSmartDashes", "toggleTextReplacement"], ["startSpeaking", "stopSpeaking"]],
      viewMenu: ["reload", "forceReload", "toggleDevTools", "-", "resetZoom", "zoomIn", "zoomOut", "-", "togglefullscreen"],
      windowMenu: ["minimize", "zoom", "-", "front"],
    },
    win32: {
      fileMenu: ["quit"],
      editMenu: ["undo", "redo", "-", "cut", "copy", "paste", "delete", "-", "selectAll"],
      viewMenu: ["reload", "forceReload", "toggleDevTools", "-", "resetZoom", "zoomIn", "zoomOut", "-", "togglefullscreen"],
      windowMenu: ["minimize", "zoom", "close"],
    },
  };
  ELECTRON_DEFAULTS.linux = ELECTRON_DEFAULTS.win32;
  const roles = (items) => items.map((item) => (item.type === "separator" ? "-" : item.submenu ? roles(item.submenu) : item.role));
  const labelled = (items) => items.flatMap((item) => (item.type === "separator" ? [] : [item, ...(item.submenu ? labelled(item.submenu) : [])]));

  it.each(["darwin", "win32", "linux"])("writes out Electron's own role menus on %s, each item with a label", (platform) => {
    const template = build(platform);
    for (const [role, expected] of Object.entries(ELECTRON_DEFAULTS[platform])) {
      const menu = template.find((entry) => entry.role === role);
      expect(roles(menu.submenu), role).toEqual(expected);
    }
    const items = labelled(template);
    expect(items.filter((item) => typeof item.label !== "string" || !item.label)).toEqual([]);
    expect(items.filter((item) => item.role).length).toBeGreaterThan(15);
  });

  it("keeps Electron's English labels for every role item in English", () => {
    const english = { close: "Close Window", undo: "Undo", redo: "Redo", cut: "Cut", copy: "Copy", paste: "Paste", pasteAndMatchStyle: "Paste and Match Style",
      delete: "Delete", selectAll: "Select All", showSubstitutions: "Show Substitutions", toggleSmartQuotes: "Smart Quotes", toggleSmartDashes: "Smart Dashes",
      toggleTextReplacement: "Text Replacement", startSpeaking: "Start Speaking", stopSpeaking: "Stop Speaking", reload: "Reload", forceReload: "Force Reload",
      toggleDevTools: "Toggle Developer Tools", resetZoom: "Actual Size", zoomIn: "Zoom In", zoomOut: "Zoom Out", togglefullscreen: "Toggle Full Screen",
      minimize: "Minimize", zoom: "Zoom", front: "Bring All to Front", about: "About OpenMausBot", hide: "Hide OpenMausBot", hideOthers: "Hide Others",
      unhide: "Show All", quit: "Quit OpenMausBot" };
    for (const item of labelled(build("darwin")).filter((entry) => entry.role && !entry.role.endsWith("Menu"))) expect(item.label, item.role).toBe(english[item.role]);
    expect(build("win32")[0].submenu[0].label).toBe("Exit");
    expect(build("linux")[0].submenu[0].label).toBe("Quit");
    expect(build("linux").find((entry) => entry.role === "windowMenu").submenu.at(-1).label).toBe("Close");
  });
});
