// Saved startup choices: applying them to a launch and deriving them from one.
import { normalizePhoneOrigin } from "../cli-phone-setup.ts";
import type { AppConfig } from "../config.ts";
import type { CliOptions } from "./options.ts";

export function applyStartupPreferences(options: CliOptions, saved: AppConfig["cliStartup"]): CliOptions {
  if (options.local) return { ...options, tunnel: false, tailscale: false, publicUrl: undefined, phone: undefined };
  if (!saved || options.tunnel || options.tailscale || options.publicUrl) return options;
  if (saved.access === "public-url" && (!saved.publicUrl || !normalizePhoneOrigin(saved.publicUrl))) {
    throw new Error("The saved phone address is not a valid HTTPS origin. Run openmausbot setup to correct it, or openmausbot --local to start only on this computer.");
  }
  return {
    ...options,
    tunnel: saved.access === "tunnel", tailscale: saved.access === "tailscale",
    publicUrl: saved.access === "public-url" ? saved.publicUrl : undefined,
    phone: saved.access === "local" ? undefined : saved.phone,
  };
}

export function startupPreferences(options: CliOptions): NonNullable<AppConfig["cliStartup"]> {
  const access = options.local ? "local" : options.tunnel ? "tunnel" : options.tailscale ? "tailscale" : options.publicUrl ? "public-url" : "local";
  const publicUrl = access === "public-url" ? normalizePhoneOrigin(options.publicUrl!) : null;
  if (access === "public-url" && !publicUrl) throw new Error("Use an HTTPS origin without a password, path or query for saved phone access. The address was not saved.");
  return {
    access,
    ...(publicUrl ? { publicUrl } : {}),
    ...(!options.local && options.phone ? { phone: options.phone } : {}),
  };
}
