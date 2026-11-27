// Whether this machine can run the bot box, decided once at boot: on by default on a Cloud home, off everywhere else
// unless OMB_BOT_BOX=1, and never on without a working unprivileged bubblewrap (a kernel that refuses user namespaces,
// or an image without bwrap, reports `off` with its reason rather than running turns unboxed by surprise: the report
// says so, and the Admin shows it).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export type BoxKind = "bwrap" | "gvisor" | "user" | "off";

export interface BoxDetection {
  box: BoxKind;
  /** Why the box is off, as a fixed code; never free text from a tool. */
  reason: "switched-off" | "not-linux" | "no-bwrap" | "userns-refused" | "not-cloud" | null;
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

/** `OMB_BOT_BOX`: unset (Cloud homes on, others off), 0/off, 1/on/bwrap. */
export function boxWanted(env: Record<string, string | undefined>): "on" | "off" | "default" {
  const raw = (env.OMB_BOT_BOX ?? "").trim().toLowerCase();
  if (raw === "0" || raw === "off" || raw === "false" || raw === "no") return "off";
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
  if (wanted === "default" && !cloudRole(input.env)) return { box: "off", reason: "not-cloud", tools: null };
  if ((input.platform ?? process.platform) !== "linux") return { box: "off", reason: "not-linux", tools: null };
  const which = input.which ?? ((name) => whichOnPath(name, input.env));
  const bwrap = which("bwrap");
  if (!bwrap) return { box: "off", reason: "no-bwrap", tools: null };
  if (!(input.probe ?? probeBwrap)(bwrap)) return { box: "off", reason: "userns-refused", tools: null };
  return { box: "bwrap", reason: null, tools: { bwrap, socat: which("socat") } };
}
