// Box (box.ascii.dev) provider — the bot's cloud computer. Ported from
// agentcal-api src/providers/box.js, reshaped per-bot instead of
// per-customer: every bot gets one persistent box (deterministic name),
// stop pauses billing while the disk survives, and Join always mints a
// FRESH desktop URL (stream tokens rotate on every state change — never
// persist one).
//
// Substrate facts (probed by agentcal 2026-07-24 on a live box):
//   - REST only: POST /boxes/{id}/commands runs shell synchronously.
//   - stop→archived ~5s, resume→idle ~8s; disk persists, tmux does not.
//   - X11 desktop with Chrome + Ghostty; passwordless sudo; node 24.
//   - the dedicated IP rotates across archive/resume — never persist it.
import type { AppConfig } from "./config.ts";
import { ensureRemoteCuaCommand, remoteComputerBootstrapCommand } from "./remote-computer.ts";

// overridable so tests can point at a stub instead of the live provider
const BOX_API = process.env.OMB_BOX_API || "https://ascii.dev/api/box/v1";
const READY = new Set(["idle", "ready", "running"]);

function boxFetch(cfg: AppConfig, path: string, opts: RequestInit = {}) {
  return fetch(`${BOX_API}${path}`, {
    ...opts,
    headers: {
      authorization: `Bearer ${cfg.box?.token}`,
      "content-type": "application/json",
      ...opts.headers,
    },
  });
}

async function boxJson(cfg: AppConfig, path: string, opts: RequestInit = {}) {
  const res = await boxFetch(cfg, path, opts);
  const body: any = await res.json().catch(() => null);
  return { ok: res.ok && body?.ok !== false, status: res.status, body };
}

// deterministic per-bot name; the hash kills truncated-uuid collisions
async function boxNameFor(botId: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(botId));
  const hash = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 6);
  return `ogb-${botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "")}-${hash}`;
}

export async function runCommand(cfg: AppConfig, boxId: string, command: string, { timeoutMs = 120_000 } = {}) {
  const res = await boxFetch(cfg, `/boxes/${boxId}/commands`, {
    method: "POST",
    body: JSON.stringify({ command }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body: any = await res.json().catch(() => null);
  return {
    ok: res.ok && body?.exitCode === 0,
    exitCode: body?.exitCode ?? null,
    stdout: body?.stdout ?? "",
    stderr: body?.stderr ?? "",
  };
}

// Desktop access, in the order that actually works (agentcal probing):
//   1) VNC (POST /desktop?vnc=1) — plain WebSocket, survives P2P-blocking
//      networks; answers {provisioning:true} first, so poll for the URL.
//   2) WebRTC stream (POST /desktop) as fallback — STUN-only, can hang.
// The desktopUrl stored on the box object is NOT usable on its own.
async function mintDesktopUrl(cfg: AppConfig, boxId: string, { vncBudgetMs = 60_000 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < vncBudgetMs) {
    const { body } = await boxJson(cfg, `/boxes/${boxId}/desktop?vnc=1`, { method: "POST" });
    const url = body?.desktopUrl ?? body?.url;
    if (url) return url;
    if (!body?.provisioning) break;
    await new Promise((r) => setTimeout(r, 3000));
  }
  const { body } = await boxJson(cfg, `/boxes/${boxId}/desktop`, { method: "POST" });
  return body?.desktopUrl ?? body?.url ?? null;
}

async function waitReady(cfg: AppConfig, boxId: string, budgetMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const { body } = await boxJson(cfg, `/boxes/${boxId}`);
    const state = body?.box?.state;
    if (READY.has(state)) return body.box;
    if (state === "error") return null;
    // an archiving box can't resume until the snapshot lands — nudge after
    if (state === "archived") await boxJson(cfg, `/boxes/${boxId}/resume`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
}

// Resolving a bot's box means LISTing every box in the account, so it is
// the most expensive thing on any hot path. The name is deterministic, so
// once we know the id we can go straight at it — the cache is refreshed
// whenever the direct read fails (deleted/renamed box) and always carries
// the live state so callers can still see "archived".
const boxIdCache = new Map<string, string>();

export async function findBox(cfg: AppConfig, botId: string) {
  const cachedId = boxIdCache.get(botId);
  if (cachedId) {
    const { ok, body } = await boxJson(cfg, `/boxes/${cachedId}`);
    const box = body?.box;
    if (ok && box?.id && box.state !== "error") return box;
    boxIdCache.delete(botId); // gone or broken — fall back to the listing
  }
  const name = await boxNameFor(botId);
  const { body } = await boxJson(cfg, "/boxes");
  const found = (body?.boxes ?? []).find((b: any) => b.name === name && b.state !== "error") ?? null;
  if (found?.id) boxIdCache.set(botId, found.id);
  return found;
}

/** Ready-or-null without the LIST when we already know the box. */
export async function readyBox(cfg: AppConfig, botId: string, budgetMs = 60_000) {
  const box = await findBox(cfg, botId);
  if (!box) return null;
  if (READY.has(box.state)) return box;
  return waitReady(cfg, box.id, budgetMs);
}

export function boxConfigured(cfg: AppConfig) {
  return Boolean(cfg.box?.token);
}

/** Ask the provider whether a token is real, before we let someone save
 * it. Without this the paste "succeeds", and the first sign of trouble is
 * a 401 in a different panel minutes later, with nothing to act on. */
export async function verifyToken(token: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch(`${BOX_API}/boxes`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      // the common mistake is pasting some other credential entirely —
      // box API keys are prefixed, so say which thing is wrong
      return {
        ok: false,
        message: token.startsWith("box_")
          ? "ascii.dev rejected that token — it may have been revoked or expired. Copy a fresh one from your ascii.dev account."
          : "That doesn't look like a box API key: they start with box_. Copy the API key from your ascii.dev account (an account or session token won't work here).",
      };
    }
    return { ok: false, message: `ascii.dev returned ${res.status} for that token — try again in a moment.` };
  } catch {
    return { ok: false, message: "Couldn't reach ascii.dev to check that token — check your connection and retry." };
  }
}

/** Turn a provider refusal into something a person can act on. The
 * provider's own message is better than anything we can invent — it knows
 * the plan, the limit and the link — so prefer it and only fall back to
 * our own wording when it says nothing useful. */
export function boxErrorMessage(status: number, what: string, body?: any): string {
  const theirs = typeof body?.message === "string" ? body.message.trim() : "";
  const link = typeof body?.error?.details?.billingUrl === "string" ? body.error.details.billingUrl : "";
  if (status === 402) {
    // e.g. "Start the $20/month Box plan to create sandboxes."
    return [theirs || "ascii.dev needs a paid Box plan before it will create a computer.", link].filter(Boolean).join(" ");
  }
  if (status === 401 || status === 403) {
    return "your box token was rejected by ascii.dev — open App Settings and paste a current token (it starts with box_)";
  }
  if (status === 429) {
    return theirs || "ascii.dev is rate-limiting this account — wait a minute and try again";
  }
  return theirs ? `${what} failed: ${theirs}` : `${what} failed (${status})`;
}

/** Box state for the Computer panel. */
export async function boxStatus(cfg: AppConfig, botId: string) {
  if (!boxConfigured(cfg)) return { configured: false, box: null };
  const box = await findBox(cfg, botId);
  return {
    configured: true,
    box: box ? { boxId: box.id, state: box.state, desktopAvailable: box.desktopAvailable ?? null } : null,
  };
}

/**
 * Find-or-create the bot's persistent box, wait for ready, run the
 * idempotent bootstrap (screenshot tooling for the computer-use bridge +
 * a tmux welcome), and mint a fresh desktop URL.
 */
export async function provisionBox(cfg: AppConfig, botId: string, botName: string) {
  if (!boxConfigured(cfg)) {
    throw new Error('box provider not enabled — add {"box":{"token":"…"}} to ~/.openmausbot/config.json');
  }
  const vmName = await boxNameFor(botId);
  let box = await findBox(cfg, botId);
  let created = false;
  try {
    if (!box) {
      const createRes = await boxJson(cfg, "/boxes", {
        method: "POST",
        // substrate-side backstop: archives itself (billing pauses, disk
        // survives) if every stop path dies
        // The computer needs the user's desktop session, not the account
        // owner's host credentials. Keep provider-side env injection off so
        // API keys cannot silently appear inside the guest.
        body: JSON.stringify({ ttlSeconds: 8 * 60 * 60, noEnv: true }),
      });
      if (!createRes.ok || !createRes.body?.box?.id) {
        throw new Error(boxErrorMessage(createRes.status, "box create", createRes.body));
      }
      box = createRes.body.box;
      created = true;
      const rename = await boxJson(cfg, `/boxes/${box.id}`, {
        method: "PATCH",
        body: JSON.stringify({ name: vmName }),
      });
      if (!rename.ok) throw new Error(boxErrorMessage(rename.status, "box naming", rename.body));
    }
    const ready = await waitReady(cfg, box.id);
    if (!ready) throw new Error("box did not become ready within 90s — retry in a minute");

    // Install the exact Cua Driver executable in the background, keep its
    // daemon private to the VM, and retain X11 tooling as a degraded fallback.
    const bootstrap = remoteComputerBootstrapCommand(botName);
    let boot;
    for (let attempt = 0; attempt < 5; attempt++) {
      boot = await runCommand(cfg, box.id, bootstrap);
      if (boot.ok || boot.exitCode !== null) break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    if (!boot?.ok) {
      const detail = boot?.stderr?.slice(0, 200) || (boot?.exitCode != null ? `exit ${boot.exitCode}` : "no response");
      throw new Error(`box setup failed: ${detail}`);
    }

    const joinUrl = await mintDesktopUrl(cfg, box.id);
    if (!joinUrl) throw new Error("box desktop link could not be created");
    return { boxId: box.id, machineName: vmName, reused: !created, state: ready.state, joinUrl };
  } catch (error) {
    if (!created || !box?.id) throw error;
    const cleanup = await boxJson(cfg, `/boxes/${box.id}`, {
      method: "DELETE",
      headers: { "X-Ascii-Confirm-Delete": box.id },
    }).catch(() => null);
    boxIdCache.delete(botId);
    if (cleanup?.ok) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}. The new computer could not be removed automatically; delete box ${box.id} in ascii.dev.`);
  }
}

/** Wake the bot's box and return a FRESH desktop URL. */
export async function joinBox(cfg: AppConfig, botId: string) {
  const box = await findBox(cfg, botId);
  if (!box) throw new Error("no computer yet — provision it first");
  const ready = await waitReady(cfg, box.id);
  if (!ready) throw new Error("the box did not wake in time — try again");
  // Provider archive/resume preserves disk but not processes. Reattach the
  // driver daemon before handing the desktop back to the user.
  await runCommand(cfg, box.id, ensureRemoteCuaCommand(), { timeoutMs: 15_000 }).catch(() => null);
  return { joinUrl: await mintDesktopUrl(cfg, box.id), state: ready.state ?? null };
}

/** Archive the bot's box now (billing pauses, disk survives). */
export async function sleepBox(cfg: AppConfig, botId: string) {
  const box = await findBox(cfg, botId);
  if (!box) throw new Error("no computer for this bot");
  // Ask the browser's oldest (main) process to exit before the provider
  // snapshots the disk. This gives Chrome a chance to flush cookies and
  // session state instead of restoring a crash-marked profile next wake.
  const quiesceBrowser = [
    'for name in chrome google-chrome chromium chromium-browser; do pid=$(pgrep -o -x "$name" 2>/dev/null || true); [ -z "$pid" ] || kill -TERM "$pid" 2>/dev/null || true; done',
    'for i in 1 2 3 4 5 6 7 8; do if ! pgrep -x chrome >/dev/null 2>&1 && ! pgrep -x google-chrome >/dev/null 2>&1 && ! pgrep -x chromium >/dev/null 2>&1 && ! pgrep -x chromium-browser >/dev/null 2>&1; then break; fi; sleep 0.25; done',
  ].join("; ");
  await runCommand(cfg, box.id, quiesceBrowser, { timeoutMs: 5_000 }).catch(() => null);
  await boxJson(cfg, `/boxes/${box.id}/stop`, { method: "POST" }).catch(() => {});
  return { ok: true };
}

/** Owner-scoped shell for the Computer panel's console. */
export async function execOnBox(cfg: AppConfig, botId: string, command: string) {
  const box = await findBox(cfg, botId);
  if (!box) throw new Error("no computer for this bot yet");
  const ready = await waitReady(cfg, box.id, 60_000);
  if (!ready) throw new Error("box did not wake");
  const out = await runCommand(cfg, box.id, String(command ?? "").slice(0, 4000));
  return { exitCode: out.exitCode, stdout: out.stdout.slice(-4000), stderr: out.stderr.slice(-2000) };
}

// Screenshot for the Computer panel + screen-in-chat. Two hops: capture
// to a file on the box (scrot straight to JPEG — no ImageMagick startup
// unless a downscale is actually needed), then read the bytes back.
// Base64 over command stdout is NOT reliable for the panel's full-size
// frames (probed 2026-08-12: an otherwise-complete payload came back with
// a corrupted length), so the frame is always fetched over HTTP here.
const PANEL_PATH = "/tmp/ogb-panel.jpg";
const PANEL_WIDTH = 1024;
const SHOT_CMD = [
  "export DISPLAY=${DISPLAY:-:0}",
  `f=${PANEL_PATH}`,
  'w=$(xdotool getdisplaygeometry 2>/dev/null | cut -d" " -f1)',
  'case "$w" in ""|*[!0-9]*) w=0;; esac',
  'scrot -o -q 70 "$f" 2>/dev/null || import -window root -quality 70 "$f" 2>/dev/null || ffmpeg -y -f x11grab -i "$DISPLAY" -frames:v 1 -q:v 7 "$f" >/dev/null 2>&1',
  `if [ "$w" -gt ${PANEL_WIDTH} ] 2>/dev/null && command -v convert >/dev/null 2>&1; then convert "$f" -thumbnail ${PANEL_WIDTH}x -quality 70 "$f" 2>/dev/null || true; fi`,
  'test -s "$f" && echo captured',
].join("; ");

/** Read a file off the box as base64 — raw artifact bytes when the API
 * supports it (33% less transfer, no JSON envelope), else the files API. */
async function readFileBase64(cfg: AppConfig, boxId: string, path: string): Promise<string | null> {
  try {
    const res = await boxFetch(cfg, `/boxes/${boxId}/artifacts?path=${encodeURIComponent(path)}`);
    if (res.ok) {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length) return bytes.toString("base64");
    }
  } catch {
    /* fall through */
  }
  const { ok, body } = await boxJson(cfg, `/boxes/${boxId}/files?path=${encodeURIComponent(path)}&encoding=base64`);
  const content = body?.content;
  return ok && typeof content === "string" && content ? content : null;
}

/** `knownBoxId` skips box resolution entirely — the screen poller holds
 * the id for the whole turn and must not re-resolve it every frame. */
export async function screenshotBox(cfg: AppConfig, botId: string, knownBoxId?: string) {
  let boxId = knownBoxId;
  if (!boxId) {
    const box = await findBox(cfg, botId);
    if (!box) throw new Error("no computer for this bot yet");
    if (!READY.has(box.state)) throw new Error(`box is ${box.state}`);
    boxId = box.id as string;
  }
  const out = await runCommand(cfg, boxId, SHOT_CMD, { timeoutMs: 60_000 });
  if (!/captured/.test(out.stdout)) {
    throw new Error(out.stderr.slice(0, 200) || "screen capture failed on the box");
  }
  const data = await readFileBase64(cfg, boxId, PANEL_PATH);
  if (!data) throw new Error("could not read the frame back from the box");
  return { png: data, format: "jpeg" };
}
