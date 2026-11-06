import { z } from "zod";
import type { AppConfig } from "./config.ts";
import {
  MAX_LOCAL_VM_IDLE_TIMEOUT_MINUTES,
  MAX_LOCAL_VM_MAX_INSTANCES,
  MIN_LOCAL_VM_IDLE_TIMEOUT_MINUTES,
  MIN_LOCAL_VM_MAX_INSTANCES,
} from "./local-vm-settings.ts";
import { isValidSshAlias } from "./ssh-alias.ts";

/** Bot desktop isolation, default "shared"; `maxInstances` caps per-bot desktops or pool seats. Switching modes cold-starts every desktop.
 * Managed preserves the historical container-backed Local VM. Existing is
 * one user-owned Linux VM reached through a validated SSH alias. */
export const localVmConfigSchema = z.object({
  source: z.enum(["managed", "existing"]).optional(),
  mode: z.enum(["shared", "per-bot", "pool"]).optional(),
  maxInstances: z
    .number()
    .int()
    .min(MIN_LOCAL_VM_MAX_INSTANCES)
    .max(MAX_LOCAL_VM_MAX_INSTANCES)
    .optional(),
  sshAlias: z.string().refine((value) => value === "" || isValidSshAlias(value), {
    message: "must be a simple SSH config alias",
  }).optional(),
  idleTimeoutMinutes: z
    .number()
    .int()
    .min(MIN_LOCAL_VM_IDLE_TIMEOUT_MINUTES)
    .max(MAX_LOCAL_VM_IDLE_TIMEOUT_MINUTES)
    .optional(),
  preserveInstalledApps: z.boolean().optional(),
});

export type LocalVmConfig = z.infer<typeof localVmConfigSchema>;

export function localVmSource(cfg: Pick<AppConfig, "localVm">): "managed" | "existing" {
  return cfg.localVm?.source === "existing" ? "existing" : "managed";
}

export function localVmSshAlias(cfg: Pick<AppConfig, "localVm">): string | null {
  return isValidSshAlias(cfg.localVm?.sshAlias) ? cfg.localVm.sshAlias : null;
}
