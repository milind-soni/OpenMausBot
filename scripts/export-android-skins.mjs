// Keep the Android color presets byte-for-byte aligned with the desktop skins.
// Run after changing styles.css: node scripts/export-android-skins.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const css = readFileSync(join(root, "src/styles.css"), "utf8");
const source = readFileSync(join(root, "src/lib/skins.ts"), "utf8");
const roles = [...source.match(/export const COLOR_ROLES = \[([\s\S]*?)\] as const/)?.[1].matchAll(/"([a-z-]+)"/g) ?? []].map((match) => match[1]);
const ids = [...source.match(/export const SKIN_IDS = \[([\s\S]*?)\] as const/)?.[1].matchAll(/"([a-z-]+)"/g) ?? []]
  .map((match) => match[1]).filter((id) => id !== "custom");
function block(re) { return css.match(re)?.[1] ?? ""; }
function tokens(text) {
  return Object.fromEntries([...text.matchAll(/--color-([a-z-]+):\s*(#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?|transparent)\s*;/g)]
    .map((match) => [match[1], match[2]]));
}
const fallback = { ...tokens(block(/@theme\s*\{([\s\S]*?)\}/)), ...tokens(block(/:root\s*\{([\s\S]*?)\}/)) };
const maps = {};
for (const id of ids) {
  const own = tokens(block(new RegExp(`\\[data-skin="${id}"\\]\\s*\\{([\\s\\S]*?)\\}`)));
  maps[id] = Object.fromEntries(roles.map((role) => {
    const value = own[role] ?? fallback[role];
    if (!value) throw new Error(`${id} has no ${role}`);
    return [role, value];
  }));
}
const kotlin = `// Generated from src/styles.css by scripts/export-android-skins.mjs. Do not hand-edit.\n` +
  `package com.openmausbot.companion.ui\n\n` +
  `object PresetThemes {\n` +
  `    val colorRoles: List<String> = listOf(${roles.map((r) => `"${r}"`).join(", ")})\n` +
  `    val colors: Map<String, Map<String, String>> = mapOf(\n` +
  ids.map((id) => `        "${id}" to mapOf(\n` +
    roles.map((role) => `            "${role}" to "${maps[id][role]}",`).join("\n") +
    `\n        ),`).join("\n") +
  `\n    )\n` +
  `    val lightThemes: Set<String> = setOf("atelier", "lagoon", "linen", "daylight", "chatgpt")\n` +
  `}\n`;
const target = join(root, "android/app/src/main/kotlin/com/openmausbot/companion/ui/PresetThemes.kt");
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== kotlin) {
    throw new Error("Android themes differ from desktop CSS. Run node scripts/export-android-skins.mjs");
  }
} else {
  writeFileSync(target, kotlin);
}
