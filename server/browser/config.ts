// `browserEngine` in config.json.
import { z } from "zod";

import { browserEgressConfigSchema, type BrowserEgressConfig } from "./egress/policy.ts";

const CDP_PORT = /^[0-9]{1,5}$/;
const CDP_URL = /^(https?|wss?):\/\/\S+$/i;

/** agent-browser's `--cdp` takes a bare port or an http(s)/ws(s) DevTools URL. */
export function isValidCdpTarget(value: unknown): value is string {
  if (typeof value !== "string" || value === "") return false;
  if (CDP_PORT.test(value)) {
    const port = Number(value);
    return port >= 1 && port <= 65535;
  }
  return CDP_URL.test(value);
}

export type BrowserEngineKind = "agent-browser" | "chrome";

/** `attachCdpUrl`: a running Chrome that My Chrome profiles attach to. Config only, never env: the ambient environment must not redirect a bot's browser. */
export const browserEngineConfigSchema = z.object({
  attachCdpUrl: z.string().trim().max(2048).refine((value) => value === "" || isValidCdpTarget(value),
    { message: "browserEngine.attachCdpUrl must be a CDP port (1-65535) or an http(s)/ws(s) URL" }).optional(),
  idleTimeoutMinutes: z.number().int().min(1).max(60).optional(), // an unused browser closes after this; 10 when unset, 3 on MausBot Cloud
  egress: browserEgressConfigSchema.optional(),
  /** "chrome" runs the bots' browsers on OpenMausBot's own Chrome driver, an early test; agent-browser is the default. */
  engine: z.enum(["agent-browser", "chrome"]).optional(),
  /** "pane" shows the Chrome engine's browser on the desktop app as a real page the person uses directly, an early test; streamed when unset. */
  surface: z.enum(["stream", "pane"]).optional(),
  /** On a Linux server with Xvnc, the new engine's Chrome runs with its window on a private display that the browser panel
   * shows and a person drives as a remote desktop. Off by default. */
  cloudDisplay: z.boolean().optional(),
  /** The user agent the desktop pane presents: Electron's own ("native", the default) or without its Electron token ("cleaned"). */
  paneIdentity: z.enum(["native", "cleaned"]).optional(),
});

export interface BrowserEngineConfig {
  attachCdpUrl?: string;
  idleTimeoutMinutes?: number;
  egress?: BrowserEgressConfig;
  engine?: BrowserEngineKind;
  surface?: "stream" | "pane";
  cloudDisplay?: boolean;
  paneIdentity?: "native" | "cleaned";
}

export function browserEngineKind(cfg: { browserEngine?: BrowserEngineConfig }): BrowserEngineKind {
  return cfg.browserEngine?.engine === "chrome" ? "chrome" : "agent-browser";
}

/** The desktop pane needs the Chrome engine too: it is that engine's browser, shown natively. */
export function browserPaneWanted(cfg: { browserEngine?: BrowserEngineConfig }): boolean {
  return browserEngineKind(cfg) === "chrome" && cfg.browserEngine?.surface === "pane";
}

/** The bots' browsers should run on a display a person sees: asked for in config, on the new engine, on a server. */
export function cloudDisplayWanted(cfg: { browserEngine?: BrowserEngineConfig }, host: "desktop" | "server" | "container", platform: NodeJS.Platform = process.platform): boolean {
  return cfg.browserEngine?.cloudDisplay === true && browserEngineKind(cfg) === "chrome" && host !== "desktop" && platform === "linux";
}
