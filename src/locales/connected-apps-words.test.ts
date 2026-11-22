import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "@typescript/typescript6";
import { describe, expect, it } from "vitest";

import en from "./en.json";
import { locales } from "./index";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const APPS_COPY = /^(connectors\.|apps\.|settings\.connections\.|keys\.composio|keys\.purpose\.composio|hostedMcp\.)/;
const NO_KEY_FLOW = [
  "connectors.setupNeeded",
  "connectors.setup.step1",
  "connectors.setup.openComposio",
  "connectors.setup.step2",
  "connectors.setup.step3",
  "connectors.setup.pasteKey",
  "connectors.tile.needsKey",
  "connectors.empty.noKeyDesc",
  "connectors.empty.addMcp",
  "connectors.setupNeededRemote",
  "connectors.notConfigured",
  "connectors.selfHostOnly",
  "connectors.selfHostOnlyReason",
  "settings.connections.selfHost",
];
/** What a bot is told about connected apps, and the refusals it relays. */
const BOT_FACING = [
  "server/app-events.ts",
  "server/app-trigger-host.ts",
  "server/app-triggers.ts",
  "server/composio-project.ts",
  "server/connector-account-hint.ts",
  "server/connector-advertisement.ts",
  "server/connector-arguments.ts",
  "server/connector-auth-config-hint.ts",
  "server/connector-files.ts",
  "server/connector-proxy.ts",
  "server/connector-scope-hint.ts",
  "server/connector-signed-out-hint.ts",
  "server/connector-verdict.ts",
  "server/setup-mode.ts",
  "shared/connector-availability.ts",
];

function literals(path: string): string[] {
  const file = ts.createSourceFile(path, readFileSync(`${ROOT}${path}`, "utf8"), ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) found.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("connected apps copy", () => {
  it("has the no-key steps in every language", () => {
    const missing = Object.entries(locales).flatMap(([code, pack]) =>
      NO_KEY_FLOW.filter((key) => !(pack as Record<string, string>)[key]?.trim()).map((key) => `${code}: ${key}`));
    expect(missing).toEqual([]);
  });

  it("never names MausBot or a managed service the person can't see", () => {
    const offending = Object.entries(locales).flatMap(([code, pack]) =>
      Object.entries(pack as Record<string, string>)
        .filter(([key, value]) => APPS_COPY.test(key) && /MausBot/.test(value))
        .map(([key]) => `${code}: ${key}`));
    expect(offending).toEqual([]);
    expect(Object.entries(en as Record<string, string>).filter(([key, value]) => APPS_COPY.test(key) && /self-host/i.test(value))).toEqual([]);
  });

  it("tells bots about Edu Bot, never MausBot", () => {
    const offending = BOT_FACING.flatMap((path) => literals(path).filter((text) => /MausBot/.test(text)).map((text) => `${path}: ${text.slice(0, 80)}`));
    expect(offending).toEqual([]);
  });
});
