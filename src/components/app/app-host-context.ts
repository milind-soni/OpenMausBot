// Style variables are read resolved from the live document, so every skin maps without a table per skin: a
// frame cannot see this document's custom properties.
import { appVersion } from "@/lib/app-links";
import { readColorScheme, type ColorScheme } from "@/lib/color-scheme";
import { activeLocale } from "@/lib/i18n";
import type { AppHostContext } from "../../../shared/app-frame/bridge";

const VARIABLES: ReadonlyArray<readonly [string, string]> = [
  ["--color-background-primary", "var(--color-composer)"],
  ["--color-background-secondary", "var(--color-inset)"],
  ["--color-background-tertiary", "color-mix(in srgb, var(--color-ink) 7%, var(--color-composer))"],
  ["--color-background-inverse", "var(--color-ink)"],
  ["--color-background-ghost", "transparent"],
  ["--color-background-info", "color-mix(in srgb, var(--color-accent) 13%, var(--color-composer))"],
  ["--color-background-danger", "color-mix(in srgb, var(--color-danger) 13%, var(--color-composer))"],
  ["--color-background-success", "color-mix(in srgb, var(--color-success) 13%, var(--color-composer))"],
  ["--color-background-warning", "color-mix(in srgb, var(--color-warning) 13%, var(--color-composer))"],
  ["--color-background-disabled", "color-mix(in srgb, var(--color-ink) 5%, var(--color-composer))"],
  ["--color-text-primary", "var(--color-ink)"],
  ["--color-text-secondary", "var(--color-ink-secondary)"],
  ["--color-text-tertiary", "var(--color-ink-tertiary)"],
  ["--color-text-inverse", "var(--color-app)"],
  ["--color-text-info", "var(--color-accent-text)"],
  ["--color-text-danger", "var(--color-danger)"],
  ["--color-text-success", "var(--color-success)"],
  ["--color-text-warning", "var(--color-warning)"],
  ["--color-text-disabled", "var(--color-ink-tertiary)"],
  ["--color-text-ghost", "var(--color-ink-tertiary)"],
  // Lines are a tint of the ink over the card, not the skin's hairline: the
  // dark skins' hairline is within a few steps of their card and vanishes there.
  ["--color-border-primary", "color-mix(in srgb, var(--color-ink) 20%, var(--color-composer))"],
  ["--color-border-secondary", "color-mix(in srgb, var(--color-ink) 13%, var(--color-composer))"],
  ["--color-border-tertiary", "color-mix(in srgb, var(--color-ink) 8%, var(--color-composer))"],
  ["--color-border-inverse", "var(--color-app)"],
  ["--color-border-ghost", "transparent"],
  ["--color-border-info", "var(--color-accent-border)"],
  ["--color-border-danger", "var(--color-danger)"],
  ["--color-border-success", "var(--color-success)"],
  ["--color-border-warning", "var(--color-warning)"],
  ["--color-border-disabled", "color-mix(in srgb, var(--color-ink) 10%, var(--color-composer))"],
  ["--color-ring-primary", "var(--color-focus)"],
  ["--color-ring-secondary", "color-mix(in srgb, var(--color-ink) 20%, var(--color-composer))"],
  ["--color-ring-inverse", "var(--color-app)"],
  ["--color-ring-info", "var(--color-accent)"],
  ["--color-ring-danger", "var(--color-danger)"],
  ["--color-ring-success", "var(--color-success)"],
  ["--color-ring-warning", "var(--color-warning)"],
  ["--font-sans", "var(--font-sans)"],
  ["--font-mono", "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"],
  ["--font-weight-normal", "400"],
  ["--font-weight-medium", "500"],
  ["--font-weight-semibold", "600"],
  ["--font-weight-bold", "700"],
  ["--font-text-xs-size", "12px"], ["--font-text-xs-line-height", "16px"],
  ["--font-text-sm-size", "13px"], ["--font-text-sm-line-height", "18px"],
  ["--font-text-md-size", "14px"], ["--font-text-md-line-height", "20px"],
  ["--font-text-lg-size", "16px"], ["--font-text-lg-line-height", "22px"],
  ["--font-heading-xs-size", "14px"], ["--font-heading-xs-line-height", "20px"],
  ["--font-heading-sm-size", "15px"], ["--font-heading-sm-line-height", "22px"],
  ["--font-heading-md-size", "17px"], ["--font-heading-md-line-height", "24px"],
  ["--font-heading-lg-size", "20px"], ["--font-heading-lg-line-height", "28px"],
  ["--font-heading-xl-size", "24px"], ["--font-heading-xl-line-height", "32px"],
  ["--font-heading-2xl-size", "28px"], ["--font-heading-2xl-line-height", "36px"],
  ["--font-heading-3xl-size", "32px"], ["--font-heading-3xl-line-height", "40px"],
  ["--border-radius-xs", "4px"],
  ["--border-radius-sm", "8px"],
  ["--border-radius-md", "12px"],
  ["--border-radius-lg", "16px"],
  ["--border-radius-xl", "24px"],
  ["--border-radius-full", "9999px"],
  ["--border-width-regular", "1px"],
  ["--shadow-hairline", "0 0 0 1px color-mix(in srgb, var(--color-ink) 20%, var(--color-composer))"],
  ["--shadow-sm", "0 1px 2px rgb(0 0 0 / 0.08)"],
  ["--shadow-md", "0 4px 12px rgb(0 0 0 / 0.12)"],
  ["--shadow-lg", "0 12px 32px rgb(0 0 0 / 0.16)"],
];

const TOKEN = /var\((--[\w-]+)\)/g;

/** A variable whose token this document does not define is left out, so the View's own default applies. */
export function appStyleVariables(root: Element | null = typeof document === "undefined" ? null : document.documentElement): Record<string, string> {
  const style = root && typeof getComputedStyle === "function" ? getComputedStyle(root) : null;
  const out: Record<string, string> = {};
  for (const [name, css] of VARIABLES) {
    let missing = false;
    const value = css.replace(TOKEN, (_whole, token: string) => {
      const resolved = style?.getPropertyValue(token).trim() ?? "";
      if (!resolved) missing = true;
      return resolved;
    });
    if (!missing) out[name] = value.replace(/\s+/g, " ").trim();
  }
  return out;
}

export function appMaxHeight(): number {
  const viewport = typeof window !== "undefined" && window.innerHeight > 0 ? window.innerHeight : 1_000;
  return Math.max(48, Math.round(Math.min(720, viewport * 0.7)));
}

function matches(query: string): boolean {
  try { return typeof matchMedia === "function" && matchMedia(query).matches; } catch { return false; }
}

/** "desktop" in the Electron app, "web" in a browser reaching a server remotely. */
export function appPlatform(): "desktop" | "web" {
  return typeof window !== "undefined" && window.ogb ? "desktop" : "web";
}

export function appThemeContext(scheme: ColorScheme = readColorScheme()): Pick<AppHostContext, "theme" | "styles"> {
  return { theme: scheme, styles: { variables: appStyleVariables() } };
}

export function appHostContext(args: { width: number; maxHeight: number }): AppHostContext {
  let timeZone: string | undefined;
  try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { timeZone = undefined; }
  return {
    ...appThemeContext(),
    displayMode: "inline",
    availableDisplayModes: ["inline"],
    containerDimensions: { width: Math.round(args.width), maxHeight: Math.round(args.maxHeight) },
    locale: activeLocale(),
    ...(timeZone ? { timeZone } : {}),
    platform: appPlatform(),
    deviceCapabilities: { touch: matches("(pointer: coarse)") || (typeof navigator !== "undefined" && navigator.maxTouchPoints > 0), hover: matches("(hover: hover)") },
    userAgent: `MausBot/${appVersion()}`,
  };
}
