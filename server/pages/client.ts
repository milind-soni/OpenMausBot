import type { PageFile } from "./bundle.ts";
import { pagesAuthHeaders, type PagesAccess } from "./access.ts";

export interface PageUsage { pages: number; limit: number }
export type PagesFailure = {
  ok: false;
  /** sign_in: no MausBot account here, or its sign-in ended. limit: the plan's pages are used up. gone: the page to update
   * or unpublish no longer exists (unpublished or taken down). refused: the page itself was refused (too big, a file type). */
  reason: "sign_in" | "limit" | "rate_limited" | "gone" | "refused" | "unavailable";
  message: string;
  usage?: PageUsage;
  upgrade?: boolean;
  plan?: string;
};
/** A bot's tool call: `assertActive` throws once its turn has ended, and `signal` aborts once its request is gone.
 * Security: each token and each upload or delete is preceded by `assertActive`, so a stopped turn changes no page. */
export interface PagesCall { assertActive?: () => void; signal?: AbortSignal }
export type Published = { ok: true; pageId: string; url: string; usage: PageUsage; badge: boolean };
export type Unpublished = { ok: true; pageId: string; usage: PageUsage | null };

interface Minted {
  token: string; pageId: string; uploadUrl: string; pageUrl: string;
  limits: { pages: number; bytes: number; files: number; perHour: number };
  limit?: { message: string; upgrade: boolean };
  plan?: string;
}

export const SIGN_IN_MESSAGE = "Publishing a page needs a MausBot account. Sign in to MausBot in the app's Settings, then ask again.";
const UNAVAILABLE = "Publishing isn't available right now. Try again in a few minutes.";
const NOT_TURNED_ON = "Publishing pages isn't turned on for this account yet.";
const TOKEN_TIMEOUT_MS = 15_000, UPLOAD_TIMEOUT_MS = 60_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

const fail = (reason: PagesFailure["reason"], message: string, extra: Partial<PagesFailure> = {}): PagesFailure => ({ ok: false, reason, message, ...extra });
const usageOf = (value: unknown): PageUsage | undefined => {
  const usage = value as { pages?: unknown; limit?: unknown } | null;
  return usage && Number.isInteger(usage.pages) && Number.isInteger(usage.limit) ? { pages: Number(usage.pages), limit: Number(usage.limit) } : undefined;
};
/** Security: an upload token goes only to an https Worker, or to a loopback stand-in in development and tests. */
const safeUrl = (value: unknown): URL | null => {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.has(url.hostname)) ? url : null;
  } catch {
    return null;
  }
};
const readJson = async (response: Response): Promise<Record<string, unknown>> => {
  try {
    const body = await response.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
};
const callSignal = (call: PagesCall, ms: number) => call.signal ? AbortSignal.any([call.signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
const said = (body: Record<string, unknown>, fallback: string) => typeof body.message === "string" && body.message.trim() ? body.message.trim().slice(0, 500) : fallback;

export function createPagesClient(options: { access: () => PagesAccess | null; notOffered?: () => boolean; fetch?: typeof fetch; now?: () => number }) {
  const http = options.fetch ?? fetch, now = options.now ?? Date.now;

  const mint = async (action: "create" | "update" | "delete", call: PagesCall, pageId?: string): Promise<Minted | PagesFailure> => {
    const access = options.access();
    if (!access) return options.notOffered?.() ? fail("unavailable", NOT_TURNED_ON) : fail("sign_in", SIGN_IN_MESSAGE);
    const body = JSON.stringify(pageId ? { action, pageId } : { action });
    let response: Response;
    call.assertActive?.();
    try {
      response = await http(access.url, { method: "POST", redirect: "error", signal: callSignal(call, TOKEN_TIMEOUT_MS), body,
        headers: { "content-type": "application/json", accept: "application/json", ...pagesAuthHeaders(access, body, now()) } });
    } catch {
      return fail("unavailable", UNAVAILABLE);
    }
    const answer = await readJson(response);
    if (response.status === 401) return fail("sign_in", access.kind === "desktop" ? "Your MausBot sign-in has ended. Sign in to MausBot again in the app's Settings, then ask again." : UNAVAILABLE);
    if (response.status === 402) {
      const usage = usageOf(answer.usage);
      return fail("limit", said(answer, "This account's pages are used up."), { ...(usage ? { usage } : {}), upgrade: answer.upgrade === true,
        ...(typeof answer.plan === "string" && /^[a-z][a-z0-9-]{0,23}$/.test(answer.plan) ? { plan: answer.plan } : {}) });
    }
    if (response.status === 429) return fail("rate_limited", said(answer, "You've published a lot this hour. Try again in a few minutes."));
    const uploadUrl = safeUrl(answer.uploadUrl)?.href.replace(/\/+$/, ""), pageUrl = safeUrl(answer.pageUrl)?.href;
    if (!response.ok || typeof answer.token !== "string" || typeof answer.pageId !== "string" || !uploadUrl || !pageUrl || !answer.limits) {
      return fail("unavailable", response.status === 404 ? NOT_TURNED_ON : UNAVAILABLE);
    }
    const limit = answer.limit as Minted["limit"];
    return { token: answer.token, pageId: answer.pageId, uploadUrl, pageUrl, limits: answer.limits as Minted["limits"], ...(typeof answer.plan === "string" ? { plan: answer.plan } : {}),
      ...(limit && typeof limit.message === "string" ? { limit: { message: limit.message, upgrade: limit.upgrade === true } } : {}) };
  };

  const workerFailure = (status: number, body: Record<string, unknown>, minted: Minted): PagesFailure => {
    if (status === 402) {
      const usage = usageOf(body.usage);
      return fail("limit", minted.limit?.message ?? said(body, "This account's pages are used up."), { ...(usage ? { usage } : {}), upgrade: minted.limit?.upgrade ?? false,
        ...(minted.plan ? { plan: minted.plan } : {}) });
    }
    if (status === 404 || status === 410) return fail("gone", said(body, "That page no longer exists."));
    if (status === 429) return fail("rate_limited", said(body, "You've published a lot this hour. Try again in a few minutes."));
    if (status === 400 || status === 413 || status === 415) return fail("refused", said(body, "The pages service couldn't take this page."));
    return fail("unavailable", UNAVAILABLE);
  };

  return {
    /** A new page (no `pageId`), or new files at an existing page's same link. */
    async publish(input: { title: string; files: readonly PageFile[]; pageId?: string }, call: PagesCall = {}): Promise<Published | PagesFailure> {
      const minted = await mint(input.pageId ? "update" : "create", call, input.pageId);
      if ("ok" in minted) return minted;
      const bytes = input.files.reduce((sum, file) => sum + file.data.byteLength, 0);
      if (input.files.length > minted.limits.files) return fail("refused", `A page can have at most ${minted.limits.files} files.`);
      if (bytes > minted.limits.bytes) return fail("refused", `A page can be at most ${minted.limits.bytes} bytes.`);
      const form = new FormData();
      form.set("manifest", JSON.stringify({ title: input.title, files: input.files.map((file) => ({ path: file.path, size: file.data.byteLength })) }));
      input.files.forEach((file, index) => form.set(`f${index}`, new Blob([new Uint8Array(file.data)])));
      let response: Response;
      call.assertActive?.();
      try {
        response = await http(`${minted.uploadUrl}/v1/pages/${minted.pageId}`, { method: "PUT", redirect: "error", signal: callSignal(call, UPLOAD_TIMEOUT_MS),
          headers: { authorization: `Bearer ${minted.token}`, accept: "application/json" }, body: form });
      } catch {
        return fail("unavailable", UNAVAILABLE);
      }
      const body = await readJson(response);
      if (!response.ok) return workerFailure(response.status, body, minted);
      const usage = usageOf(body.usage);
      return { ok: true, pageId: minted.pageId, url: minted.pageUrl, usage: usage ?? { pages: 0, limit: minted.limits.pages }, badge: body.badge === true };
    },
    async unpublish(pageId: string, call: PagesCall = {}): Promise<Unpublished | PagesFailure> {
      const minted = await mint("delete", call, pageId);
      if ("ok" in minted) return minted;
      let response: Response;
      call.assertActive?.();
      try {
        response = await http(`${minted.uploadUrl}/v1/pages/${pageId}`, { method: "DELETE", redirect: "error", signal: callSignal(call, TOKEN_TIMEOUT_MS),
          headers: { authorization: `Bearer ${minted.token}`, accept: "application/json" } });
      } catch {
        return fail("unavailable", UNAVAILABLE);
      }
      const body = await readJson(response);
      if (!response.ok) return workerFailure(response.status, body, minted);
      return { ok: true, pageId, usage: usageOf(body.usage) ?? null };
    },
  };
}
export type PagesClient = ReturnType<typeof createPagesClient>;
