import { createRequire } from "node:module";
import { expect, it } from "vitest";
import { SETTINGS_PAGES } from "./settings-index";

it("every Settings page a Cloud's page can ask This computer for gets through the preload", () => {
  const require = createRequire(import.meta.url);
  const handlers = new Map<string, (event: unknown, section: unknown) => void>();
  const reached: unknown[] = [];
  const electron = require.resolve("electron");
  require.cache[electron] = { id: electron, filename: electron, loaded: true, exports: {
    ipcRenderer: { on: (channel: string, handler: (event: unknown, section: unknown) => void) => handlers.set(channel, handler), removeListener: () => {}, invoke: async () => {}, send: () => {} },
    contextBridge: { exposeInMainWorld: (_name: string, api: { onOpenAppSettings: (cb: (section: unknown) => void) => void }) => api.onOpenAppSettings((section) => reached.push(section)) },
    webUtils: { getPathForFile: () => "" },
  } } as unknown as NodeJS.Module;
  require("../../../electron/preload.cjs");
  for (const page of SETTINGS_PAGES) handlers.get("app:open-settings")?.({}, page.id);
  expect(reached).toEqual(SETTINGS_PAGES.map((page) => page.id));
});
