// @vitest-environment happy-dom
// The per-account boxes in a real DOM: ticking every listed account keeps them as a limit, so an account connected
// later stays off until it is ticked too.
import { createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setLocale } from "@/lib/i18n";
import { ConnectorScopesControl } from "./AccessSection";

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  setLocale("en");
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => {
  flushSync(() => root.unmount());
  host.remove();
});

describe("ConnectorScopesControl accounts", () => {
  const accounts = { gmail: [{ id: "ca_work", alias: "work", status: "ACTIVE" }, { id: "ca_home", alias: "home", status: "ACTIVE" }] };
  const render = (scopes: Parameters<typeof ConnectorScopesControl>[0]["scopes"], onChange: (next: unknown) => void) =>
    flushSync(() => root.render(createElement(ConnectorScopesControl, { connectedSlugs: ["gmail"], accounts, scopes, onChange })));
  const box = (alias: string) => [...host.querySelectorAll("label")].find((label) => label.textContent === alias)!.querySelector("input")!;

  it("keeps a limit when the last unticked account is ticked back", () => {
    const changes: unknown[] = [];
    render({ apps: { gmail: "read" }, accounts: { gmail: ["ca_work"] } }, (next) => changes.push(next));
    expect(box("work").checked).toBe(true);
    expect(box("home").checked).toBe(false);
    flushSync(() => box("home").click());
    expect(changes).toEqual([{ apps: { gmail: "read" }, accounts: { gmail: ["ca_work", "ca_home"] } }]);
  });

  it("starts a limit from every connected account when one is unticked", () => {
    const changes: unknown[] = [];
    render({ apps: { gmail: "read" } }, (next) => changes.push(next));
    flushSync(() => box("work").click());
    expect(changes).toEqual([{ apps: { gmail: "read" }, accounts: { gmail: ["ca_home"] } }]);
  });
});
