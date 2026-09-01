// computer-proxy — a minimal MCP stdio server the claude CLI spawns
// (agentcal's permission-proxy pattern, dedicated entry file so there is
// no argv-dispatch fork-bomb hazard). It gives the agent its bot's cloud
// computer (box.ascii.dev) as CUA-grade tools.
//
// Transport: every action goes through the box's REST run-command
// endpoint (no inbound port on the box, no tunnel), so a round trip is
// expensive (~TLS + shell spawn). The whole design is therefore built
// around ONE round trip per step:
//
//   act + settle + capture + base64 all run in a single shell command,
//   and the resulting frame rides back in the SAME tool result as an MCP
//   image block ("act and observe"). The agent never needs a follow-up
//   screenshot call, which halves the model inferences per UI step —
//   the same shape Anthropic's own computer-use loop uses.
//
// Other latency rules that live here:
//   - JPEG, not PNG (5-10x fewer bytes, identical vision tokens), and
//     the downscale only runs when the display is wider than the model's
//     coordinate space.
//   - Coordinate scaling happens box-side in shell arithmetic, so there
//     is no separate "what size is the display" round trip per turn.
//   - Frames come back inline in stdout when small enough; the files API
//     is only a fallback (one extra hop) for big ones.
//   - computer_batch runs a whole mechanical sequence (click, type, tab,
//     type, Enter) in one round trip with one frame at the end.
//
// stdout is the MCP channel — never console.log here.
import {
  normalizeBrowserUrl,
  normalizeCrop,
  ObservationCoordinator,
  parseBrowserTargets,
  safeBrowserUrl,
  type BrowserTarget,
  type CropRegion,
} from "./computer-observation.ts";
import { CONTROL_REFUSAL, createControlClient } from "./control-client.ts";
import {
  ensureRemoteCuaCommand,
  isolatedRemoteCommand,
  MAX_REMOTE_COMMAND_LENGTH,
  REMOTE_CUA_EXECUTABLE,
  REMOTE_CUA_SESSION,
  REMOTE_CUA_SOCKET,
  REMOTE_CUA_VERSION,
  semanticBrowserCommand,
} from "./remote-computer.ts";

const BOX_API = process.env.OGB_BOX_API ?? "https://ascii.dev/api/box/v1";
const boxId = process.env.OGB_BOX_ID ?? "";
const token = process.env.OGB_BOX_TOKEN ?? "";

// Who-is-driving: while the person holds control in the app, every tool
// below is refused (not queued — a queued click lands after they've moved
// on). Even screenshot: the person may be typing a credential, and the
// safest screen for the model to see is the one AFTER the hand-back.
/** Poll cadence while waiting for a hand-back, and the patience ceiling.
 * Env-tunable so the contract test doesn't spend wall-clock on it. */
const CONTROL_POLL_MS = Math.max(Number(process.env.OMB_CONTROL_POLL_MS) || 1_500, 25);
const CONTROL_WAIT_MS = Math.max(Number(process.env.OMB_CONTROL_WAIT_MS) || 600_000, 100);
// The cache must never outlive the poll cadence, or a hand-back would be
// seen a stale cache-window late.
const control = createControlClient({ cacheMs: Math.min(750, CONTROL_POLL_MS) });

/** The coordinate space the model sees: frames are downscaled to this
 * width, and clicks are scaled back up to the real display box-side. */
const SHOT_WIDTH = 1280;
const JPEG_QUALITY = 75;
const SHOT_PATH = "/tmp/ogb-shot.jpg";
/** How long the desktop gets to repaint before the fused capture. */
const SETTLE_MS = 350;
/** Gap between batched actions so focus changes land before typing. */
const ACTION_GAP_MS = 120;
const CHROME_PROFILE = "$HOME/.openmausbot/chrome-profile";
const CHROME_DEBUG_FLAGS =
  `--user-data-dir="${CHROME_PROFILE}" --password-store=basic --disable-session-crashed-bubble --no-first-run --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222`;
// Keep one durable browser identity regardless of which Chromium binary an
// image supplies. Existing profiles are merged without overwriting files and
// moved aside as backups before the conventional paths become symlinks.
const CHROME_PROFILE_SETUP = [
  `profile="${CHROME_PROFILE}"`,
  'mkdir -p "$profile" "$HOME/.config"',
  'chmod 700 "$profile"',
  'for browser_dir in "$HOME/.config/google-chrome" "$HOME/.config/chromium"; do',
  '  if [ -e "$browser_dir" ] && [ ! -L "$browser_dir" ]; then',
  '    if [ -d "$browser_dir" ] && ! cp -a -n "$browser_dir"/. "$profile"/; then',
  '      echo "failed to copy browser profile: $browser_dir" >&2',
  "      exit 1",
  "    fi",
  '    mv "$browser_dir" "$browser_dir.pre-openmausbot-$(date +%s)-$$"',
  "  fi",
  '  if [ -L "$browser_dir" ]; then rm -f "$browser_dir"; fi',
  '  ln -s "$profile" "$browser_dir"',
  "done",
].join("\n");
/** Frames larger than this come back over the files API instead of
 * inline stdout (keeps us clear of the command endpoint's stdout cap). */
const INLINE_MAX_BYTES = 400_000;

interface RunOut {
  ok: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Boxes archive themselves when idle (billing pauses, the disk survives),
 * which can happen mid-conversation — after that every command comes back
 * 409 machine_not_running. Wake it and carry on rather than handing the
 * agent a cryptic failure it can only guess at. */
async function resumeBox(): Promise<boolean> {
  const auth = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  await fetch(`${BOX_API}/boxes/${boxId}/resume`, { method: "POST", headers: auth }).catch(() => null);
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${BOX_API}/boxes/${boxId}`, { headers: auth }).catch(() => null);
    const body: any = await res?.json().catch(() => null);
    const state = body?.box?.state;
    if (state && ["idle", "ready", "running"].includes(state)) return true;
    if (state === "error") return false;
  }
  return false;
}

async function runOnBox(command: string, timeoutMs = 60_000, allowWake = true): Promise<RunOut> {
  // Old boxes may predate noEnv:true. Run every agent-issued command with an
  // explicit desktop-only environment so provider/account credentials cannot
  // leak through `computer_exec` or a child GUI process.
  const isolatedCommand = isolatedRemoteCommand(command);
  const res = await fetch(`${BOX_API}/boxes/${boxId}/commands`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ command: isolatedCommand }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body: any = await res.json().catch(() => null);
  if (res.status === 409 && allowWake) {
    const code = body?.code ?? body?.error?.code ?? "";
    if (/machine_not_running|box_starting|not_running|starting/i.test(String(code))) {
      const woke = await resumeBox();
      if (woke) return runOnBox(command, timeoutMs, false);
      return { ok: false, exitCode: null, stdout: "", stderr: "the computer is asleep and did not wake in time" };
    }
  }
  return {
    ok: res.ok && body?.exitCode === 0,
    exitCode: body?.exitCode ?? null,
    stdout: body?.stdout ?? "",
    stderr: body?.stderr ?? String(body?.message ?? (res.ok ? "" : `HTTP ${res.status}`)),
  };
}

const observations = new ObservationCoordinator();

function metricsText(): string {
  return JSON.stringify(observations.metrics);
}

async function browserTargets(countObservation = true): Promise<BrowserTarget[]> {
  // DevTools stays loopback-only inside the box. Only redacted fields are
  // ever formatted into tool output; comparisonUrl remains internal.
  const out = await runOnBox("curl -sf --max-time 2 http://127.0.0.1:9222/json/list", 5_000);
  const targets = out.ok ? parseBrowserTargets(out.stdout) : [];
  if (countObservation && targets.length) observations.noteStructuredObservation();
  return targets;
}

async function waitForNavigation(
  value: string,
  attempts = 3,
): Promise<{ ok: boolean; targets: BrowserTarget[] }> {
  const expected = normalizeBrowserUrl(value);
  if (!expected) {
    observations.noteVerification(false);
    return { ok: false, targets: [] };
  }
  let targets: BrowserTarget[] = [];
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      observations.noteRetry();
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    targets = await browserTargets(false);
    if (targets.some((target) => target.comparisonUrl === expected)) {
      observations.noteVerification(true);
      return { ok: true, targets };
    }
  }
  observations.noteVerification(false);
  return { ok: false, targets };
}

const ENV = 'export DISPLAY=${DISPLAY:-:0}';
const CUA_ENV = "CUA_DRIVER_INSTALL_CHANNEL=python_package CUA_DRIVER_RS_TELEMETRY_ENABLED=0";
/** Resolve the real display size into $W/$H for box-side click scaling. */
const GEOMETRY = [
  "g=$(xdotool getdisplaygeometry 2>/dev/null)",
  'W=${g%% *}',
  'H=${g##* }',
  `case "$W" in ''|*[!0-9]*) W=${SHOT_WIDTH}; H=0;; esac`,
].join("; ");

/** Shell that turns a screenshot-space coordinate into a display one.
 * The capture only downscales when the display is WIDER than the model's
 * space, so scaling must be conditional on exactly the same test — on a
 * 1024-wide desktop the frame is native size and a blind /1280 would put
 * every click at 80% of where the model aimed. */
function scaled(varName: string, value: number): string {
  const v = Math.round(value);
  return `if [ "$W" -gt ${SHOT_WIDTH} ] 2>/dev/null; then ${varName}=$(( ${v} * W / ${SHOT_WIDTH} )); else ${varName}=${v}; fi`;
}

/** Prefer the official driver but keep the proven X11 command as a degraded
 * path while a first install is finishing or if the daemon needs repair. */
function cuaOrX11(tool: string, argumentsShell: string, fallback: string): string {
  return [
    `if [ -x ${REMOTE_CUA_EXECUTABLE} ] && ${REMOTE_CUA_EXECUTABLE} status --socket ${REMOTE_CUA_SOCKET} >/dev/null 2>&1;`,
    `then if CUA_OUT=$(env ${CUA_ENV} ${REMOTE_CUA_EXECUTABLE} call ${tool} ${argumentsShell} --socket ${REMOTE_CUA_SOCKET} 2>/tmp/ogb-cua-call.error);`,
    `then echo "BACKEND CUA"; echo "CUA_RESULT $(printf %s "$CUA_OUT" | base64 -w0 2>/dev/null || printf %s "$CUA_OUT" | base64 | tr -d '\\n')"`,
    `else ${fallback}; X11_RC=$?; echo "BACKEND X11"; [ "$X11_RC" -eq 0 ]; fi`,
    `else ${fallback}; X11_RC=$?; echo "BACKEND X11"; [ "$X11_RC" -eq 0 ]; fi`,
  ].join(" ");
}

/** act → settle → capture → canonical hash → optional crop → inline bytes.
 * The hash is taken before cropping, so change detection always describes
 * the full screen. A requested crop fails closed when conversion fails. */
function captureBlock(settleMs = SETTLE_MS, crop: CropRegion | null = null): string {
  const downscale = crop
    ? `if [ "$W" -gt ${SHOT_WIDTH} ] 2>/dev/null; then if ! command -v convert >/dev/null 2>&1 || ! convert "$f" -thumbnail ${SHOT_WIDTH}x -quality ${JPEG_QUALITY} "$f" 2>/dev/null; then echo CROP_FAILED; exit 0; fi; fi`
    : `if [ "$W" -gt ${SHOT_WIDTH} ] 2>/dev/null && command -v convert >/dev/null 2>&1; then convert "$f" -thumbnail ${SHOT_WIDTH}x -quality ${JPEG_QUALITY} "$f" 2>/dev/null || true; fi`;
  const cropSteps = crop
    ? [
        `if ! command -v convert >/dev/null 2>&1 || ! convert "$f" -crop ${crop.width}x${crop.height}+${crop.x}+${crop.y} +repage "$f" 2>/dev/null; then echo CROP_FAILED; exit 0; fi`,
        `if [ ! -s "$f" ]; then echo CROP_FAILED; exit 0; fi`,
      ]
    : [];
  return [
    settleMs > 0 ? `sleep ${(settleMs / 1000).toFixed(2)}` : "true",
    `f=${SHOT_PATH}`,
    'raw=/tmp/ogb-shot.png',
    `rm -f "$f" 2>/dev/null || true`,
    `rm -f "$raw" 2>/dev/null || true`,
    `if [ -x ${REMOTE_CUA_EXECUTABLE} ] && ${REMOTE_CUA_EXECUTABLE} status --socket ${REMOTE_CUA_SOCKET} >/dev/null 2>&1 && env ${CUA_ENV} ${REMOTE_CUA_EXECUTABLE} call get_desktop_state ${shellQuote(JSON.stringify({ scope: "desktop", session: REMOTE_CUA_SESSION }))} --socket ${REMOTE_CUA_SOCKET} --screenshot-out-file "$raw" >/dev/null 2>&1 && command -v convert >/dev/null 2>&1 && convert "$raw" -quality ${JPEG_QUALITY} "$f" 2>/dev/null; then echo "CAPTURE CUA"; else scrot -o -q ${JPEG_QUALITY} "$f" 2>/dev/null || import -window root -quality ${JPEG_QUALITY} "$f" 2>/dev/null || ffmpeg -y -f x11grab -i "$DISPLAY" -frames:v 1 -q:v 6 "$f" >/dev/null 2>&1; echo "CAPTURE X11"; fi`,
    // only re-encode when the display is bigger than the model's space —
    // ImageMagick startup is the most expensive step in the old pipeline
    downscale,
    `if [ ! -s "$f" ]; then echo SHOT_FAILED; exit 0; fi`,
    'echo "GEOM $W $H"',
    'echo "HASH $(md5sum "$f" 2>/dev/null | cut -d\' \' -f1)"',
    ...cropSteps,
    's=$(stat -c%s "$f" 2>/dev/null || echo 0)',
    // SIZE is what makes the inline path safe: the frame is only trusted
    // when the bytes we decoded match the bytes the box says it wrote
    'echo "SIZE $s"',
    `if [ "$s" -gt 0 ] && [ "$s" -le ${INLINE_MAX_BYTES} ]; then echo "B64 $(base64 -w0 "$f" 2>/dev/null || base64 "$f" | tr -d '\\n')"; fi`,
  ].join("; ");
}

/** A frame is only trusted when the bytes are a WHOLE image. Checking the
 * magic number alone is not enough: the box's command stdout has been
 * observed truncating a payload, and a truncated JPEG still starts with a
 * valid header — it just renders as a grey half-frame for the model. So
 * every frame must also end with its terminator, and (when the box told
 * us how many bytes it wrote) match that length exactly. */
function wholeImage(bytes: Buffer, expectedBytes?: number): boolean {
  if (bytes.length < 512) return false;
  if (expectedBytes && bytes.length !== expectedBytes) return false;
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  const png = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  if (jpeg) {
    // EOI marker, allowing for trailing padding some encoders append
    const tail = bytes.subarray(Math.max(0, bytes.length - 32));
    return tail.includes(Buffer.from([0xff, 0xd9]));
  }
  if (png) {
    const tail = bytes.subarray(Math.max(0, bytes.length - 12));
    return tail.includes(Buffer.from("IEND", "ascii"));
  }
  return false;
}

/** Big frames (and any inline read that came back malformed) are fetched
 * over HTTP: raw artifact bytes first, the files API's base64-in-JSON
 * envelope second. Both are validated — an error page served with a 200
 * must fall through, not reach the model as an "image". */
async function fetchFrame(expectedBytes?: number): Promise<string | null> {
  const auth = { authorization: `Bearer ${token}` };
  try {
    const res = await fetch(
      `${BOX_API}/boxes/${boxId}/artifacts?path=${encodeURIComponent(SHOT_PATH)}`,
      { headers: auth, signal: AbortSignal.timeout(30_000) },
    );
    if (res.ok) {
      const bytes = Buffer.from(await res.arrayBuffer());
      if (wholeImage(bytes, expectedBytes)) return bytes.toString("base64");
    }
  } catch {
    /* fall through to the files API */
  }
  try {
    const res = await fetch(
      `${BOX_API}/boxes/${boxId}/files?path=${encodeURIComponent(SHOT_PATH)}&encoding=base64`,
      { headers: auth, signal: AbortSignal.timeout(30_000) },
    );
    const body: any = await res.json().catch(() => null);
    const content = body?.content;
    if (!res.ok || typeof content !== "string" || !content) return null;
    return wholeImage(Buffer.from(content, "base64"), expectedBytes) ? content : null;
  } catch {
    return null;
  }
}

interface Frame {
  data: string;
  mime: string;
  hash: string | null;
  geometry: { width: number; height: number } | null;
}

let inlineWorks = true; // flipped off for the proxy's life on first garbage
let lastDisplayGeometry: Frame["geometry"] = null;
let semanticBrowserUrl: string | null = null;
let semanticBrowserRefs = new Set<string>();

interface SemanticBrowserSnapshot {
  title: string;
  url: string;
  elements: Array<{ ref: string; role: string; name: string; disabled?: boolean }>;
}

function geometryFrom(stdout: string): Frame["geometry"] {
  const match = stdout.match(/^GEOM\s+(\d+)\s+(\d+)$/m);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

function automationSummary(stdout: string): string {
  if (/^BACKEND CUA$/m.test(stdout)) {
    const encoded = stdout.match(/^CUA_RESULT\s+([^\s]+)$/m)?.[1];
    if (!encoded) return `Cua Driver ${REMOTE_CUA_VERSION}`;
    try {
      const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
      const details = [result.effect, result.route, result.escalation]
        .filter((value): value is string => typeof value === "string" && Boolean(value))
        .slice(0, 3);
      return [`Cua Driver ${REMOTE_CUA_VERSION}`, ...details].join(" · ");
    } catch {
      return `Cua Driver ${REMOTE_CUA_VERSION}`;
    }
  }
  return /^BACKEND X11$/m.test(stdout) ? "X11 fallback" : "automation backend unavailable";
}

async function observationBounds(): Promise<{ width: number; height: number } | null> {
  let geometry = lastDisplayGeometry;
  if (!geometry) {
    const out = await runOnBox([ENV, GEOMETRY, 'echo "GEOM $W $H"'].join("; "), 15_000);
    geometry = geometryFrom(out.stdout);
    if (geometry) lastDisplayGeometry = geometry;
  }
  if (!geometry) return null;
  const scale = geometry.width > SHOT_WIDTH ? SHOT_WIDTH / geometry.width : 1;
  return {
    width: Math.round(geometry.width * scale),
    height: Math.round(geometry.height * scale),
  };
}

async function frameFrom(out: RunOut): Promise<Frame | null> {
  if (/SHOT_FAILED|CROP_FAILED/.test(out.stdout)) return null;
  let hash: string | null = null;
  let geometry: Frame["geometry"] = null;
  let inline = "";
  let size = 0;
  for (const line of out.stdout.split("\n")) {
    if (line.startsWith("HASH ")) hash = line.slice(5).trim() || null;
    else if (line.startsWith("SIZE ")) size = Number(line.slice(5).trim()) || 0;
    else if (line.startsWith("GEOM ")) {
      const [w, h] = line.slice(5).trim().split(/\s+/).map(Number);
      if (Number.isFinite(w) && w > 0) geometry = { width: w, height: Number.isFinite(h) ? h : 0 };
    } else if (line.startsWith("B64 ")) inline = line.slice(4).trim();
  }
  if (geometry?.height) lastDisplayGeometry = geometry;
  if (inline && inlineWorks) {
    const bytes = Buffer.from(inline, "base64");
    if (wholeImage(bytes, size || undefined)) return { data: inline, mime: "image/jpeg", hash, geometry };
    // stdout mangled it (the failure this channel is known for) — never
    // hand a partial frame to the model; fetch it and stop trusting stdout
    inlineWorks = false;
  }
  const fetched = await fetchFrame(size || undefined);
  if (!fetched) return null;
  return { data: fetched, mime: "image/jpeg", hash, geometry };
}

const send = (obj: unknown): void => {
  process.stdout.write(JSON.stringify(obj) + "\n");
};
const text = (id: unknown, t: string, isError = false): void =>
  send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: t }], isError: isError || undefined } });

/** An action result: the text plus the frame the action produced. When
 * the pixels are byte-identical to the frame the model just saw, the
 * image is dropped — it already has it, and it costs ~1.2k tokens. */
function observed(
  id: unknown,
  note: string,
  frame: Frame | null,
  crop: CropRegion | null = null,
  followsAction = true,
  isError = false,
) {
  if (!frame) {
    return text(id, `${note}\n(couldn't capture the screen — call screenshot to retry)`, isError);
  }
  const observation = observations.observeFrame(frame.hash ?? (crop ? null : frame.data), crop);
  if (!observation.changed) {
    // deliberately does NOT suggest repeating the action: the action may
    // well have landed, and re-clicking a button that already submitted
    // is the expensive kind of wrong
    const guidance = followsAction
      ? " Don't repeat the action — it may already have succeeded. If you expected a change, call screenshot again after it has had time to render."
      : " No new image is attached.";
    return text(id, `${note}\n(the screen is identical to the frame you already have.${guidance})`, isError);
  }
  send({
    jsonrpc: "2.0",
    id,
    result: {
      content: [
        { type: "text", text: note },
        { type: "image", data: frame.data, mimeType: frame.mime },
      ],
      isError: isError || undefined,
    },
  });
}

const OBSERVE_PROPS = {
  observe: {
    type: "boolean",
    description:
      "default true — return a fresh screenshot with the result. Set false only when chaining mechanical steps you don't need to see.",
  },
  settle_ms: { type: "number", description: "wait before the screenshot, default 350, max 3000" },
};

const TOOLS = [
  {
    name: "screenshot",
    description:
      "See the bot's cloud computer screen when visual state is needed. First prefer browser_state for Chrome title/URL checks. The frame is captured fresh; byte-identical pixels are not resent.",
    inputSchema: {
      type: "object",
      properties: {
        region: {
          type: "object",
          description: "Optional crop in the coordinates of the last screenshot.",
          properties: {
            x: { type: "number" },
            y: { type: "number" },
            width: { type: "number" },
            height: { type: "number" },
          },
          required: ["x", "y", "width", "height"],
        },
      },
    },
  },
  {
    name: "browser_state",
    description:
      "Read structured Chrome page titles and safe URLs. Credentials, query strings, and fragments are removed before output.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_snapshot",
    description:
      "Read Chrome's semantic accessibility tree and return fresh element refs. Prefer this over screenshots for links, buttons, and form fields.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "browser_click",
    description: "Click one element ref from the most recent browser_snapshot and return the resulting screen.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, ...OBSERVE_PROPS },
      required: ["ref"],
    },
  },
  {
    name: "browser_fill",
    description: "Replace the text in one field ref from the most recent browser_snapshot and return the resulting screen.",
    inputSchema: {
      type: "object",
      properties: { ref: { type: "string" }, text: { type: "string" }, ...OBSERVE_PROPS },
      required: ["ref", "text"],
    },
  },
  {
    name: "wait_for_navigation",
    description:
      "Verify that Chrome reached one exact http(s) URL, including its query and fragment, with at most three bounded checks.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" } },
      required: ["url"],
    },
  },
  {
    name: "observation_metrics",
    description: "Return this turn's observation, action, retry, and verification counters.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "computer_status",
    description: "Report whether the cloud computer is using Cua Driver or the degraded X11 fallback.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "computer_request_help",
    description:
      "Ask the person to take over this computer (a login, a CAPTCHA, anything you should not do alone) and wait until they hand control back. Also call it with no reason when an action was refused because a person is already driving. You cannot take control yourself — this only asks.",
    inputSchema: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "one short sentence the person will read — what you need their hands for",
        },
      },
    },
  },
  {
    name: "click",
    description:
      "Click on the computer's screen and return the resulting screen. Use pixel coordinates exactly as they appear in the last frame you were given — any scaling to the real display is handled for you.",
    inputSchema: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right"], description: "default left" },
        double: { type: "boolean", description: "double-click" },
      },
      required: ["x", "y"],
    },
  },
  {
    name: "type_text",
    description: "Type text at the current focus and return the resulting screen.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string" }, ...OBSERVE_PROPS },
      required: ["text"],
    },
  },
  {
    name: "press_key",
    description:
      'Press a key or chord and return the resulting screen. xdotool syntax: "Return", "Tab", "ctrl+c", "alt+F4", "ctrl+shift+t".',
    inputSchema: {
      type: "object",
      properties: { keys: { type: "string" }, ...OBSERVE_PROPS },
      required: ["keys"],
    },
  },
  {
    name: "scroll",
    description: "Scroll the screen up or down by N clicks and return the resulting screen.",
    inputSchema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down"] },
        clicks: { type: "number", description: "default 3" },
        ...OBSERVE_PROPS,
      },
      required: ["direction"],
    },
  },
  {
    name: "computer_batch",
    description:
      "Run several UI actions in ONE go and return the screen at the end — much faster than separate calls (one round trip, one screenshot). Use it for mechanical sequences you can predict without looking in between, e.g. click a field, type, Tab, type, press Return. Stop the batch before anything whose outcome you need to see first.",
    inputSchema: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          description: "in order; each is {action: click|type_text|press_key|scroll|wait, ...its params}",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["click", "type_text", "press_key", "scroll", "wait"] },
              x: { type: "number" },
              y: { type: "number" },
              button: { type: "string", enum: ["left", "right"] },
              double: { type: "boolean" },
              text: { type: "string" },
              keys: { type: "string" },
              direction: { type: "string", enum: ["up", "down"] },
              clicks: { type: "number" },
              ms: { type: "number", description: "wait: milliseconds, max 5000" },
            },
            required: ["action"],
          },
        },
        ...OBSERVE_PROPS,
      },
      required: ["actions"],
    },
  },
  {
    name: "computer_exec",
    description:
      "Run a shell command on the bot's cloud computer (Linux, passwordless sudo, X11 desktop). Returns stdout/stderr/exit code — and, unlike the UI tools, no screenshot unless you ask for one.",
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", maxLength: MAX_REMOTE_COMMAND_LENGTH },
        observe: {
          type: "boolean",
          description: "default false — set true to also return a screenshot (e.g. after launching a GUI app)",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "wait_for",
    description:
      "Wait on the bot's cloud computer until a condition holds, then return in ONE call instead of repeatedly polling with computer_exec or screenshots. Give only the fields needed by the chosen condition.",
    inputSchema: {
      type: "object",
      properties: {
        condition: {
          type: "string",
          enum: ["http_ready", "tcp_ready", "output_matches", "file_exists"],
          description:
            "http_ready = a URL returns a successful response; tcp_ready = a local port accepts; output_matches = a bounded, read-only command's output matches a pattern; file_exists = a path appears",
        },
        url: { type: "string", description: "http_ready only: the URL to poll, e.g. http://localhost:3000/health" },
        port: { type: "integer", description: "tcp_ready only: the local TCP port, e.g. 5432" },
        command: {
          type: "string",
          description: "output_matches only: a quick, read-only shell command whose combined output is checked each poll",
        },
        pattern: { type: "string", description: "output_matches only: extended regex the output must match, e.g. ready|listening" },
        path: { type: "string", description: "file_exists only: absolute path on the computer" },
        timeout_seconds: { type: "integer", description: "give up after this many seconds; default 60, max 240" },
        ...OBSERVE_PROPS,
      },
      required: ["condition"],
    },
  },
  {
    name: "open_url",
    description:
      "Open a URL in the computer's own Chrome, verify the exact destination when DevTools is available, and return the resulting screen.",
    inputSchema: {
      type: "object",
      properties: { url: { type: "string" }, ...OBSERVE_PROPS },
      required: ["url"],
    },
  },
];

const shellQuote = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const settleOf = (args: any) => Math.min(Math.max(Number(args?.settle_ms) || SETTLE_MS, 0), 3000);
const wantsFrame = (args: any) => args?.observe !== false;

/** One action → the shell that performs it (scaling clicks box-side). */
function actionShell(a: any): string | { error: string } {
  const kind = String(a?.action ?? "");
  if (kind === "click") {
    const x = Math.round(Number(a.x));
    const y = Math.round(Number(a.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return { error: "click needs numeric x,y" };
    const btn = a.button === "right" ? 3 : 1;
    const rep = a.double ? "--repeat 2 --delay 60 " : "";
    const button = a.button === "right" ? "right" : "left";
    const count = a.double ? 2 : 1;
    const fallback = `xdotool mousemove $CX $CY click ${rep}${btn}`;
    const args = `$(printf '{"x":%s,"y":%s,"button":"${button}","count":${count},"scope":"desktop","session":"${REMOTE_CUA_SESSION}"}' "$CX" "$CY")`;
    return `${scaled("CX", x)}; ${scaled("CY", y)}; CUA_ARGS=${args}; ${cuaOrX11("click", '"$CUA_ARGS"', fallback)}`;
  }
  if (kind === "type_text") {
    const t = String(a.text ?? "");
    if (!t) return { error: "type_text needs text" };
    const cuaArgs = shellQuote(JSON.stringify({ text: t, scope: "desktop", session: REMOTE_CUA_SESSION }));
    return cuaOrX11("type_text", cuaArgs, `xdotool type --clearmodifiers --delay 8 -- ${shellQuote(t)}`);
  }
  if (kind === "press_key") {
    const keys = String(a.keys ?? "").replace(/[^\w+]/g, "");
    if (!keys) return { error: "press_key needs keys" };
    const parts = keys.split("+").filter(Boolean);
    const tool = parts.length > 1 ? "hotkey" : "press_key";
    const cuaArgs = shellQuote(
      JSON.stringify(
        parts.length > 1
          ? { keys: parts, scope: "desktop", session: REMOTE_CUA_SESSION }
          : { key: parts[0]?.toLowerCase(), scope: "desktop", session: REMOTE_CUA_SESSION },
      ),
    );
    return cuaOrX11(tool, cuaArgs, `xdotool key ${keys}`);
  }
  if (kind === "scroll") {
    const clicks = Math.min(Math.max(Math.round(Number(a.clicks) || 3), 1), 20);
    const btn = a.direction === "up" ? 4 : 5;
    const direction = a.direction === "up" ? "up" : "down";
    const fallback = `xdotool click --repeat ${clicks} ${btn}`;
    const args = `$(printf '{"x":%s,"y":%s,"direction":"${direction}","amount":${clicks},"by":"line","scope":"desktop","session":"${REMOTE_CUA_SESSION}"}' "$((W / 2))" "$((H / 2))")`;
    return `CUA_ARGS=${args}; ${cuaOrX11("scroll", '"$CUA_ARGS"', fallback)}`;
  }
  if (kind === "wait") {
    const ms = Math.min(Math.max(Number(a.ms) || 500, 0), 5000);
    return `sleep ${(ms / 1000).toFixed(2)}`;
  }
  return { error: `unknown action ${kind || "(missing)"}` };
}

/** The whole point: one round trip carries geometry, the actions, the
 * settle, the capture and the frame bytes. */
async function actAndObserve(
  id: unknown,
  actions: any[],
  note: string,
  args: any,
  timeoutMs = 60_000,
): Promise<void> {
  const parts: string[] = [];
  for (const a of actions) {
    const shell = actionShell(a);
    if (typeof shell !== "string") return text(id, shell.error, true);
    // X11 needs a beat between steps — a click that focuses a field and
    // an immediate type will drop leading characters
    if (parts.length) parts.push(`sleep ${(ACTION_GAP_MS / 1000).toFixed(2)}`);
    parts.push(shell);
  }
  observations.noteAction(actions.filter((action) => action?.action !== "wait").length);
  const observe = wantsFrame(args);
  // The actions run in a guarded group so a failing xdotool is REPORTED
  // rather than silently swallowed by the capture that follows it — but
  // the capture still runs, so the model always gets to see the state it
  // ended up in. Joining with ";" alone made a failed action look
  // identical to one that did nothing.
  const guarded = `if { ${parts.join("; ")}; }; then ACT=ok; else ACT=failed; fi`;
  const command = [
    ENV,
    GEOMETRY,
    ensureRemoteCuaCommand(),
    guarded,
    observe ? captureBlock(settleOf(args)) : "true",
    'echo "ACT $ACT"',
  ].join("; ");
  const out = await runOnBox(command, timeoutMs);
  const acted = /^ACT ok$/m.test(out.stdout);
  if (!acted && !out.stdout.includes("GEOM")) {
    return text(
      id,
      `${note.replace(/^./, (c) => c.toLowerCase())} failed: ${out.stderr.slice(0, 200) || `exit ${out.exitCode}`}`,
      true,
    );
  }
  const backend = automationSummary(out.stdout);
  const full = acted
    ? `${note}\n(${backend})`
    : `${note}\n(the action reported an error: ${out.stderr.slice(0, 160) || "no detail"}; ${backend})`;
  if (!observe) return text(id, full, !acted);
  return observed(id, full, await frameFrom(out));
}

async function semanticActAndObserve(
  id: unknown,
  action: "click" | "fill",
  ref: string,
  value: string | undefined,
  args: any,
): Promise<void> {
  if (!semanticBrowserUrl || !semanticBrowserRefs.has(ref)) {
    return text(id, "that browser ref is stale or unknown — take a new browser_snapshot", true);
  }
  const observe = wantsFrame(args);
  const semantic = semanticBrowserCommand(action, {
    ref,
    ...(action === "fill" ? { text: value ?? "" } : {}),
    url: semanticBrowserUrl,
  });
  const guarded = `if ${semantic}; then SEM=ok; else SEM=failed; fi`;
  const command = [
    ENV,
    GEOMETRY,
    guarded,
    ensureRemoteCuaCommand(),
    observe ? captureBlock(settleOf(args)) : "true",
    'echo "SEM $SEM"',
  ].join("; ");
  observations.noteAction();
  const out = await runOnBox(command, action === "fill" ? 120_000 : 60_000);
  const acted = /^SEM ok$/m.test(out.stdout);
  // DOM mutations can invalidate backend node IDs; force a fresh snapshot
  // after every semantic action instead of risking a click on an old target.
  semanticBrowserRefs.clear();
  const note = acted
    ? action === "fill"
      ? `filled ${ref} with ${value?.length ?? 0} chars (trusted Chrome DevTools input)`
      : `clicked ${ref} (trusted Chrome DevTools input)`
    : `${action} ${ref} failed: ${out.stderr.slice(0, 200) || "the page changed; take a new browser_snapshot"}`;
  if (!observe) return text(id, note, !acted);
  return observed(id, note, await frameFrom(out));
}

/** The only tools a bot may use while the person is driving: asking to be
 * told when they finish, and the two that read nothing from the screen. */
const OPEN_WHILE_DRIVEN = new Set(["computer_request_help", "computer_status", "observation_metrics"]);

async function call(id: unknown, name: string, args: any) {
  if (!OPEN_WHILE_DRIVEN.has(name) && (await control.state(true)).held) {
    return text(id, CONTROL_REFUSAL, true);
  }
  if (name === "computer_request_help") {
    if (!control.configured) {
      return text(id, "nobody can be paged for this computer right now — carry on carefully", true);
    }
    const initial = await control.state(true);
    // If the person is already driving, don't clobber whatever plea they
    // are reading — just wait for the hand-back.
    const requestId = initial.held ? null : await control.requestHelp(String(args?.reason ?? ""));
    if (!initial.held && requestId === null) {
      return text(id, "The person could not be paged for this computer right now. Carry on carefully or tell them in chat.", true);
    }
    let sawHold = initial.held;
    const deadline = Date.now() + CONTROL_WAIT_MS;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, CONTROL_POLL_MS));
      const state = await control.state(true);
      if (state.held) sawHold = true;
      if (!state.held && !state.helpOpen) {
        return text(
          id,
          sawHold
            ? "The person has finished driving and handed control back. The screen may have changed while they drove — take a fresh screenshot before your next action."
            : "The person saw your request and dismissed it without taking control. Carry on yourself.",
        );
      }
    }
    if (requestId) await control.expireHelp(requestId);
    return text(
      id,
      "Nobody took control within the wait window. Carry on carefully, or ask again if you are truly stuck.",
      true,
    );
  }
  if (name === "screenshot") {
    let crop: CropRegion | null = null;
    if (args.region !== undefined) {
      const bounds = await observationBounds();
      if (!bounds) return text(id, "crop unavailable: could not determine the screenshot dimensions", true);
      crop = normalizeCrop(args.region, bounds.width, bounds.height);
      if (!crop) {
        return text(
          id,
          `region must be at least 32×32 and stay within the ${bounds.width}×${bounds.height} screenshot`,
          true,
        );
      }
    }
    const out = await runOnBox([ENV, GEOMETRY, ensureRemoteCuaCommand(), captureBlock(0, crop)].join("; "), 60_000);
    if (/CROP_FAILED/.test(out.stdout)) {
      return text(id, `crop failed: ${out.stderr.slice(0, 200) || "ImageMagick could not create the requested region"}`, true);
    }
    const frame = await frameFrom(out);
    if (!frame) {
      return text(id, `screenshot failed: ${out.stderr.slice(0, 200) || "capture produced no frame"}`, true);
    }
    return observed(id, crop ? "cropped screen captured" : "screen captured", frame, crop, false);
  }
  if (name === "browser_state") {
    const targets = await browserTargets();
    return text(
      id,
      targets.length
        ? `Structured browser state:\n${targets.map((target) => `- ${target.title || "Untitled"}: ${target.url}`).join("\n")}`
        : "Structured browser state unavailable. Use screenshot only if visual state is necessary.",
    );
  }
  if (name === "browser_snapshot") {
    const out = await runOnBox(semanticBrowserCommand("snapshot", {}), 20_000);
    if (!out.ok) {
      semanticBrowserUrl = null;
      semanticBrowserRefs.clear();
      return text(id, "Semantic browser state is unavailable. Open Chrome with open_url, or use screenshot.", true);
    }
    try {
      const snapshot = JSON.parse(out.stdout) as SemanticBrowserSnapshot;
      if (!Array.isArray(snapshot.elements) || typeof snapshot.url !== "string") throw new Error("invalid snapshot");
      semanticBrowserUrl = snapshot.url;
      semanticBrowserRefs = new Set(snapshot.elements.map((element) => element.ref));
      observations.noteStructuredObservation();
      const publicUrl = safeBrowserUrl(snapshot.url) ?? "URL unavailable";
      const lines = snapshot.elements.map(
        (element) =>
          `- [${element.ref}] ${element.role}${element.disabled ? " disabled" : ""}: ${element.name.replace(/\s+/g, " ").slice(0, 180)}`,
      );
      return text(
        id,
        `Semantic browser snapshot — ${snapshot.title || "Untitled"}: ${publicUrl}\n${lines.join("\n") || "No interactive elements found."}`,
      );
    } catch {
      semanticBrowserUrl = null;
      semanticBrowserRefs.clear();
      return text(id, "Chrome returned an invalid semantic snapshot; use screenshot.", true);
    }
  }
  if (name === "browser_click") {
    const ref = String(args.ref ?? "");
    return semanticActAndObserve(id, "click", ref, undefined, args);
  }
  if (name === "browser_fill") {
    const ref = String(args.ref ?? "");
    return semanticActAndObserve(id, "fill", ref, String(args.text ?? ""), args);
  }
  if (name === "wait_for_navigation") {
    const url = String(args.url ?? "");
    const publicUrl = safeBrowserUrl(url);
    if (!normalizeBrowserUrl(url) || !publicUrl) {
      observations.noteVerification(false);
      return text(id, "wait_for_navigation needs a valid http(s) URL", true);
    }
    const result = await waitForNavigation(url);
    return text(
      id,
      result.ok
        ? `navigation verified: ${publicUrl}`
        : `navigation not verified after 3 checks. Current structured state: ${result.targets.map((target) => target.url).join(", ") || "unavailable"}. Use screenshot only if needed.`,
      !result.ok,
    );
  }
  if (name === "observation_metrics") return text(id, metricsText());
  if (name === "computer_status") {
    const command = [
      ENV,
      ensureRemoteCuaCommand(),
      `if [ -x ${REMOTE_CUA_EXECUTABLE} ] && ${REMOTE_CUA_EXECUTABLE} status --socket ${REMOTE_CUA_SOCKET} >/dev/null 2>&1; then`,
      `  echo "CUA $(${REMOTE_CUA_EXECUTABLE} --version)"`,
      `  env ${CUA_ENV} ${REMOTE_CUA_EXECUTABLE} call health_report '{}' --socket ${REMOTE_CUA_SOCKET} 2>/dev/null || true`,
      "else echo 'X11 fallback'; fi",
    ].join("\n");
    const out = await runOnBox(command, 20_000);
    if (!/^CUA /m.test(out.stdout)) {
      return text(id, "Cloud computer automation: X11 fallback (Cua Driver is still installing or needs repair).", true);
    }
    const overall = out.stdout.match(/"overall"\s*:\s*"(ok|degraded|failed)"/)?.[1] ?? "unknown";
    return text(id, `Cloud computer automation: Cua Driver ${REMOTE_CUA_VERSION} (${overall}).`);
  }
  if (name === "click") {
    const x = Math.round(Number(args.x));
    const y = Math.round(Number(args.y));
    if (!Number.isFinite(x) || !Number.isFinite(y)) return text(id, "click needs numeric x,y", true);
    const what = `${args.double ? "double-clicked" : args.button === "right" ? "right-clicked" : "clicked"} ${x},${y}`;
    return actAndObserve(id, [{ ...args, action: "click" }], what, args);
  }
  if (name === "type_text") {
    const t = String(args.text ?? "");
    if (!t) return text(id, "nothing to type", true);
    return actAndObserve(id, [{ action: "type_text", text: t }], `typed ${t.length} chars`, args, 120_000);
  }
  if (name === "press_key") {
    const keys = String(args.keys ?? "").replace(/[^\w+]/g, "");
    if (!keys) return text(id, "press_key needs keys", true);
    return actAndObserve(id, [{ action: "press_key", keys }], `pressed ${keys}`, args);
  }
  if (name === "scroll") {
    const clicks = Math.min(Math.max(Math.round(Number(args.clicks) || 3), 1), 20);
    const direction = args.direction === "up" ? "up" : "down";
    return actAndObserve(id, [{ action: "scroll", direction, clicks }], `scrolled ${direction} ${clicks}`, args);
  }
  if (name === "computer_batch") {
    const actions = Array.isArray(args.actions) ? args.actions.slice(0, 24) : [];
    if (!actions.length) return text(id, "computer_batch needs a non-empty actions array", true);
    const summary = actions
      .map((a: any) =>
        a.action === "click"
          ? `click ${Math.round(Number(a.x))},${Math.round(Number(a.y))}`
          : a.action === "type_text"
            ? `type ${String(a.text ?? "").length} chars`
            : a.action === "press_key"
              ? `key ${a.keys}`
              : a.action === "scroll"
                ? `scroll ${a.direction ?? "down"}`
                : `wait ${Math.min(Number(a.ms) || 500, 5000)}ms`,
      )
      .join(" → ");
    return actAndObserve(id, actions, `ran ${actions.length} actions: ${summary}`, args, 180_000);
  }
  if (name === "computer_exec") {
    const command = String(args.command ?? "");
    if (command.length > MAX_REMOTE_COMMAND_LENGTH) {
      return text(id, `command is too long (maximum ${MAX_REMOTE_COMMAND_LENGTH} characters)`, true);
    }
    observations.noteAction();
    const out = await runOnBox(command, 120_000);
    const note = `exit ${out.exitCode}\n${out.stdout.slice(-6000)}${out.stderr ? `\n[stderr]\n${out.stderr.slice(-2000)}` : ""}`;
    if (args.observe !== true) return text(id, note);
    const shot = await runOnBox([ENV, GEOMETRY, ensureRemoteCuaCommand(), captureBlock()].join("; "), 60_000);
    return observed(id, note, await frameFrom(shot));
  }
  if (name === "wait_for") {
    const condition = String(args.condition ?? "").trim().toLowerCase();
    const timeout = Math.min(Math.max(Math.trunc(Number(args.timeout_seconds) || 60), 1), 240);
    let check = "";
    let label = "";
    if (condition === "http_ready") {
      const url = String(args.url ?? "").trim();
      if (!/^https?:\/\//i.test(url)) {
        return text(id, 'http_ready needs "url", e.g. {"condition":"http_ready","url":"http://localhost:3000/health"}.', true);
      }
      check = `curl -fsS -o /dev/null --connect-timeout 1 --max-time 1 ${shellQuote(url)}`;
      label = url;
    } else if (condition === "tcp_ready") {
      const portNumber = Math.trunc(Number(args.port));
      if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) {
        return text(id, 'tcp_ready needs "port" 1-65535, e.g. {"condition":"tcp_ready","port":5432}.', true);
      }
      check = `timeout --kill-after=1s 1s bash -c ${shellQuote(`echo > /dev/tcp/127.0.0.1/${portNumber}`)} 2>/dev/null`;
      label = `port ${portNumber}`;
    } else if (condition === "output_matches") {
      const probe = String(args.command ?? "").slice(0, 2000);
      const pattern = String(args.pattern ?? "").slice(0, 500);
      if (!probe.trim() || !pattern.trim()) {
        return text(id, 'output_matches needs "command" and "pattern", e.g. {"condition":"output_matches","command":"tail -1 /tmp/build.log","pattern":"done|failed"}.', true);
      }
      // A probe is rerun until it matches, so bound every individual run.
      // This prevents a hung command from outliving the advertised wait.
      check = `timeout --kill-after=1s 1s bash -c ${shellQuote(probe)} 2>&1 | grep -Eq -- ${shellQuote(pattern)}`;
      label = `/${pattern}/ in ${probe.slice(0, 80)}`;
    } else if (condition === "file_exists") {
      const target = String(args.path ?? "").trim();
      if (!target.startsWith("/")) {
        return text(id, 'file_exists needs an absolute "path", e.g. {"condition":"file_exists","path":"/tmp/render.done"}.', true);
      }
      check = `[ -e ${shellQuote(target)} ]`;
      label = target;
    } else {
      return text(id, 'wait_for needs "condition": http_ready, tcp_ready, output_matches, or file_exists.', true);
    }

    const loop = [
      "MET=no",
      "START=$SECONDS",
      `END=$((SECONDS+${timeout}))`,
      `while [ "$SECONDS" -lt "$END" ]; do if ${check}; then MET=yes; break; fi; REMAIN=$((END-SECONDS)); [ "$REMAIN" -le 0 ] && break; [ "$REMAIN" -lt 2 ] && sleep "$REMAIN" || sleep 2; done`,
      'echo "WAIT_RESULT $MET ELAPSED $((SECONDS-START))"',
    ].join("; ");
    observations.noteAction();
    // Keep this condition-only. A person can take control during a long wait;
    // appending a screenshot to the same remote shell would bypass the fresh
    // control check and could capture credentials they typed. A follow-up
    // screenshot is a separate tool call and therefore re-checks the lease.
    const out = await runOnBox(loop, (timeout + 15) * 1000);
    const marker = out.stdout.match(/^WAIT_RESULT (yes|no) ELAPSED (\d+)$/m);
    if (!out.ok || !marker) {
      const detail = out.stderr.slice(0, 300) || `exit ${out.exitCode ?? "unknown"}`;
      return text(id, `wait_for could not check ${label}: ${detail}`, true);
    }
    const met = marker[1] === "yes";
    const elapsed = marker[2];
    const note = met
      ? `condition met: ${label} (~${elapsed}s)`
      : `timed out after ${timeout}s waiting for ${label} — inspect with computer_exec (logs, process list) before waiting again.`;
    return text(id, note, !met);
  }
  if (name === "open_url") {
    const url = String(args.url ?? "");
    const normalized = normalizeBrowserUrl(url);
    const publicUrl = safeBrowserUrl(url);
    if (!normalized || !publicUrl) return text(id, "only valid http(s) URLs", true);
    const q = shellQuote(normalized);
    const observe = wantsFrame(args);
    // launch, then poll for a browser window instead of a blind sleep —
    // a fast page returns in a fraction of the old fixed 3s
    const command = [
      ENV,
      GEOMETRY,
      CHROME_PROFILE_SETUP,
      `(google-chrome ${CHROME_DEBUG_FLAGS} ${q} || chromium ${CHROME_DEBUG_FLAGS} ${q} || chromium-browser ${CHROME_DEBUG_FLAGS} ${q} || xdg-open ${q}) >/dev/null 2>&1 &`,
      'for i in 1 2 3 4 5 6 7 8 9 10 11 12; do xdotool search --onlyvisible --class "chrom" >/dev/null 2>&1 && break; sleep 0.25; done',
      ensureRemoteCuaCommand(),
      observe ? captureBlock(600) : "true",
    ].join("; ");
    observations.noteAction();
    const out = await runOnBox(command, 60_000);
    const verification = await waitForNavigation(normalized, 1);
    const current = verification.targets.map((target) => target.url).join(", ") || "unavailable";
    const note = verification.ok
      ? `opened and navigation verified: ${publicUrl}`
      : `opened ${publicUrl}, but the exact destination was not verified. Current structured state: ${current}`;
    if (!observe) return text(id, note);
    return observed(id, note, await frameFrom(out));
  }
  return text(id, `unknown tool ${name}`, true);
}

async function handle(msg: any) {
  if (msg.method === "initialize") {
    return send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: msg.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "openmausbot-computer", version: "3" },
      },
    });
  }
  if (msg.method === "tools/list") return send({ jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } });
  if (msg.method === "tools/call") {
    try {
      return await call(msg.id, msg.params?.name, msg.params?.arguments ?? {});
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      const timedOut = error.name === "TimeoutError" || /timed?\s*out|timeout/i.test(error.message);
      return text(
        msg.id,
        timedOut
          ? "computer tool timed out. The action may or may not have completed; take a screenshot to inspect the current state before retrying it."
          : `computer tool failed: ${error.message}`,
        true,
      );
    }
  }
  if (String(msg.method ?? "").startsWith("notifications/")) return;
  if (msg.id != null) {
    send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}

let buf = "";
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      /* ignore malformed lines */
    }
  }
});
process.stdin.on("end", () => process.exit(0));
