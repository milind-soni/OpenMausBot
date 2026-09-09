#!/usr/bin/env node
// Reads the skin blocks out of src/styles.css and measures every text/surface
// pair the components actually produce. Run it after touching a palette:
//
//   pnpm check:contrast
//
// It parses the CSS rather than taking a second copy of the values, so the
// check can never pass against a palette that is no longer the shipped one.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src/styles.css"), "utf8");

function declarations(body) {
  const tokens = {};
  for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    tokens[name] = value.trim();
  }
  return tokens;
}

/** The tokens every skin starts from: the `@theme` defaults plus the bare
 * `:root` block. A skin that does not redefine one of these still SHIPS it,
 * so the check has to measure it — otherwise a token upstream adds is
 * inherited untested by every skin, and the run stays green while a light
 * skin wears a dark skin's focus ring. That is exactly what happened when
 * upstream introduced --color-focus. */
function parseBase(source) {
  const base = {};
  for (const [, body] of source.matchAll(/(?:@theme|:root)\s*\{([^}]*)\}/g)) {
    Object.assign(base, declarations(body));
  }
  return base;
}

/** Every `[data-skin="x"] { … }` block, as id → {token: value}, over the
 * inherited base so a skin is measured as it actually renders. */
function parseSkins(source) {
  const base = parseBase(source);
  const skins = new Map();
  for (const [, id, body] of source.matchAll(/\[data-skin="([a-z-]+)"\]\s*\{([^}]*)\}/g)) {
    skins.set(id, { ...base, ...declarations(body) });
  }
  return skins;
}

function parseHex(value) {
  const match = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!match) return null;
  const h = match[1];
  const full = h.length <= 4 ? Array.from(h, (c) => c + c).join("") : h;
  return {
    r: parseInt(full.slice(0, 2), 16),
    g: parseInt(full.slice(2, 4), 16),
    b: parseInt(full.slice(4, 6), 16),
    a: full.length === 8 ? parseInt(full.slice(6, 8), 16) / 255 : 1,
  };
}

/** Foreground alpha composited over an opaque background. */
function flatten(fg, bg) {
  if (fg.a === 1) return fg;
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  };
}

function luminance({ r, g, b }) {
  const channel = (v) => {
    const s = v / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(fgHex, bgHex) {
  const bg = parseHex(bgHex);
  const parsedFg = parseHex(fgHex);
  if (!parsedFg || !bg || bg.a !== 1) return null;
  const fg = flatten(parsedFg, bg);
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
}

// Pairs taken from what the components render, not from what looks plausible:
// body copy sits on all five surfaces, the filled accent/danger buttons carry
// their own ink token, and the status colours are used as text on cards.
const SURFACES = ["--color-app", "--color-panel", "--color-raised", "--color-raised-hover", "--color-card", "--color-inset", "--color-composer", "--color-menu"];
const PAIRS = [
  ...SURFACES.map((s) => ["--color-ink", s, 4.5]),
  ...SURFACES.map((s) => ["--color-ink-secondary", s, 4.5]),
  ["--color-bubble-user-ink", "--color-bubble-user", 4.5],
  ["--color-accent-ink", "--color-accent", 4.5],
  ["--color-danger-ink", "--color-danger", 4.5],
  ["--color-success-ink", "--color-success", 4.5],
  ["--color-accent-text", "--color-app", 4.5],
  ["--color-accent-text", "--color-panel", 4.5],
  ["--color-accent-text", "--color-card", 4.5],
  ["--color-danger", "--color-card", 4.5],
  ["--color-success", "--color-card", 4.5],
  ["--color-warning", "--color-card", 4.5],
  // borders and dots are UI components, not text — AA asks 3:1 of them
  ["--color-hairline", "--color-app", 1.5],
  ["--color-accent", "--color-app", 3],
  ["--color-scrollbar", "--color-app", 1.5],
  // The focus ring sits outside the control (outline-offset: 2px), so it
  // lands on whatever surface is behind it — a skin that inherits another
  // skin's ring keeps a colour that was never checked against its ground.
  // WCAG 1.4.11 asks 3:1 of a non-text indicator.
  ["--color-focus", "--color-app", 3],
  ["--color-focus", "--color-panel", 3],
  ["--color-focus", "--color-card", 3],
  // Surface against surface. Text contrast alone will not catch a skin that
  // gives two surfaces the same value: Atelier and Lagoon both defined
  // `raised` as the pure white they use for a card, so every chip, hover fill
  // and answered row painted in `raised` on a card was invisible while this
  // file stayed green. A surface is not text — it only has to be seen at all —
  // so the bar is a just-perceptible step rather than a WCAG ratio.
  //
  // `control` is measured against every surface it can land on, which is the
  // whole list: a tone chosen to clear the card and the panel drifted into
  // `inset` instead, and the badges inside an inset row went invisible again.
  ["--color-control", "--color-card", 1.06],
  ["--color-control", "--color-panel", 1.06],
  ["--color-control", "--color-app", 1.04],
  ["--color-control", "--color-inset", 1.04],
  ["--color-control", "--color-raised-hover", 1.04],
  ["--color-raised-hover", "--color-card", 1.04],
  ["--color-inset", "--color-card", 1.04],
  ["--color-card", "--color-app", 1.04],
  ["--color-panel", "--color-app", 1.03],
];

const skins = parseSkins(css);
// Midnight faithfully keeps two upstream contrast gaps. They may improve, but
// must not get worse; every other below-target pair is a regression.
const BASELINE_FLOORS = new Map([
  ["midnight|--color-accent-ink|--color-accent", 3.65],
  ["midnight|--color-danger-ink|--color-danger", 3.10],
]);
const BASELINE_DRIFT = 0.01;

let failed = false;
for (const [id, tokens] of skins) {
  const problems = [];
  const missing = [];
  const unmeasurable = [];
  let measured = 0;
  for (const [fg, bg, min] of PAIRS) {
    // A pair we cannot measure is reported, never silently skipped: an
    // unmeasured pair used to be counted as a passing one.
    if (!tokens[fg] || !tokens[bg]) {
      missing.push(!tokens[fg] ? fg : bg);
      continue;
    }
    const ratio = contrast(tokens[fg], tokens[bg]);
    if (ratio === null) {
      unmeasurable.push({ fg, bg, fgValue: tokens[fg], bgValue: tokens[bg] });
      continue;
    }
    measured++;
    if (ratio < min) problems.push({ fg, bg, ratio, min });
  }
  let skinFailed = missing.length > 0 || unmeasurable.length > 0;
  if (missing.length) {
    console.log(`✗ ${id} — undefined token(s): ${[...new Set(missing)].join(", ")}`);
  }
  for (const { fg, bg, fgValue, bgValue } of unmeasurable) {
    console.log(`✗ ${id} — cannot measure ${fg} on ${bg} (${fgValue} on ${bgValue})`);
  }
  if (problems.length === 0) {
    if (!skinFailed) console.log(`✓ ${id} — ${measured} pairs, none below target`);
    if (skinFailed) failed = true;
    continue;
  }
  for (const { fg, bg, ratio } of problems) {
    const floor = BASELINE_FLOORS.get(`${id}|${fg}|${bg}`);
    if (floor === undefined || ratio < floor - BASELINE_DRIFT) skinFailed = true;
  }
  console.log(`${skinFailed ? "✗" : "~"} ${id}${skinFailed ? "" : " (known upstream gaps)"}`);
  for (const { fg, bg, ratio, min } of problems) {
    const floor = BASELINE_FLOORS.get(`${id}|${fg}|${bg}`);
    const baseline = floor === undefined ? "" : `; baseline ${floor.toFixed(2)}:1`;
    console.log(`    ${fg} on ${bg}: ${ratio.toFixed(2)}:1 (needs ${min}:1${baseline})`);
  }
  if (skinFailed) failed = true;
}

// The inverted Daylight bubble has its own inherited context: the editor,
// labels, quotes and file chips explicitly use these tokens, not parent color.
const daylightBubble = {
  ...skins.get("daylight"),
  ...declarations(css.match(/@scope \(\[data-skin="daylight"\]\) to \(\[data-skin\]\)\s*\{\s*\.bg-bubble-user\s*\{([^}]*)\}/)?.[1] ?? ""),
};
for (const [fg, bg] of [
  ["--color-ink", "--color-bubble-user"],
  ["--color-ink-secondary", "--color-bubble-user"],
  ["--color-ink", "--color-raised"],
  ["--color-ink-secondary", "--color-raised-hover"],
  ["--color-ink-secondary", "--color-inset"],
  ["--color-accent", "--color-inset"],
  ["--color-accent-text", "--color-bubble-user"],
  ["--color-ink", "--color-control"],
  ["--color-accent-ink", "--color-accent"],
  ["--color-danger-ink", "--color-danger"],
  ["--color-success-ink", "--color-success"],
]) {
  const ratio = contrast(daylightBubble[fg] ?? "", daylightBubble[bg] ?? "");
  if (ratio === null || ratio < 4.5) {
    failed = true;
    console.log(`✗ daylight bubble — ${fg} on ${bg}: ${ratio?.toFixed(2) ?? "unmeasurable"}:1 (needs 4.5:1)`);
  }
}

if (!failed) console.log("✓ daylight bubble — editor, controls and paired fills above 4.5:1");
process.exit(failed ? 1 : 0);
