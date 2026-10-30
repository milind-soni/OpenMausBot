// A second CDP connection to the browser agent-browser started: every page, cross-site frame and worker gets the browser's
// own identity before it runs (auto-attach paused on start), so no page or worker ever reads "HeadlessChrome". It sends
// nothing but the override and the release; never Runtime.enable, the call sites detect (deviceandbrowserinfo, Chrome 153).
import { execFile } from "node:child_process";

import { inRunningBrowser } from "../../browser-engine.ts";
import { browserRuntimeEnv } from "../../browser-runtime.ts";
import { connectCdp, type Cdp, type CdpEvent } from "../../browser-sites.ts";
import { NO_PASSKEY_COMMANDS } from "../cdp/passkeys.ts";
import type { ChromeIdentity } from "./identity.ts";

/** The pages and workers the browser session attaches to itself; frames and dedicated workers come through their page. */
const BROWSER_TARGETS = [{ type: "page" }, { type: "service_worker" }, { type: "shared_worker" }, { exclude: true }];
const PAUSED_ON_START = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

export interface IdentitySidecar {
  /** Resolves when the browser closes the connection: it exited, or was replaced. */
  closed: Promise<void>;
  close(): void;
}

export interface SidecarOptions {
  /** A headless browser's tabs: passkey requests end at once as unavailable (../cdp/passkeys.ts). */
  noPasskeys?: boolean;
}

/** The browser's identity, and the languages its pages are told (a list, see languageList in ./wrapper.ts). */
export type SidecarIdentity = ChromeIdentity & { acceptLanguage?: string };

export async function startIdentitySidecar(url: string, identity: SidecarIdentity, connect: typeof connectCdp = connectCdp, options: SidecarOptions = {}): Promise<IdentitySidecar> {
  let onClosed!: () => void;
  const closed = new Promise<void>((resolve) => { onClosed = resolve; });
  let cdp: Cdp | null = null;
  const configure = (message: CdpEvent) => {
    if (message.method !== "Target.attachedToTarget" || !cdp) return;
    const { sessionId, targetInfo } = (message.params ?? {}) as { sessionId?: string; targetInfo?: { type?: string } };
    if (typeof sessionId === "string") void applyIdentity(cdp, sessionId, targetInfo?.type ?? "", identity, options);
  };
  cdp = await connect(url, 15_000, { event: configure, closed: () => onClosed() });
  try {
    await cdp.send("Target.setAutoAttach", { ...PAUSED_ON_START, filter: BROWSER_TARGETS });
  } catch (error) {
    cdp.close();
    throw error;
  }
  return { closed, close: () => cdp?.close() };
}

/** A paused worker answers its overrides only once it runs, so a worker is sent them and released at once. */
async function applyIdentity(cdp: Cdp, sessionId: string, type: string, identity: SidecarIdentity, options: SidecarOptions): Promise<void> {
  try {
    if (type === "page" && options.noPasskeys) for (const [method, params] of NO_PASSKEY_COMMANDS) await cdp.send(method, params, sessionId).catch(() => undefined);
    if (type === "page" || type === "iframe") {
      await cdp.send("Emulation.setUserAgentOverride", { ...identity }, sessionId);
      await cdp.send("Target.setAutoAttach", PAUSED_ON_START, sessionId);
    } else if (type.endsWith("worker")) {
      if (type !== "worker") void cdp.send("Emulation.setUserAgentOverride", { ...identity }, sessionId).catch(() => undefined);
      void cdp.send("Network.setUserAgentOverride", { ...identity }, sessionId).catch(() => undefined);
    }
  } catch {}
  await cdp.send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(() => undefined);
}

type LaunchSpec = { command: string; env?: Record<string, string | undefined> };

/** One sidecar per browser session, attached again whenever the session's browser was started anew. */
export class IdentitySidecars {
  private live = new Map<string, IdentitySidecar>();
  private attaching = new Map<string, Promise<void>>();
  private cdpUrl: (session: string, spec: LaunchSpec) => Promise<string | null>;
  private start: typeof startIdentitySidecar;

  constructor(options: { cdpUrl?: (session: string, spec: LaunchSpec) => Promise<string | null>; start?: typeof startIdentitySidecar } = {}) {
    this.cdpUrl = options.cdpUrl ?? runningBrowserCdpUrl;
    this.start = options.start ?? startIdentitySidecar;
  }

  attached(session: string): boolean { return this.live.has(session); }

  ensure(session: string, spec: LaunchSpec, identity: SidecarIdentity): Promise<void> {
    if (this.live.has(session)) return Promise.resolve();
    let attaching = this.attaching.get(session);
    if (!attaching) {
      attaching = this.attach(session, spec, identity).finally(() => this.attaching.delete(session));
      this.attaching.set(session, attaching);
    }
    return attaching;
  }

  forget(session: string): void {
    this.live.get(session)?.close();
    this.live.delete(session);
  }

  private async attach(session: string, spec: LaunchSpec, identity: SidecarIdentity): Promise<void> {
    const url = await this.cdpUrl(session, spec);
    if (!url) return;
    const sidecar = await this.start(url, identity, undefined, { noPasskeys: spec.env?.AGENT_BROWSER_HEADLESS === "1" });
    this.live.get(session)?.close();
    this.live.set(session, sidecar);
    void sidecar.closed.then(() => { if (this.live.get(session) === sidecar) this.live.delete(session); });
  }
}

/** The engine's own Chrome on this machine only, read with the session's launch settings so the engine does not relaunch the
 * browser for it. A session closed since (a bot can close its browser) is started first, with `open` and no URL, which never
 * navigates, so the identity is in place before the bot's next command. */
async function runningBrowserCdpUrl(session: string, spec: LaunchSpec): Promise<string | null> {
  const env = browserRuntimeEnv({ ...spec.env, AGENT_BROWSER_SESSION: session });
  let answer = await inRunningBrowser(spec.command, env, ["get", "cdp-url"]);
  if (!answer) {
    await new Promise<void>((resolve, reject) => {
      execFile(spec.command, ["open", "--json", "--no-webmcp"], { env, timeout: 60_000, windowsHide: true }, (error) => error ? reject(error) : resolve());
    });
    answer = await inRunningBrowser(spec.command, env, ["get", "cdp-url"]);
  }
  const url = answer?.cdpUrl;
  return typeof url === "string" && /^wss?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+\//u.test(url) ? url : null;
}
