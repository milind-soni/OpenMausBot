// The Local VM's settings, read from the config the server loaded.
import { z } from "zod";

import type { AppConfig } from "./config.ts";
import {
  DEFAULT_DESKTOP_RESOURCES,
  MAX_DESKTOP_CPUS,
  MAX_DESKTOP_MEMORY_GB,
  MIN_DESKTOP_CPUS,
  MIN_DESKTOP_MEMORY_GB,
  type DesktopResources,
} from "./container-limits.ts";

export const DEFAULT_LOCAL_VM_MODE = "shared" as const;
export const DEFAULT_LOCAL_VM_MAX_INSTANCES = 2;
export const MIN_LOCAL_VM_MAX_INSTANCES = 1;
export const MAX_LOCAL_VM_MAX_INSTANCES = 8;
export const DEFAULT_LOCAL_VM_IDLE_TIMEOUT_MINUTES = 480;
export const MIN_LOCAL_VM_IDLE_TIMEOUT_MINUTES = 5;
export const MAX_LOCAL_VM_IDLE_TIMEOUT_MINUTES = 1_440;

/** Bot desktop isolation, default "shared"; `maxInstances` caps per-bot desktops or pool seats. Switching modes cold-starts every desktop. */
export const localVmConfigSchema = z.object({
  mode: z.enum(["shared", "per-bot", "pool"]).optional(),
  maxInstances: z
    .number()
    .int()
    .min(MIN_LOCAL_VM_MAX_INSTANCES)
    .max(MAX_LOCAL_VM_MAX_INSTANCES)
    .optional(),
  idleTimeoutMinutes: z
    .number()
    .int()
    .min(MIN_LOCAL_VM_IDLE_TIMEOUT_MINUTES)
    .max(MAX_LOCAL_VM_IDLE_TIMEOUT_MINUTES)
    .optional(),
  preserveInstalledApps: z.boolean().optional(),
  /** Each desktop's memory limit in GiB, with no swap beyond it; 4 when unset. New desktops take a change; on Docker and Podman a stopped one takes it when it next starts. */
  memoryGb: z.number().int().min(MIN_DESKTOP_MEMORY_GB).max(MAX_DESKTOP_MEMORY_GB).optional(),
  /** Each desktop's CPU limit; 2 when unset. Docker refuses more CPUs than its engine has. */
  cpus: z.number().int().min(MIN_DESKTOP_CPUS).max(MAX_DESKTOP_CPUS).optional(),
});

export function localVmMode(cfg: AppConfig): "shared" | "per-bot" | "pool" {
  return cfg.localVm?.mode ?? DEFAULT_LOCAL_VM_MODE;
}

export function localVmMaxInstances(cfg: AppConfig): number {
  return cfg.localVm?.maxInstances ?? DEFAULT_LOCAL_VM_MAX_INSTANCES;
}

export function localVmIdleTimeoutMinutes(cfg: AppConfig): number {
  return cfg.localVm?.idleTimeoutMinutes ?? DEFAULT_LOCAL_VM_IDLE_TIMEOUT_MINUTES;
}

/** App preservation is deliberately opt-in: a normal image replacement keeps its existing small, predictable footprint. */
export function localVmPreservesInstalledApps(cfg: AppConfig): boolean {
  return cfg.localVm?.preserveInstalledApps === true;
}

export function localVmResources(cfg: AppConfig): DesktopResources {
  return {
    memoryGb: cfg.localVm?.memoryGb ?? DEFAULT_DESKTOP_RESOURCES.memoryGb,
    cpus: cfg.localVm?.cpus ?? DEFAULT_DESKTOP_RESOURCES.cpus,
  };
}
