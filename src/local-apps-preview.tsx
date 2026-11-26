// Dev-only gallery of saved apps, served at /local-apps-preview.html; not in the packaged app. It mounts the real apps
// page, app view and page toolbar over a fake store and answers every /api request itself, so nothing reaches a server.
// ?view=list|empty|app|toolbar|window|icons &place=computer|cloud &skin=midnight|daylight &long=1 (long names) &desktop=1 (the desktop
// app's bridge: Open in its own window and Install show, the first app installed) &many=1 (13 apps) &published=0 &act=menu|rename|removed|versions (opens that state once drawn)
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { AppMessage } from "@/components/app/AppMessage";
import { PublishedAppsPage } from "@/components/published-apps/PublishedAppsPage";
import { LocalAppWindow } from "./local-app-window";
import { appIconPng } from "@/lib/app-icon";
import { loadLocale } from "@/lib/i18n";
import { openLocalApp } from "@/lib/local-apps";
import { applySkinChoice, SKIN_IDS, type SkinId } from "@/lib/skins";
import { initialState, StoreContext, type Message } from "@/state/store";
import { botHtmlDocument } from "../shared/app-frame/document";
import type { AppPayload } from "../shared/app";
import type { LocalApp } from "../shared/local-apps";
import type { PublishedApp } from "../shared/published-apps";
import "./styles.css";

const params = new URLSearchParams(location.search);
const view = params.get("view") ?? "list";
const skin = params.get("skin") ?? "midnight";
const long = params.get("long") === "1";
applySkinChoice(SKIN_IDS.includes(skin as SkinId) ? (skin as SkinId) : "midnight");
await loadLocale(params.get("lang") ?? "en");

const now = Date.now();
const HOUR = 3_600_000, DAY = 24 * HOUR;
const BOTS = [
  { id: "mira", name: "Mira", color: "blue", threadId: "mira-main", tasks: [{ threadId: "mira-main" }, { threadId: "sales" }], messages: [] },
  { id: "otto", name: "Otto", color: "orange", threadId: "otto-main", tasks: [{ threadId: "otto-main" }], messages: [] },
  { id: "juno", name: "Juno", color: "green", threadId: "juno-main", tasks: [{ threadId: "juno-main" }], messages: [] },
];
const app = (id: string, name: string, botId: string, updated: number, more: Partial<LocalApp> = {}): LocalApp => {
  const bot = BOTS.find((one) => one.id === botId);
  return { id: `la_${id.padEnd(16, "0")}`, name, botId, bot: bot ? { name: bot.name, color: bot.color as never } : null, threadId: bot?.tasks.at(-1)?.threadId ?? "gone", messageId: `m-${id}`,
    versions: [{ rev: 0, at: now - updated }], rev: 0, createdAt: now - 9 * DAY, updatedAt: now - updated, manifest: { name }, chat: Boolean(bot), ...more };
};
const LOCAL: LocalApp[] = view === "empty" || params.get("saved") === "0" ? [] : [
  app("sales", long ? "Quarterly sales board for the north and east regions with returns" : "Sales board", "mira", 2 * HOUR,
    { versions: [0, 1, 2].map((rev) => ({ rev, at: now - (3 - rev) * HOUR })), rev: 2 }),
  app("rota", "Staff rota", "otto", 26 * HOUR),
  app("budget", "Household budget", "juno", 3 * DAY),
  app("reading", "Reading list", "mira", 9 * DAY),
  app("tide", "Tide times", "gone", 20 * DAY, { chat: false }),
  ...(params.get("many") === "1" ? [
    app("habits", "Habit tracker", "juno", 4 * HOUR), app("trip", "Lisbon trip plan", "otto", 30 * HOUR),
    app("recipes", "Recipe box", "mira", 2 * DAY), app("invoices", "Invoice checker", "otto", 5 * DAY),
    app("garden", "Garden watering", "juno", 6 * DAY), app("books", "Book club votes", "mira", 12 * DAY),
    app("gym", "Gym log", "gone", 15 * DAY, { chat: false }), app("rent", "Rent split", "otto", 25 * DAY),
  ] : []),
];
const PUBLISHED: PublishedApp[] = [
  { id: "page-bakery", source: "page", title: "Bakery order page", url: "https://bakery.example.mausbot.page/", bot: { id: "mira", name: "Mira" }, threadId: "sales",
    publishedAt: now - 2 * HOUR, access: "link", canDelete: true },
  { id: "netlify-rota", source: "netlify", title: "Team rota", url: "https://team-rota.netlify.app/", bot: { id: "otto", name: "Otto" }, threadId: "otto-main",
    publishedAt: now - 4 * DAY, access: "netlify-team", manageUrl: "https://app.netlify.com/projects/team-rota", canDelete: true },
];

const DASHBOARD = `<!doctype html><html><head><meta charset="utf-8"><style>
:root{color-scheme:light dark;--bg:#fbfbfa;--card:#fff;--ink:#1d1d1f;--muted:#6b6b70;--line:#e6e6e3;--bar:#3f7be0;--soft:#3f7be01f;--good:#1f8a55}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1c1c1f;--ink:#f1f1f2;--muted:#a1a1a8;--line:#2c2c30;--bar:#6d9df0;--soft:#6d9df026;--good:#4cc38a}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--bg);color:var(--ink)}
main{max-width:1120px;margin:0 auto;padding:24px}h1{font-size:22px;margin:0 0 4px}p.sub{margin:0 0 20px;color:var(--muted)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.kpi .label{color:var(--muted);font-size:12px}.kpi .value{font-size:26px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums}.kpi .delta{font-size:12px;color:var(--good)}
.grid{display:grid;grid-template-columns:2fr 1fr;gap:12px}@media (max-width:720px){.grid{grid-template-columns:1fr}}
h2{font-size:14px;margin:0 0 12px}svg{display:block;width:100%;height:auto}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}td,th{padding:8px 0;border-bottom:1px solid var(--line);text-align:start}th{color:var(--muted);font-weight:500;font-size:12px}td.n{text-align:end}
.bar{height:8px;border-radius:4px;background:var(--soft)}.bar>i{display:block;height:100%;border-radius:4px;background:var(--bar)}
</style></head><body><main>
<h1>Sales board</h1><p class="sub">North and East regions · updated this morning</p>
<section class="kpis">
<div class="card kpi"><div class="label">Revenue this month</div><div class="value">€48,210</div><div class="delta">+12% on October</div></div>
<div class="card kpi"><div class="label">Orders</div><div class="value">1,284</div><div class="delta">+8%</div></div>
<div class="card kpi"><div class="label">Average order</div><div class="value">€37.55</div><div class="delta">+3%</div></div>
<div class="card kpi"><div class="label">Returns</div><div class="value">2.1%</div><div class="delta">−0.4 pts</div></div>
</section>
<section class="grid">
<div class="card"><h2>Weekly revenue</h2>
<svg viewBox="0 0 600 220" role="img" aria-label="Weekly revenue, rising from 7,900 to 12,600 euros">
<g stroke="var(--line)" stroke-width="1"><line x1="40" y1="20" x2="590" y2="20"/><line x1="40" y1="80" x2="590" y2="80"/><line x1="40" y1="140" x2="590" y2="140"/><line x1="40" y1="200" x2="590" y2="200"/></g>
<g fill="var(--muted)" font-size="11"><text x="0" y="24">€15k</text><text x="0" y="84">€10k</text><text x="0" y="144">€5k</text><text x="0" y="204">€0</text></g>
<g fill="var(--bar)">${[79, 84, 92, 88, 101, 107, 115, 126].map((value, index) => `<rect x="${58 + index * 66}" y="${200 - value * 1.2}" width="40" height="${value * 1.2}" rx="4"/>`).join("")}</g>
<g fill="var(--muted)" font-size="11">${["W40", "W41", "W42", "W43", "W44", "W45", "W46", "W47"].map((label, index) => `<text x="${66 + index * 66}" y="216">${label}</text>`).join("")}</g>
</svg></div>
<div class="card"><h2>Top products</h2><table><thead><tr><th>Product</th><th class="n">Sold</th></tr></thead><tbody>
<tr><td>Sourdough loaf<div class="bar"><i style="width:92%"></i></div></td><td class="n">412</td></tr>
<tr><td>Croissant box<div class="bar"><i style="width:71%"></i></div></td><td class="n">318</td></tr>
<tr><td>Rye bread<div class="bar"><i style="width:48%"></i></div></td><td class="n">215</td></tr>
<tr><td>Cinnamon buns<div class="bar"><i style="width:36%"></i></div></td><td class="n">160</td></tr>
</tbody></table></div>
</section></main></body></html>`;

const page = (title: string, accent: string, body: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
:root{color-scheme:light dark;--bg:#fbfbfa;--card:#fff;--ink:#1d1d1f;--muted:#6b6b70;--line:#e6e6e3;--accent:${accent}}
@media (prefers-color-scheme:dark){:root{--bg:#141416;--card:#1c1c1f;--ink:#f1f1f2;--muted:#a1a1a8;--line:#2c2c30}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--ink)}
main{max-width:1120px;margin:0 auto;padding:32px}h1{font-size:28px;margin:0 0 20px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px}.tag{display:inline-block;padding:2px 10px;border-radius:999px;background:color-mix(in srgb,var(--accent) 18%,transparent);color:var(--accent);font-size:13px}
table{width:100%;border-collapse:collapse}td,th{padding:10px 8px;border-bottom:1px solid var(--line);text-align:start}th{color:var(--muted);font-weight:500}
.bar{height:10px;border-radius:5px;background:var(--accent)}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
const ROTA = page("Staff rota", "#d9822b", `<table><tr><th>Day</th><th>Morning</th><th>Afternoon</th><th>Close</th></tr>${["Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((day, n) =>
  `<tr><td>${day}</td><td><span class="tag">${["Ana", "Ben", "Cleo"][n % 3]}</span></td><td><span class="tag">${["Dev", "Eli", "Fay"][n % 3]}</span></td><td>${["Gus", "Hal"][n % 2]}</td></tr>`).join("")}</table>`);
const BUDGET = page("Household budget", "#1f8a55", `<div class="grid">${[["Rent", 72], ["Food", 48], ["Transport", 22], ["Energy", 35], ["Fun", 18], ["Savings", 60]].map(([label, value]) =>
  `<div class="card"><div>${label}</div><div style="font-size:26px;font-weight:600;margin:6px 0">€${Number(value) * 13}</div><div class="bar" style="width:${value}%"></div></div>`).join("")}</div>`);
const READING = page("Reading list", "#3f7be0", `<div class="grid">${["The Overstory", "Piranesi", "Klara and the Sun", "Project Hail Mary", "Circe", "The Dispossessed"].map((book, n) =>
  `<div class="card"><div style="height:120px;border-radius:10px;background:color-mix(in srgb,var(--accent) ${12 + n * 8}%,var(--card))"></div><p style="margin:10px 0 0;font-weight:600">${book}</p></div>`).join("")}</div>`);
const PAGES = [DASHBOARD, ROTA, BUDGET, READING];

const PAGE: AppPayload = { v: 1, source: "html", title: "Sales board", doc: "d2", rev: 2, history: ["d0", "d1"], bytes: 4200, border: true, network: { connect: [], resources: [] } };
const rows: Message[] = [
  { id: "m-sales", role: "bot", kind: "app", at: now, text: "[App] Sales board", app: PAGE },
  { id: "m-plain", role: "bot", kind: "app", at: now, text: "[App] Weekly plan", app: { ...PAGE, title: "Weekly plan", doc: "d9", rev: 0, history: [] } },
];

const reply = (body: unknown, status = 200) => Response.json(body, { status });
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, location.href);
  const path = url.pathname;
  if (path === "/api/local-apps" && init?.method === "POST") return reply({ app: LOCAL[0] }, 201);
  if (path === "/api/local-apps") return reply({ apps: LOCAL });
  if (path === "/api/published-apps") return reply({ apps: view === "empty" || params.get("published") === "0" ? [] : PUBLISHED });
  if (path === "/api/published-apps/framing") return reply({ framing: "blocked" });
  if (path.endsWith("/app")) {
    const id = path.split("/").at(-2) ?? "";
    const html = PAGES[LOCAL.findIndex((one) => one.id === id) % PAGES.length] ?? DASHBOARD;
    return reply(botHtmlDocument({ messageId: "m-sales", rev: Number(url.searchParams.get("rev") ?? 2), html }));
  }
  return reply({ error: "not in the preview" }, 404);
};

const config = { cloudHome: params.get("place") === "cloud" };
const state = { ...initialState, hydrated: true, bots: BOTS as never, config: config as never };
const store = { state, dispatch: () => {}, flushBotPatches: async () => null, refreshInstances: async () => {}, refreshModels: async () => {} };
if (view === "app") openLocalApp(LOCAL[0]!.id);
if (params.get("desktop") === "1" || view === "window") {
  let installed = [LOCAL[0]!.id];
  let onDesktop: string[] = [];
  (window as { ogb?: unknown }).ogb = {
    localApps: { openWindow: async () => true, openChat: async () => true },
    appInstall: {
      list: async () => ({ available: true, apps: installed.map((id) => ({ id, name: "", path: null, desktop: onDesktop.includes(id) })) }),
      install: async ({ id, name }: { id: string; name: string }) => { installed = [...installed, id]; return { ok: true, app: { id, name, path: null } }; },
      uninstall: async (id: string) => { installed = installed.filter((one) => one !== id); onDesktop = onDesktop.filter((one) => one !== id); return { ok: true, removed: true }; },
      addToDesktop: async (id: string) => { onDesktop = [...onDesktop, id]; return { ok: true, app: { id, name: "", path: null, desktop: true } }; },
      removeFromDesktop: async (id: string) => { onDesktop = onDesktop.filter((one) => one !== id); return { ok: true, removed: true }; },
      cleanup: async () => [],
    },
  };
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StoreContext.Provider value={store as never}>
      {view === "icons" ? (
        <main data-icons="" className="flex min-h-screen flex-wrap items-center justify-center gap-6 bg-app p-8" />
      ) : view === "window" ? (
        <LocalAppWindow id={LOCAL[0]!.id} />
      ) : view === "toolbar" ? (
        <main className="min-h-screen bg-app p-4 sm:p-8">
          <div className="mx-auto flex max-w-[760px] flex-col gap-6">
            {rows.map((row) => <AppMessage key={row.id} botId="mira" botName="Mira" threadId="sales" message={row} />)}
          </div>
        </main>
      ) : (
        <div className="flex h-screen bg-app"><PublishedAppsPage /></div>
      )}
    </StoreContext.Provider>
  </StrictMode>,
);

const act = params.get("act");
const click = (element: Element | null | undefined) => (element as HTMLElement | null | undefined)?.click();
const whenDrawn = (selector: string, run: () => void) => {
  const look = () => (document.querySelector(selector) ? run() : window.setTimeout(look, 50));
  look();
};
const menuRow = (name: string) => [...document.querySelectorAll("[role=menu] [role^=menuitem]")].find((row) => row.textContent?.includes(name));
const ready = () => { document.body.dataset.shotReady = ""; };
if (act === "menu" || act === "rename" || act === "removed") {
  whenDrawn("[data-thumbs-ready]", () => {
    click(document.querySelector("[data-local-app] [aria-haspopup], [data-local-app] [aria-expanded]"));
    window.setTimeout(() => {
      if (act === "rename") click(menuRow("Rename"));
      if (act === "removed") click(menuRow("Remove"));
      window.setTimeout(ready, 300);
    }, 300);
  });
}
if (act === "versions") whenDrawn("[data-local-app-version]", () => { click(document.querySelector("[data-local-app-version]")?.closest("button")); window.setTimeout(ready, 300); });
if (view === "icons") {
  whenDrawn("[data-icons]", () => void Promise.all(LOCAL.map((one) => appIconPng(one.name, one.bot?.color))).then((pngs) => {
    for (const png of pngs) {
      const image = document.createElement("img");
      if (png) image.src = URL.createObjectURL(new Blob([new Uint8Array(png)], { type: "image/png" }));
      image.width = image.height = 128;
      document.querySelector("[data-icons]")!.append(image);
    }
    window.setTimeout(ready, 300);
  }));
}
const thumbsReady = () => {
  const onScreen = [...document.querySelectorAll<HTMLElement>("[data-local-app-thumb]")].filter((thumb) => thumb.getBoundingClientRect().top < window.innerHeight);
  if (onScreen.length && onScreen.every((thumb) => thumb.dataset.localAppThumb === "live")) window.setTimeout(() => { document.body.dataset.thumbsReady = ""; }, 300);
  else window.setTimeout(thumbsReady, 100);
};
thumbsReady();
