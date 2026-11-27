// A person's team profile starts from the one they already use: the name and picture of this computer's Settings →
// Profile fill what their team profile lacks, each once (the team server keeps which), over their own team session.
// Nothing else of this computer goes up: never the address (the team's is their sign-in's), never About me, never anyone
// else's. A later change here is not carried over: the team profile is theirs to edit there.

export const SEED_PICTURE_MAX_BYTES = 10 * 1024 * 1024;
const PICTURE_TYPES = new Map([["image/png", "png"], ["image/jpeg", "jpg"], ["image/gif", "gif"], ["image/webp", "webp"]]);
const STORED_PICTURE = /^\/api\/attachments\/[A-Za-z0-9-]+\.(?:png|jpg|gif|webp)$/;
const NAME_MAX = 120;

/**
 * @param {{
 *   origin: string,
 *   teamFetch: typeof fetch,
 *   localRequest(route: string, init?: RequestInit): Promise<Response>,
 *   tries?: number,
 *   wait?(ms: number): Promise<void>,
 *   log?(line: string): void,
 * }} deps `teamFetch`: the window's own session with the team (its cookie), never another person's. `localRequest`: this
 * computer's server, as its owner. `tries`: how often to look for the window's session while the page signs in.
 * @returns {Promise<"seeded" | "nothing" | "signed-out" | "failed">}
 */
export async function seedTeamProfile({ origin, teamFetch, localRequest, tries = 10, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = () => {} }) {
  const team = (route, init = {}) => teamFetch(`${origin}${route}`, { credentials: "include", cache: "no-store", redirect: "error", ...init,
    headers: { accept: "application/json", origin, ...init.headers }, signal: AbortSignal.timeout(20_000) });
  try {
    let me = null;
    for (let attempt = 0; attempt < tries && !me; attempt++) {
      if (attempt) await wait(1_500);
      const response = await team("/api/me");
      if (response.status === 404) return "nothing";
      if (response.ok) me = await response.json();
      else await response.body?.cancel?.().catch(() => {});
    }
    if (!me) return "signed-out";
    const seeded = Array.isArray(me.seeded) ? me.seeded : [];
    const wantsName = !String(me.name ?? "").trim() && !seeded.includes("name");
    const wantsPicture = !me.avatarUrl && !seeded.includes("avatarUrl");
    if (!wantsName && !wantsPicture) return "nothing";

    const local = await localRequest("/api/config");
    if (!local.ok) return "nothing";
    const profile = (await local.json())?.profile ?? {};
    const offer = {};
    const name = typeof profile.name === "string" ? profile.name.replace(/\s+/g, " ").trim().slice(0, NAME_MAX) : "";
    if (wantsName && name) offer.name = name;
    if (wantsPicture && typeof profile.avatarUrl === "string" && STORED_PICTURE.test(profile.avatarUrl)) {
      const picture = await uploadPicture(profile.avatarUrl, localRequest, team);
      if (picture) offer.avatarUrl = picture;
    }
    if (!Object.keys(offer).length) return "nothing";
    const saved = await team("/api/me", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...offer, fillEmpty: true }) });
    if (!saved.ok) { log(`team profile: ${origin} kept nothing from this computer (${saved.status})`); return "failed"; }
    const { filled = [] } = await saved.json();
    if (filled.length) log(`team profile: ${origin} took this computer's ${filled.join(" and ")}`);
    return "seeded";
  } catch (error) {
    log(`team profile: could not fill in from this computer (${error?.message ?? error})`);
    return "failed";
  }
}

/** This computer's stored picture, sent as the person's own upload on the team; null when it is not a picture we take. */
async function uploadPicture(path, localRequest, team) {
  const local = await localRequest(path);
  const type = local.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!local.ok || !PICTURE_TYPES.has(type) || Number(local.headers.get("content-length") ?? 0) > SEED_PICTURE_MAX_BYTES) {
    await local.body?.cancel?.().catch(() => {});
    return null;
  }
  const bytes = new Uint8Array(await local.arrayBuffer());
  if (!bytes.byteLength || bytes.byteLength > SEED_PICTURE_MAX_BYTES) return null;
  const uploaded = await team("/api/attachments", { method: "POST", headers: { "content-type": type }, body: bytes });
  if (!uploaded.ok) return null;
  const stored = String((await uploaded.json())?.path ?? "").replaceAll("\\", "/").split("/").pop() ?? "";
  const url = `/api/attachments/${stored}`;
  return STORED_PICTURE.test(url) ? url : null;
}

/** One seed per team per run of the app, again only after it could not finish (the page was still signing in, or the
 * team did not answer). */
export function createTeamProfileSeeds(deps) {
  const done = new Set();
  return {
    opened(origin) {
      if (done.has(origin)) return;
      done.add(origin);
      void seedTeamProfile({ ...deps, origin }).then((outcome) => { if (outcome === "signed-out" || outcome === "failed") done.delete(origin); });
    },
  };
}
