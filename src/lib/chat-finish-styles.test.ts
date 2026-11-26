// The chat and composer finish: the composer's lift, the bot bubble's sheen and the press feedback, read from the
// stylesheet so a skin block never has to repeat them (skins.test.ts keeps every skin's token set equal).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ELEVATED_COMPOSER, ELEVATED_FLOAT } from "@/components/elevated";
import { SIMPLE_COMPOSER, SIMPLE_CONTROL } from "@/components/composer-simple";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../styles.css"), "utf8");
const squash = (text: string) => text.replace(/\s+/g, " ");
const flat = squash(css);
const skinBlocks = [...css.matchAll(/\[data-skin="[a-z-]+"\]\s*\{([^}]*)\}/g)].map(([, body]) => body!);

describe("the composer's lift", () => {
  it("defines --shadow-composer once, on :root, and in no skin block", () => {
    expect(flat).toContain("--shadow-composer: 0 2px 8px -1px rgb(0 0 0 / 0.05), 0 1px 2px rgb(0 0 0 / 0.03), 0 0 0 1px rgb(28 28 28 / 0.04);");
    expect(css.match(/--shadow-composer:/g)).toHaveLength(1);
    for (const body of skinBlocks) expect(body).not.toContain("--shadow-composer");
  });

  it("puts both modes' composer on it, with the ring kept for hover and focus", () => {
    expect(ELEVATED_COMPOSER.split(" ")).toEqual(expect.arrayContaining(["bg-composer", "ring-[0.5px]", "ring-ink/10", "composer-shell", "shadow-(--shadow-composer)"]));
    expect(SIMPLE_COMPOSER.split(" ")).toEqual(expect.arrayContaining([...ELEVATED_COMPOSER.split(" "), "hover:ring-ink/[0.22]", "focus-within:ring-ink/[0.22]"]));
    expect(SIMPLE_COMPOSER).not.toContain("228_228_228");
  });

  it("drops the resting ring in Daylight only", () => {
    expect(flat).toContain(':root[data-skin="daylight"] .composer-shell:not(:hover, :focus-within) { --tw-ring-color: transparent; }');
    expect(flat.match(/\.composer-shell[^{]*\{/g)).toHaveLength(1);
  });
});

describe("the chat header's pill and controls", () => {
  it("float on --shadow-float, which only Daylight fills in", () => {
    expect(ELEVATED_FLOAT.split(" ")).toContain("shadow-(--shadow-float)");
    expect(flat).toContain("--shadow-float: 0 4px 12px -1px rgb(28 28 28 / 0.08), 0 2px 4px -2px rgb(28 28 28 / 0.06);");
  });
});

describe("the composer's round controls", () => {
  it("sit on ink at 6% with an inset 0.5px line of ink at 8%, and keep the tertiary ink", () => {
    expect(SIMPLE_CONTROL.split(" ")).toEqual(expect.arrayContaining(["bg-ink/[0.06]", "inset-ring-[0.5px]", "inset-ring-ink/[0.08]", "text-ink-tertiary"]));
    // `ring-inset` would also read as a ring in the `inset` colour token and hide the ink line, so the inset-ring
    // utilities draw it.
    expect(SIMPLE_CONTROL.split(" ")).not.toContain("ring-inset");
  });
});

describe("a bot's bubble finish", () => {
  it("is a top-lit sheen and three inset half-pixel lines, off on a dark ground", () => {
    expect(flat).toContain(".bubble-finish { background-image: linear-gradient(rgb(255 255 255 / 0.16), transparent); box-shadow: inset 0 0.5px 0 rgb(255 255 255 / 0.16), inset 0 -0.5px 0 rgb(255 255 255 / 0.16), inset 0 0 0 0.5px color-mix(in srgb, var(--color-ink) 6%, transparent); }");
    expect(flat).toContain("@container style(--code-color-scheme: dark) { .bubble-finish { background-image: none; box-shadow: none; } }");
  });
});

describe("press feedback", () => {
  it("shrinks buttons to 98% over 50ms, only when motion is allowed", () => {
    expect(flat).toContain("transition: background-color 120ms ease, color 120ms ease, transform 50ms cubic-bezier(0.165, 0.84, 0.44, 1);");
    expect(flat).toContain('@media (prefers-reduced-motion: no-preference) { :root:not([data-reduced-motion="true"]) :is(.ui-button, .ui-icon-button):not(:disabled):active { transform: scale(0.98); } }');
  });

  it("shrinks the sidebar's bot rows the same way, but not when a button inside the row is pressed", () => {
    expect(flat).toContain('@media (prefers-reduced-motion: no-preference) { :root:not([data-reduced-motion="true"]) [data-sidebar-bot-row]:active:not(:has(button:active)) { scale: 0.98; } }');
    expect(flat).toMatch(/\[data-sidebar-bot-row\] \{ transition-property: [^;]*scale; transition-duration: [^;]*50ms;/);
    expect(flat).toContain(":root[data-reduced-motion=\"true\"] [data-sidebar-bot-row] { transition: none; }");
  });
});
