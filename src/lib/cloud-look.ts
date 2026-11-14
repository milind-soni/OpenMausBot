import type { CloudColor } from "../../electron/cloud-buy.mjs";
import type { LocaleKey } from "@/locales";

/** A Cloud's colour names, as main saves them (environments.cjs ENTRY_COLORS); each skin tunes its own tone of each. */
export const CLOUD_COLORS = ["blue", "teal", "purple", "orange", "red", "yellow"] as const satisfies readonly CloudColor[];
export const DEFAULT_CLOUD_COLOR: CloudColor = "blue";
export const CLOUD_NAME_MAX = 28;
export const CLOUD_COLOR_LABEL = {
  blue: "cloudBuy.color.blue", teal: "cloudBuy.color.teal", purple: "cloudBuy.color.purple",
  orange: "cloudBuy.color.orange", red: "cloudBuy.color.red", yellow: "cloudBuy.color.yellow",
} as const satisfies Record<CloudColor, LocaleKey>;

export function cloudColor(value: unknown): CloudColor | null {
  return CLOUD_COLORS.includes(value as CloudColor) ? value as CloudColor : null;
}

/** The skin's tone for a saved colour; the fallback for none is the app's quiet control tone. */
export function cloudColorFill(value: unknown): string {
  const color = cloudColor(value);
  return color ? `var(--identity-${color})` : "var(--color-control)";
}

/** What the sheet shows while typing; main keeps the name it last accepted. */
export function cloudNameShown(typed: string, fallback: string): string {
  return typed.trim().replace(/\s+/g, " ") || fallback;
}
