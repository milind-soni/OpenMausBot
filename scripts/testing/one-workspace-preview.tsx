// The whole app as the desktop app shows it, against scripts/verify-one-workspace.ts's two real servers: this computer's
// page (?page=local) or My Cloud's (?page=cloud). Only main's bridges are stand-ins: the one workspace calls main's own
// wiring through /__one, and where main would move the window, the page goes to the other preview. The switcher's native
// menu is drawn from main's own template (/__menu), since a page cannot show a native menu.
import { createRoot } from "react-dom/client";
import App from "../../src/App";
import { setAnalyticsEnabled, setEmailGateDone } from "../../src/lib/analytics";
import { initialDesktopCapabilities } from "../../src/lib/desktop";
import { NOTICES } from "../../src/lib/notices";
import { applySkin, type SkinId } from "../../src/lib/skins";
import type { OneWorkspaceView } from "../../shared/one-workspace";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const page = params.get("page") === "cloud" ? "cloud" : "local";

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const response = await fetch(`/__one/${channel}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ page, args }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error);
  return value as T;
}

async function showMenu() {
  const items = await (await fetch(`/__menu?page=${page}`)).json() as Array<{ id?: string; type?: string; label?: string; sublabel?: string; enabled?: boolean; checked?: boolean }>;
  document.querySelector("[data-menu-stand-in]")?.remove();
  const menu = document.createElement("div");
  menu.setAttribute("data-menu-stand-in", "");
  menu.setAttribute("role", "menu");
  menu.style.cssText = "position:fixed;left:12px;top:52px;z-index:80;min-width:330px;padding:5px;border-radius:9px;background:rgba(246,246,246,.97);color:#1d1d1f;box-shadow:0 10px 32px rgba(0,0,0,.28),0 0 0 .5px rgba(0,0,0,.25);font:13px -apple-system,BlinkMacSystemFont,sans-serif";
  for (const item of items) {
    if (item.type === "separator") { const line = document.createElement("div"); line.style.cssText = "height:1px;margin:5px 8px;background:rgba(0,0,0,.12)"; menu.append(line); continue; }
    const row = document.createElement("div");
    row.setAttribute("role", "menuitem");
    if (item.id) row.dataset.menuItem = item.id;
    row.style.cssText = `padding:4px 10px 4px 24px;border-radius:5px;position:relative;${item.enabled === false ? "color:#8e8e93" : ""}`;
    row.textContent = item.label ?? "";
    if (item.checked) { const mark = document.createElement("span"); mark.textContent = "✓"; mark.style.cssText = "position:absolute;left:8px"; row.prepend(mark); }
    if (item.sublabel) { const sub = document.createElement("div"); sub.textContent = item.sublabel; sub.style.cssText = "font-size:11px;color:#8e8e93"; row.append(sub); }
    menu.append(row);
  }
  document.body.append(menu);
  menu.addEventListener("click", () => menu.remove());
}

window.ogb = {
  platform: "darwin",
  getCapabilities: async () => initialDesktopCapabilities(),
  onCapabilitiesChanged: () => () => {},
  workspaces: { state: async () => page === "cloud" ? { local: false, name: "My Cloud", origin: location.origin } : { local: true, name: "This computer" }, menu: showMenu },
  oneWorkspace: {
    view: () => call<OneWorkspaceView | null>("one-workspace:view"),
    onView: () => () => {},
    open: async (target: { side: string; id: string }) => {
      const { navigate } = await call<{ navigate: string }>("one-workspace:open", target);
      location.href = `${navigate}${location.search.replace(/page=\w+/, `page=${target.side === "cloud" ? "cloud" : "local"}`)}`;
    },
    take: () => call<string | null>("one-workspace:take"),
  },
  ...(page === "local" ? { remoteClient: { active: false } } : {}),
} as unknown as typeof window.ogb;

setAnalyticsEnabled(false);
setEmailGateDone("skipped");
try {
  localStorage.setItem("omb-advanced-mode", params.get("advanced") === "1" ? "1" : "0");
  for (const notice of NOTICES) localStorage.setItem(notice, "1");
} catch {}
applySkin((params.get("skin") ?? "meadow") as SkinId);
createRoot(document.getElementById("root")!).render(<App />);
