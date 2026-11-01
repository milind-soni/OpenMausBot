import en from "../src/locales/en.json" with { type: "json" };
import zh from "../src/locales/zh.json" with { type: "json" };
import zhTw from "../src/locales/zh-tw.json" with { type: "json" };

const packs = { en, zh, "zh-tw": zhTw };
let languageOf = () => undefined;

export function setNativeLanguageResolver(resolve) {
  languageOf = resolve;
}

export function nativeLocale(language) {
  try {
    const locale = new Intl.Locale(language || "en").maximize();
    return locale.language === "zh" ? locale.script === "Hant" ? "zh-tw" : "zh" : "en";
  } catch {
    return "en";
  }
}

export function desktopText(key, params = {}, language = languageOf()) {
  const pack = packs[nativeLocale(language)];
  const template = (Object.hasOwn(pack, key) ? pack[key] : undefined) ?? (Object.hasOwn(en, key) ? en[key] : key);
  return template.replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(params, name) ? String(params[name]) : match);
}

const roles = ["about", "services", "hide", "hideOthers", "unhide", "quit", "close", "undo", "redo", "cut", "copy", "paste", "pasteAndMatchStyle", "delete", "selectAll", "reload", "forceReload", "toggleDevTools", "resetZoom", "zoomIn", "zoomOut", "togglefullscreen", "minimize", "zoom", "front", "windowMenu", "viewMenu", "fileMenu", "editMenu", "help", "startSpeaking", "stopSpeaking", "showSubstitutions", "toggleSmartQuotes", "toggleSmartDashes", "toggleTextReplacement"];
const roleKeys = new Map(roles.map(role => [role.toLowerCase(), `desktop.role.${role}`]));
const editGroupKeys = new Map([["Substitutions", "desktop.menuGroup.substitutions"], ["Speech", "desktop.menuGroup.speech"]]);

export function localizeNativeMenu(menu, language, appName) {
  if (nativeLocale(language ?? languageOf()) === "en") return menu;
  for (const item of menu.items ?? (Array.isArray(menu) ? menu : [])) {
    const role = item.role?.toLowerCase();
    const key = roleKeys.get(role);
    if (key) item.label = desktopText(key, { app: appName }, language);
    if (role === "editmenu") {
      for (const group of item.submenu?.items ?? (Array.isArray(item.submenu) ? item.submenu : [])) {
        const groupKey = !group.role && editGroupKeys.get(group.label);
        if (groupKey) group.label = desktopText(groupKey, {}, language);
      }
    }
    if (item.submenu) localizeNativeMenu(item.submenu, language, appName);
  }
  return menu;
}
