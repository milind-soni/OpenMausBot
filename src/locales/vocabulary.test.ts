import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import en from "./en.json";
import { locales } from "./index";

const RETIRED: ReadonlyArray<readonly [string, RegExp, string]> = [
  ["OMB Cloud", /OMB Cloud/i, "MausBot Cloud"],
  ["OpenMausBot Cloud", /OpenMausBot Cloud/i, "MausBot Cloud"],
  ["MausBot Pro", /MausBot Pro\b/, "MausBot Cloud"],
  // \b before "_" fails, so environment names such as OMB_PUBLIC_IPV4 pass.
  ["OMB", /\bOMB\b/, "MausBot"],
  ["Cloud box", /Cloud box/i, "cloud desktop"],
  ["Hosted desktop", /Hosted desktop/i, "cloud desktop"],
  ["Cloud VM", /Cloud VM/i, "cloud desktop"],
  ["Boat cloud runner", /Boat cloud runner/i, "cloud desktop"],
  ["Cloud dashboard", /Cloud dashboard/i, "Plan page"],
  ["Connect to my Cloud", /Connect to my Cloud/i, "Open the Cloud"],
  ["your Cloud", /\b[Yy]our Cloud\b(?! plan| account| sign-in| subscription)/, "the Cloud"],
  ["my Cloud", /\bmy Cloud\b/, "the Cloud"],
  ["Local (this computer)", /Local \(this computer\)/, "This computer"],
  ["Cloud as a Works on choice", /\b(?:[Cc]hoose|[Ss]elect) Cloud\b(?! computer| desktop)|\bAuto, Cloud\b(?! computer| desktop)|, Cloud, /, "Cloud desktop"],
  ["T3", /\bT3\b/, "no other app's name"],
];

// Boat makes the cloud desktops and is credited where they appear ("from Boat", "by Boat"); it never names one desktop.
const OWN_KEY = /Boat (?:API key|account|key|token|plan|provider|credentials|setup|is not configured|is not connected|is a paid service)|boat\.dev|\b(?:Connect|Configure) Boat\b|\b(?:from|by) Boat\b/g;
const BOAT = /\bBoats?\b/;

function retiredIn(text: string, boat: RegExp = BOAT): string[] {
  const found = RETIRED.filter(([, pattern]) => pattern.test(text)).map(([word, , use]) => `"${word}" (say ${use})`);
  if (boat.test(text.replace(OWN_KEY, ""))) found.push(`"Boat" (say cloud desktop; Boat only names a person's own key)`);
  return found;
}

const PENDING_KEY_PREFIXES: string[] = [];
const EN_ALLOWED: Record<string, string> = {
  "botAccess.cloud.boat": "the own-key provider picker names its two providers, Boat and a VPS",
  "botAccess.cloud.hostedBackendDescription": "the own-key provider picker names its two providers, Boat and a VPS",
  "botAccess.cloud.vpsAutoDescription": "the own-key provider picker's VPS line names its Cloud choice",
  "boatOffer.title": "Boat's credit offer names Boat, whose credit and plan it is",
  "boatOffer.body": "Boat's credit offer names Boat, whose credit and plan it is",
  "boatOffer.get": "Boat's credit offer names Boat, whose credit and plan it is",
};

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SCANNED = ["src", "server", "electron", "shared"];
// Test fixtures and generated output are not copy anyone reads.
const SKIPPED_DIRS = new Set(["node_modules", "resources", "testing", "dist"]);
const isSource = (name: string) => /\.(?:ts|tsx|mjs|cjs|js)$/.test(name) && !/\.test\.|\.node-test\.|\.d\.ts$/.test(name);

/** No snippet keeps the word file-wide; otherwise only literals containing the snippet. */
const ALLOWED: ReadonlyArray<{ file: string; snippet?: string; why: string }> = [
  { file: "shared/credential-request.ts", snippet: "when Boat is selected", why: "the card that asks for a person's own Boat key" },
  { file: "server/boat-create-idempotency.ts", snippet: "unnamed Boat", why: "own-key repair: boat.dev's own name for a machine" },
  { file: "src/lib/boat-offer.ts", snippet: "MausBot introduced me", why: "the email a person sends Boat to claim its credit" },
  { file: "server/workspace-backup.ts", snippet: "OMB-WORKSPACE-1", why: "a backup file's format marker" },
  { file: "electron/company-backups.mjs", snippet: "OMB-WORKSPACE-1", why: "a backup file's format marker" },
];

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIPPED_DIRS.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (isSource(name)) yield path;
  }
}

function literals(path: string): Array<{ line: number; text: string }> {
  const kind = path.endsWith(".tsx") ? ts.ScriptKind.TSX : /\.(?:mjs|cjs|js)$/.test(path) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, false, kind);
  const found: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isJsxText(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      found.push({ line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

function hardcodedFindings(): Array<{ file: string; line: number; text: string; what: string[] }> {
  const found: Array<{ file: string; line: number; text: string; what: string[] }> = [];
  for (const top of SCANNED) {
    for (const path of sources(join(ROOT, top))) {
      const file = relative(ROOT, path).split("\\").join("/");
      for (const { line, text } of literals(path)) {
        const what = retiredIn(text);
        if (what.length > 0) found.push({ file, line, text, what });
      }
    }
  }
  return found;
}

const allows = (entry: (typeof ALLOWED)[number], finding: { file: string; text: string }) =>
  entry.file === finding.file && (entry.snippet === undefined || finding.text.includes(entry.snippet));

describe("one name per thing", () => {
  it("English copy uses MausBot Cloud, the Cloud, Cloud desktop, This computer and Plan page", () => {
    const offending = Object.entries(en as Record<string, string>)
      .filter(([key]) => !PENDING_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)) && !Object.hasOwn(EN_ALLOWED, key))
      // English keys are UI copy, so lower-case "boat" counts too.
      .flatMap(([key, value]) => retiredIn(value, /\bboats?\b/i).map((what) => `${key}: ${what}`));
    expect(offending).toEqual([]);
  });

  const productNames = RETIRED.filter(([, , use]) => use === "MausBot Cloud");
  it("translations never show OMB, T3 or an old name for MausBot Cloud, keep its name as it is, and say Boat only where the English does", () => {
    const offending = Object.entries(locales).filter(([code]) => code !== "en").flatMap(([code, pack]) =>
      Object.entries(pack)
        .filter(([key]) => !PENDING_KEY_PREFIXES.some((prefix) => key.startsWith(prefix)))
        .filter(([key, value]) => /\bOMB\b|\bT3\b/.test(value!) || productNames.some(([, pattern]) => pattern.test(value!))
          || (/MausBot Cloud/.test((en as Record<string, string>)[key]!) && !/MausBot Cloud/.test(value!))
          || (/boat/i.test(value!) && !/\bboats?\b/i.test((en as Record<string, string>)[key]!)))
        .map(([key]) => `${code}: ${key}`));
    expect([...new Set(offending)]).toEqual([]);
  });

  it("hard-coded strings in src, server, electron and shared use the same words", () => {
    const findings = hardcodedFindings();
    const offending = findings
      .filter((finding) => !ALLOWED.some((entry) => allows(entry, finding)))
      .flatMap(({ file, line, text, what }) => what.map((one) => `${file}:${line}: ${one}: ${JSON.stringify(text.trim().slice(0, 120))}`));
    expect(offending).toEqual([]);
    const stale = ALLOWED.filter((entry) => !findings.some((finding) => allows(entry, finding)))
      .map((entry) => `${entry.file}${entry.snippet ? ` (${entry.snippet})` : ""}`);
    expect(stale).toEqual([]);
    const staleKeys = Object.keys(EN_ALLOWED).filter((key) => !Object.hasOwn(en, key) || retiredIn((en as Record<string, string>)[key]!, /\bboats?\b/i).length === 0);
    expect(staleKeys).toEqual([]);
  });

  it("the public docs name MausBot Cloud and the Cloud as the app does", () => {
    const names = new Set(["OMB Cloud", "OpenMausBot Cloud", "MausBot Pro", "Connect to my Cloud", "your Cloud", "my Cloud"]);
    const cloudNames = RETIRED.filter(([word]) => names.has(word));
    const pages = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? pages(path) : /\.mdx?$/.test(name) ? [path] : [];
    });
    const offending = pages(join(ROOT, "apps/docs/content")).flatMap((path) =>
      readFileSync(path, "utf8").split("\n").flatMap((text, index) => cloudNames
        .filter(([, pattern]) => pattern.test(text))
        .map(([word, , use]) => `${relative(ROOT, path).split("\\").join("/")}:${index + 1}: "${word}" (say ${use})`)));
    expect(offending).toEqual([]);
  });

  it("copy that points at a control names it exactly as the control is labelled", () => {
    const e = en as Record<string, string>;
    const source = (file: string) => readFileSync(join(ROOT, file), "utf8");
    const myCloud = /CLOUD_HOME_NAME = "([^"]+)"/.exec(source("electron/cloud-home.mjs"))?.[1];
    const thisComputer = /id: "workspace-local", label: "([^"]+)"/.exec(source("electron/environments.cjs"))?.[1];
    const serverMenuLocal = /\{ label: "([^"]+)", type: "radio", checked: !active/.exec(source("electron/menu.mjs"))?.[1];
    expect([myCloud, thisComputer, serverMenuLocal]).toEqual([e["cloudSetup.myCloud"], e["place.local"], e["place.local"]]);
    const pointers: Array<[string, string[]]> = [
      ["cloudHome.connectHelp", [e["place.local"]!]],
      ["cloudPhone.step1", [myCloud!]],
      ["cloudAccount.onCloudSignIn", [e["cloudAccount.signInAgain"]!]],
      ["cloudAccount.storageFailed", [e["cloudAccount.signOut"]!]],
      ["cloudAccount.codeExpired", [e["cloudAccount.signIn"]!]],
      ["computer.routines.offWarning", [e["routines.runsOn.boat"]!]],
    ];
    const stale = pointers.flatMap(([key, labels]) => labels.filter((label) => !e[key]!.includes(label)).map((label) => `${key} → ${label}`));
    expect(stale).toEqual([]);
  });

  it("the check catches each retired word, and lets own-key Boat and env names through", () => {
    for (const bad of [
      "Sign in to OMB Cloud", "Sign in to OpenMausBot Cloud", "Get OpenMausBot Pro", "MausBot Pro plans",
      "restart OMB", "Cloud box", "Hosted desktop", "Run it in its cloud VM", "Boat cloud runner",
      "Open your Cloud dashboard", "Connect to my Cloud", "Your Cloud is ready", "Let my Cloud use this Mac",
      "Local (this computer)", "Choose Cloud to wake", "Auto, Cloud or Browser", "including one from T3",
      "Auto uses this Boat", "New Boat computer",
    ]) expect(retiredIn(bad), bad).not.toEqual([]);
    for (const good of [
      "Sign in to MausBot Cloud", "Pro active · verified by MausBot Cloud", "Restart OpenMausBot", "locked by another OpenMausBot process",
      "set OMB_PUBLIC_IPV4", "Open My Cloud", "Open the Cloud", "Choose Cloud desktop to wake", "Auto, Cloud desktop or Browser",
      "Included with your Cloud plan", "Add a Boat API key in Settings → API keys", "Connect Boat", "Check boat.dev",
      "Bots here can get their own cloud desktops from Boat, a paid service", "Cloud desktops by Boat",
      "Local VM", "Open your Plan page",
    ]) expect(retiredIn(good), good).toEqual([]);
  });
});
