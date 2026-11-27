// Whether this machine can run the bot box, decided once at boot: on by default on a Cloud home, tried by default in the
// self-hosted server image (OMB_SERVER_IMAGE=1), off everywhere else unless OMB_BOT_BOX=1, and never on without a working
// unprivileged bubblewrap (a kernel that refuses user namespaces, or an image without bwrap, reports `off` with its
// reason rather than running turns unboxed by surprise: the report says so, and the Admin shows it).
// OMB_BOT_BOX=required (the installer's compose.box.yaml) is on with no way down: when the box cannot start, bot spawns
// are refused (box.ts BotBox.wrap) instead of running unboxed.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export type BoxKind = "bwrap" | "gvisor" | "user" | "off";

export interface BoxDetection {
  box: BoxKind;
  /** Why the box is off, as a fixed code; never free text from a tool. */
  reason: "switched-off" | "not-linux" | "no-bwrap" | "userns-refused" | "not-cloud" | "start-failed" | null;
  /** The found tools, when the box is on. */
  tools: { bwrap: string; socat: string | null } | null;
}

export interface DetectInput {
  env: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  /** Runs bwrap once with a harmless command; true when the box works. */
  probe?: (bwrap: string) => boolean;
  which?: (name: string) => string | null;
}

/** A Cloud home (`home`, or the Team Cloud role `team`) boxes turns unless told not to. */
export function cloudRole(env: Record<string, string | undefined>): boolean {
  return env.OMB_CLOUD_ROLE === "home" || env.OMB_CLOUD_ROLE === "team";
}

/** The image's own marker, set by the Dockerfile's `server` target. Not OMB_IMAGE: an install's .env names the image in
 * OMB_IMAGE, and a Compose file that loads .env into the container (`env_file: .env`) would replace the marker. */
export const SERVER_IMAGE_ENV = "OMB_SERVER_IMAGE";

/** The self-hosted server image: a server, never someone's own computer, so it tries the box by default. Builds of this
 * branch before the rename said OMB_IMAGE=server, which still counts when it is exactly that. */
export function serverImage(env: Record<string, string | undefined>): boolean {
  return env[SERVER_IMAGE_ENV] === "1" || env.OMB_IMAGE === "server";
}

/** `OMB_BOT_BOX`: unset (Cloud homes on, the server image tries, others off), 0/off, 1/on/bwrap, required. */
export function boxWanted(env: Record<string, string | undefined>): "on" | "off" | "default" | "required" {
  const raw = (env.OMB_BOT_BOX ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return "off";
  if (raw === "required") return "required";
  if (raw === "1" || raw === "on" || raw === "bwrap" || raw === "true" || raw === "yes") return "on";
  return "default";
}

export function whichOnPath(name: string, env: Record<string, string | undefined> = process.env): string | null {
  for (const dir of (env.PATH ?? "/usr/local/bin:/usr/bin:/bin").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** bubblewrap with the namespaces the box uses, running /bin/true: the one thing Fly's kernel must allow. */
export function probeBwrap(bwrap: string): boolean {
  try {
    const result = spawnSync(bwrap, [
      "--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--die-with-parent",
      "--ro-bind", "/usr", "/usr", "--symlink", "usr/bin", "/bin", "--symlink", "usr/lib", "/lib", "--symlink", "usr/lib64", "/lib64",
      "--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "/bin/true",
    ], { timeout: 5_000, stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function detectBox(input: DetectInput): BoxDetection {
  const wanted = boxWanted(input.env);
  if (wanted === "off") return { box: "off", reason: "switched-off", tools: null };
  if (wanted === "default" && !cloudRole(input.env) && !serverImage(input.env)) return { box: "off", reason: "not-cloud", tools: null };
  if ((input.platform ?? process.platform) !== "linux") return { box: "off", reason: "not-linux", tools: null };
  const which = input.which ?? ((name) => whichOnPath(name, input.env));
  const bwrap = which("bwrap");
  if (!bwrap) return { box: "off", reason: "no-bwrap", tools: null };
  if (!(input.probe ?? probeBwrap)(bwrap)) return { box: "off", reason: "userns-refused", tools: null };
  return { box: "bwrap", reason: null, tools: { bwrap, socat: which("socat") } };
}
