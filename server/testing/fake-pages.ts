// A stand-in for MausBot's pages: the Admin's token route and the pages Worker, as one fetch. Pages, quotas and tokens
// are kept in memory; nothing reaches the network.
import { pagesHomeSignature } from "../pages/access.ts";

export const FAKE_ADMIN = "https://cloud.example.test";
export const FAKE_TOKEN_URL = `${FAKE_ADMIN}/api/cloud/pages/token`;
export const FAKE_UPLOAD = "https://upload.pages.test";
export const FAKE_DESKTOP_TOKEN = `omb_pd_${"d".repeat(43)}`;
export const FAKE_HOME = { adminOrigin: FAKE_ADMIN, machineId: "cm-fake-home", bootstrapSecret: "b".repeat(43) };

/** `admin` and `upload`: the token route's and the Worker's origins (one loopback server can be both). */
export function fakePagesService(options: { quota?: number; plan?: string; admin?: string; upload?: string } = {}) {
  const tokenUrl = `${options.admin ?? FAKE_ADMIN}/api/cloud/pages/token`, upload = options.upload ?? FAKE_UPLOAD;
  const pages = new Map<string, { title: string; files: Map<string, string> }>();
  const tokens = new Map<string, { action: string; pageId: string }>();
  const minted: Array<{ action: string; pageId?: string; caller: "desktop" | "home" }> = [];
  const state = { quota: options.quota ?? 5, plan: options.plan ?? "free", down: false };
  let next = 0;
  const newId = () => `page${String(++next).padStart(22, "0")}`;
  const usage = () => ({ pages: pages.size, limit: state.quota });

  const caller = (request: Request, body: string): "desktop" | "home" | null => {
    if (request.headers.get("authorization") === `Bearer ${FAKE_DESKTOP_TOKEN}`) return "desktop";
    const machine = request.headers.get("x-omb-cloud-machine"), timestamp = request.headers.get("x-omb-cloud-timestamp") ?? "", nonce = request.headers.get("x-omb-cloud-nonce") ?? "";
    const expected = `v1=${pagesHomeSignature(FAKE_HOME.bootstrapSecret, FAKE_HOME.machineId, timestamp, nonce, body)}`;
    return machine === FAKE_HOME.machineId && request.headers.get("x-omb-cloud-signature") === expected ? "home" : null;
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    request.signal.throwIfAborted();
    if (state.down) throw new TypeError("fetch failed");
    if (url.href === tokenUrl) {
      const body = await request.text(), who = caller(request, body);
      if (!who) return Response.json({ error: "invalid_token", message: "Sign in to MausBot again to publish pages." }, { status: 401 });
      const { action, pageId } = JSON.parse(body) as { action: string; pageId?: string };
      minted.push({ action, ...(pageId ? { pageId } : {}), caller: who });
      if (action === "create" && pages.size >= state.quota) {
        return Response.json({ error: "page_limit", message: `You’ve used your ${state.quota} free pages. MausBot Cloud gives you more, and pages without the badge.`,
          usage: usage(), plan: state.plan, upgrade: true }, { status: 402 });
      }
      const id = action === "create" ? newId() : pageId!, token = `fake-token-${minted.length}`;
      tokens.set(token, { action, pageId: id });
      return Response.json({ token, pageId: id, action, uploadUrl: upload, pageUrl: `https://${id}.mausbot.page/`, plan: state.plan,
        limits: { pages: state.quota, bytes: 5 * 1024 * 1024, files: 200, perHour: 30 }, badge: state.plan === "free",
        ...(action === "create" ? { limit: { message: `You’ve used your ${state.quota} free pages.`, upgrade: true } } : {}) });
    }
    const page = /^\/v1\/pages\/([a-z0-9]+)$/.exec(url.pathname)?.[1];
    if (url.origin === new URL(upload).origin && page) {
      const grant = tokens.get(/^Bearer (.+)$/.exec(request.headers.get("authorization") ?? "")?.[1] ?? "");
      if (!grant || grant.pageId !== page) return Response.json({ error: "invalid_token", message: "This upload token is not valid." }, { status: 401 });
      tokens.delete(request.headers.get("authorization")!.slice(7));
      if (request.method === "DELETE") {
        if (!pages.delete(page)) return Response.json({ error: "not_found", message: "There is no such page on this account." }, { status: 404 });
        return Response.json({ pageId: page, state: "unpublished", usage: usage() });
      }
      if (grant.action === "update" && !pages.has(page)) return Response.json({ error: "unpublished", message: "This page was unpublished." }, { status: 410 });
      const form = await request.formData(), manifest = JSON.parse(String(form.get("manifest"))) as { title: string; files: Array<{ path: string }> };
      const files = new Map<string, string>();
      for (const [index, file] of manifest.files.entries()) files.set(file.path, await (form.get(`f${index}`) as Blob).text());
      pages.set(page, { title: manifest.title, files });
      return Response.json({ pageId: page, url: `https://${page}.mausbot.page/`, version: 1, badge: state.plan === "free", usage: usage() });
    }
    throw new Error(`Unexpected request to ${url.href}`);
  };

  return { fetch, pages, minted, state };
}
