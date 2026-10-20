// This computer and My Cloud as one workspace in the real renderer, against two real servers and main's own wiring
// (testing/one-workspace-fixture.ts): this computer with Ember (sent to My Cloud) and Juno; My Cloud with Miso, Atlas,
// Kit and the Launch room. Prints both pages, then waits.
// Run: node --experimental-strip-types scripts/verify-one-workspace.ts
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import type { IncomingMessage, ServerResponse } from "node:http";
import { WELCOME_VERSION } from "../electron/onboarding-record.mjs";
import { SPOTLIGHTS } from "../src/lib/first-conversation.ts";
import { TOUR_STEPS } from "../src/lib/guided-tour.ts";
import { launchCloudSendFixture, type CloudSendFixture } from "./testing/cloud-send-fixture.ts";
import { seedOneWorkspace, wireOneWorkspace, type OneWorkspaceWiring } from "./testing/one-workspace-fixture.ts";
import { mountPreview, parkUntilSignal, type MountedPreview } from "./testing/preview-fixture.ts";

const environments = createRequire(import.meta.url)("../electron/environments.cjs");
export const PICTURE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

async function readJson(req: IncomingMessage): Promise<{ page?: string; args?: unknown[] }> {
  let text = "";
  for await (const chunk of req) text += chunk;
  try { return JSON.parse(text || "{}"); } catch { return {}; }
}
const reply = (res: ServerResponse, status: number, value: unknown) => { res.statusCode = status; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(value ?? null)); };

export interface OneWorkspacePages {
  local: MountedPreview;
  cloud: MountedPreview;
  one: OneWorkspaceWiring;
  close(): Promise<void>;
}

/** Both pages, each answering /__one with main's handlers as that page; an open answers where the window would go. */
export async function mountOneWorkspacePages(fx: CloudSendFixture): Promise<OneWorkspacePages> {
  const urls: { local?: string; cloud?: string } = {};
  let shown: "local" | "cloud" = "local";
  const one = wireOneWorkspace(fx, { shown: () => shown });
  const route = {
    path: /^\/__one\/([\w:-]+)$/, method: "POST",
    handler: async (req: IncomingMessage, res: ServerResponse, match: RegExpExecArray | null) => {
      const { page, args = [] } = await readJson(req);
      const asking = page === "cloud" ? "cloud" : "local";
      shown = asking;
      try {
        const answer = await one.call(match![1]!, asking, ...args);
        if (match![1] === "one-workspace:open") {
          shown = one.went.at(-1) === "cloud" ? "cloud" : "local";
          return reply(res, 200, { navigate: shown === "cloud" ? urls.cloud : urls.local });
        }
        reply(res, 200, answer);
      } catch (error) { reply(res, 400, { error: error instanceof Error ? error.message : String(error) }); }
    },
  };
  const menu = {
    path: "/__menu", method: "GET",
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const page = new URL(req.url ?? "/", "http://fixture").searchParams.get("page");
      const cloud = { id: "cloud", name: "My Cloud", origin: "https://omb-u-6b65ec5f6111.fly.dev" };
      const office = { id: "office", name: "Office server", origin: "https://office.example.test" };
      const state = { environments: [cloud, office], activeId: page === "cloud" ? "cloud" : "local" };
      const items = environments.workspaceMenuTemplate(state, { onSwitch() {}, onConnect() {}, onForget() {}, sublabels: { cloud: "Always on" }, ...one.menu(cloud) });
      reply(res, 200, items.map(({ click: _click, ...item }: Record<string, unknown>) => item));
    },
  };
  const local = await mountPreview({ info: { url: fx.desktopBase } }, { entry: "/scripts/testing/one-workspace-preview.tsx", route: "/__one-local.html",
    title: "This computer and My Cloud", logLevel: "warn", extraRoutes: [route, menu], proxyHeaders: { "x-openmausbot-desktop-owner": fx.ownerCapability } });
  const cloud = await mountPreview({ info: { url: fx.cloudBase } }, { entry: "/scripts/testing/one-workspace-preview.tsx", route: "/__one-cloud.html",
    title: "My Cloud", logLevel: "warn", extraRoutes: [route, menu], proxyHeaders: { ...fx.edge, authorization: `Bearer ${fx.owner}` } });
  urls.local = local.previewUrl;
  urls.cloud = cloud.previewUrl;
  return { local, cloud, one, close: async () => { await local.close(); await cloud.close(); } };
}

/** Both sides past their welcome, so a page opens straight on its chats. */
export async function welcomed(fx: CloudSendFixture): Promise<void> {
  const onboarding = { completedAt: new Date().toISOString(), version: WELCOME_VERSION, hintsSeen: [...TOUR_STEPS.map((step) => step.id), ...SPOTLIGHTS] };
  await fx.local("PATCH", "/api/config", { onboarding, language: "en" });
  await fx.onCloud("PATCH", "/api/config", { onboarding: { ...onboarding, hintsSeen: [...onboarding.hintsSeen, "cloud-welcome-done", "cloud-setup-hidden"] }, language: "en" });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fx = await launchCloudSendFixture({ onePasswordToken: `ops_fake-verify-${randomBytes(12).toString("hex")}` });
  let pages: OneWorkspacePages | undefined;
  try {
    await welcomed(fx);
    await seedOneWorkspace(fx, PICTURE);
    pages = await mountOneWorkspacePages(fx);
    console.log(JSON.stringify({ thisComputer: `${pages.local.previewUrl}?page=local`, myCloud: `${pages.cloud.previewUrl}?page=cloud`, desktop: fx.desktopBase, cloud: fx.cloudBase }, null, 2));
    await parkUntilSignal();
  } finally {
    await pages?.close();
    await fx.close();
  }
}
