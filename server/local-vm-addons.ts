import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

export interface PersistentLocalVmAddon {
  name: string;
  mounts: ReadonlyArray<{ source: string; guestPath: string }>;
}

const addonNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, "must be a lowercase add-on name");
const addonSourceSchema = z.string().refine(
  (value) => !value.includes("\\") && !value.includes(",") && !value.includes("\r") && !value.includes("\n") && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  { message: "must be a non-empty slash-delimited relative path without dot segments, commas, or line breaks" },
);
const addonGuestPathSchema = z.string().refine(
  (value) => value.startsWith("/") && !value.includes(",") && !value.includes("\r") && !value.includes("\n") && value.split("/").slice(1).every((part) => part !== "" && part !== "." && part !== ".."),
  { message: "must be an absolute guest path without dot segments, commas, or line breaks" },
);

export const persistentLocalVmAddonSchema = z.object({
  name: addonNameSchema,
  mounts: z.array(z.object({ source: addonSourceSchema, guestPath: addonGuestPathSchema }).strict()).min(1).max(8),
}).strict();

export function persistentAddonMounts(
  addons: ReadonlyArray<PersistentLocalVmAddon>,
  addonsDir: string,
) {
  return addons.flatMap((addon) => addon.mounts.map((mount) => ({
    source: join(addonsDir, addon.name, mount.source),
    guestPath: mount.guestPath,
  })));
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Reject host aliases before the container runtime receives a bind source from persistent add-on configuration. */
export function assertPersistentAddonSources(
  addons: ReadonlyArray<PersistentLocalVmAddon>,
  addonsDir: string,
): void {
  if (addons.length === 0) return;
  const realAddonsDir = realpathSync(addonsDir);
  for (const addon of addons) {
    const addonDir = join(addonsDir, addon.name);
    const realAddonDir = realpathSync(addonDir);
    if (!isWithin(realAddonsDir, realAddonDir)) throw new Error(`Persistent add-on ${addon.name} is outside the add-on directory`);
    for (const mount of addon.mounts) {
      const source = resolve(addonDir, mount.source);
      if (!isWithin(addonDir, source)) throw new Error(`Persistent add-on ${addon.name} source escapes its directory`);
      const entry = lstatSync(source);
      if (entry.isSymbolicLink()) throw new Error(`Persistent add-on ${addon.name} source cannot be a symbolic link`);
      const realSource = realpathSync(source);
      if (!isWithin(realAddonDir, realSource)) throw new Error(`Persistent add-on ${addon.name} source is outside its directory`);
      if (entry.isFile() && entry.nlink > 1) throw new Error(`Persistent add-on ${addon.name} source cannot be a hard-linked file`);
    }
  }
}

function sameWorkspaceSource(source: string | undefined, platform: NodeJS.Platform, expected: string): boolean {
  if (!source) return false;
  const actual = resolve(source);
  const resolvedExpected = resolve(expected);
  return platform === "win32" ? actual.toLowerCase() === resolvedExpected.toLowerCase() : actual === resolvedExpected;
}

function samePodmanWindowsSource(source: string | undefined, expected: string): boolean {
  if (!source) return false;
  const match = expected.match(/^([A-Za-z]):[\\/](.+)$/);
  if (!match) return false;
  const translated = `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
  return source.replaceAll("\\", "/").toLowerCase() === translated.toLowerCase();
}

function sameMountSource(source: string | undefined, expected: string, platform: NodeJS.Platform, runtime: string): boolean {
  return sameWorkspaceSource(source, platform, expected) ||
    (runtime === "podman" && platform === "win32" && samePodmanWindowsSource(source, expected));
}

export function dockerWorkspaceMountIsSafe(
  mounts: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }> | undefined,
  platform: NodeJS.Platform,
  workspaceDir: string,
  workspaceGuest: string,
  addonsDir: string,
  runtime: string,
  addons: ReadonlyArray<PersistentLocalVmAddon> = [],
): boolean {
  const workspace = mounts?.find((mount) => mount.Type === "bind" && mount.Destination === workspaceGuest && mount.RW !== false);
  const expectedAddons = persistentAddonMounts(addons, addonsDir);
  return Boolean(
    workspace && sameMountSource(workspace.Source, workspaceDir, platform, runtime) && mounts?.length === expectedAddons.length + 1 &&
      expectedAddons.every((addon) => mounts.some((mount) => mount.Type === "bind" && mount.RW === false && mount.Destination === addon.guestPath && sameMountSource(mount.Source, addon.source, platform, runtime))),
  );
}

export function appleWorkspaceMountIsSafe(
  mounts: Array<{ source?: string; destination?: string; options?: string[] }> | undefined,
  platform: NodeJS.Platform,
  workspaceDir: string,
  workspaceGuest: string,
  addonsDir: string,
  addons: ReadonlyArray<PersistentLocalVmAddon> = [],
): boolean {
  const workspace = mounts?.find((mount) => mount.destination === workspaceGuest && !mount.options?.some((option) => option === "ro" || option === "readonly"));
  const expectedAddons = persistentAddonMounts(addons, addonsDir);
  return Boolean(
    workspace && mounts?.length === expectedAddons.length + 1 && sameWorkspaceSource(workspace.source, platform, workspaceDir) &&
      expectedAddons.every((addon) => mounts.some((mount) => mount.destination === addon.guestPath && mount.options?.some((option) => option === "ro" || option === "readonly") && sameWorkspaceSource(mount.source, platform, addon.source))),
  );
}
