// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { BotEditorStore, initialState, type InstanceInfo, type useStore } from "@/state/store";
import { EnginesSettings } from "./EnginesSettings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOTICE = "Another copy of OpenCode on this computer doesn't start, so OpenCode now uses the copy MausBot installed.";
const install: InstanceInfo["install"] = {
  platform: "linux", command: { linux: "npm install -g opencode-ai" }, needsNode: true,
  server: { standalone: { version: "1.19.4", downloadBytes: 64_291_659 } },
};
const broken: InstanceInfo = {
  instanceId: "opencodeGo", driverKind: "opencodeGo", displayName: "OpenCode", cliDefault: "opencode",
  snapshot: { state: "unavailable", reason: "`opencode` version check failed." }, models: { default: "", options: [] }, install,
};
const ready: InstanceInfo = {
  ...broken, cli: "/data/tools/standalone/opencode/bin/opencode",
  snapshot: { state: "available", authenticated: true, version: "1.19.4" }, install: { ...install, appCopy: true },
};
let host: HTMLDivElement;
let root: Root;
const dispatch = vi.fn();

function mount(instances: InstanceInfo[]) {
  const store = {
    state: { ...initialState, instances, bots: [] }, dispatch, refreshInstances: vi.fn(), refreshModels: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof useStore>;
  act(() => root.render(createElement(BotEditorStore, { value: store, children: createElement(EnginesSettings) })));
}
const button = (name: string) => Array.from(host.querySelectorAll("button")).find((node) => node.textContent?.includes(name) || node.getAttribute("aria-label") === name);

beforeEach(() => {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  dispatch.mockReset();
  vi.stubGlobal("fetch", vi.fn(async (path: string) => new Response(JSON.stringify(
    String(path).endsWith("/install") ? { instances: [ready], usingAppCopy: true } : {},
  ))));
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.unstubAllGlobals(); });

it("keeps saying OpenCode now runs the app's copy once the switched copy is Ready, until dismissed", async () => {
  mount([broken]);
  await act(async () => button("Install OpenCode here")!.click());
  expect(dispatch).toHaveBeenCalledWith({ type: "instances", instances: [ready] });
  // The store takes the returned instances: OpenCode is Ready, its setup panel gone, and the notice stays on its card.
  mount([ready]);
  expect(button("Install OpenCode here")).toBeUndefined();
  expect(host.textContent).toContain("Ready");
  expect(host.textContent).toContain(NOTICE);
  act(() => button("Dismiss")!.click());
  expect(host.textContent).not.toContain(NOTICE);
});

it("forgets the notice when the person leaves Settings", async () => {
  mount([broken]);
  await act(async () => button("Install OpenCode here")!.click());
  mount([ready]);
  expect(host.textContent).toContain(NOTICE);
  act(() => root.unmount());
  root = createRoot(host);
  mount([ready]);
  expect(host.textContent).not.toContain(NOTICE);
});
