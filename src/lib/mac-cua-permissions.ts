import { t } from "./i18n";

export type MacCuaPermission = "screen" | "accessibility";

/** Only the host's unavailable reason may name a missing grant. An absent or
 * unrelated status must not be presented as a permission diagnosis. */
export function missingMacCuaPermissions(reason: unknown): MacCuaPermission[] {
  if (typeof reason !== "string" || reason.length > 2_000) return [];
  const missingList = reason.match(/(Accessibility(?: and Screen Recording)?|Screen Recording(?: and Accessibility)?) required\b/i)?.[1];
  if (!missingList) return [];
  const missing: MacCuaPermission[] = [];
  if (/Screen Recording/i.test(missingList)) missing.push("screen");
  if (/Accessibility/i.test(missingList)) missing.push("accessibility");
  return missing;
}

export function macCuaPermissionMessage(permissions: MacCuaPermission[]): string | null {
  if (!permissions.length) return null;
  if (permissions.length > 1) return t("computer.mac.permission.requiredBoth");
  return t("computer.mac.permission.requiredOne", {
    permission: permissions[0] === "screen" ? "Screen Recording" : "Accessibility",
  });
}
