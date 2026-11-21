// Security: a theme's CSS comes from bots and from files people import, and CSS can send what is on screen to another
// site (an attribute selector plus a url()). The browser parses the text first, so every check below reads values the
// way the browser will use them; then any declaration or rule that could load something other than this server's theme
// files, a data: address or an #id is removed. A rule of a kind this file does not know is removed too.
import { themeValueLoads } from "../../../shared/theme";

type RuleParent = { readonly cssRules: CSSRuleList; deleteRule(index: number): void };
type Declarations = Pick<CSSStyleDeclaration, "length" | "item" | "getPropertyValue" | "removeProperty">;

class Unsafe extends Error {}

/** `instanceof` a CSSOM class this browser may not have. */
function is(rule: CSSRule, name: string): boolean {
  const kind = (globalThis as Record<string, unknown>)[name];
  return typeof kind === "function" && rule instanceof kind;
}

function declarationsOf(rule: CSSRule): Declarations | null {
  const style = (rule as { style?: unknown }).style;
  return style && typeof style === "object" && typeof (style as Declarations).getPropertyValue === "function" ? (style as Declarations) : null;
}

function stripDeclarations(style: Declarations): void {
  for (let index = style.length - 1; index >= 0; index--) {
    const property = style.item(index);
    if (themeValueLoads(style.getPropertyValue(property))) style.removeProperty(property);
  }
}

const isParent = (rule: CSSRule): rule is CSSRule & RuleParent =>
  "cssRules" in rule && typeof (rule as Partial<RuleParent>).deleteRule === "function";

function drop(parent: RuleParent, index: number, rule: CSSRule): void {
  try {
    parent.deleteRule(index);
  } catch {
    // The CSSOM refuses to delete an @namespace while other rules follow it; it names a namespace and loads nothing.
    if (!is(rule, "CSSNamespaceRule")) throw new Unsafe();
  }
}

/** Removes from `parent`, at every depth, what could load a file from elsewhere; throws when something cannot be removed. */
export function removeLoads(parent: RuleParent): void {
  for (let index = parent.cssRules.length - 1; index >= 0; index--) {
    const rule = parent.cssRules[index];
    if (!rule) continue;
    if (is(rule, "CSSKeyframesRule")) {
      for (const frame of Array.from((rule as CSSKeyframesRule).cssRules)) {
        const style = declarationsOf(frame);
        if (style) stripDeclarations(style);
      }
      continue;
    }
    if (is(rule, "CSSPropertyRule")) {
      // A registered property's initial value is used wherever var() reads it.
      if (themeValueLoads((rule as CSSPropertyRule).initialValue ?? "")) drop(parent, index, rule);
      continue;
    }
    const style = declarationsOf(rule);
    if (style) stripDeclarations(style);
    if (isParent(rule)) removeLoads(rule);
    else if (!style && !is(rule, "CSSLayerStatementRule")) drop(parent, index, rule);
  }
}

let sheet: CSSStyleSheet | null = null;
let applied = "";

/** The theme's CSS, after the app's own styles; replaced in place on every change. Empty removes it. */
export function applyThemeCss(css: string): void {
  if (typeof document === "undefined" || typeof CSSStyleSheet === "undefined" || !("adoptedStyleSheets" in document)) return;
  if (css === applied) return;
  applied = css;
  if (!sheet) {
    // An adopted sheet orders after the document's own, and replaceSync ignores @import.
    sheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  }
  try {
    sheet.replaceSync(css);
    removeLoads(sheet);
  } catch {
    sheet.replaceSync("");
  }
}

/** The rules the window kept, as text: what Settings shows as applied. */
export function appliedThemeRules(): string[] {
  return sheet ? Array.from(sheet.cssRules, (rule) => rule.cssText) : [];
}
