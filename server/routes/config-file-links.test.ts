import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RequestAuth } from "../request-auth.ts";
import { createConfigRoutes, type ConfigRouteDeps } from "./config.ts";

const ownerAuth: RequestAuth = { kind: "loopback", scopes: ["admin"] };
const guestAuth: RequestAuth = {
  kind: "session",
  session: { id: "guest", scopes: ["client"], teamRole: "member" } as never,
  via: "bearer",
  scopes: ["client"],
};

describe("fileLinks.extraRoots configuration", () => {
  it("refuses extraRoots on cloud workspaces or for non-admin sessions, and rejects invalid/overlapping folders", async () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-cfg-links-"));
    const dataDir = join(dir, "app-data");
    const docsDir = join(dir, "docs");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(docsDir, { recursive: true });
    try {
      const callRoute = async (
        cloudHome: boolean,
        auth: RequestAuth,
        extraRoots: string[],
        options: { configured?: string[]; expectedExtraFileLinkRoots?: unknown } = {},
      ) => {
        const replies: Array<{ status: number; body: unknown }> = [];
        const route = createConfigRoutes({
          cloudHome,
          forbiddenFileLinkDirs: () => [dataDir],
          store: { bots: [] },
          cfg: options.configured ? { fileLinks: { extraRoots: options.configured } } : {},
          registry: { get: vi.fn(), forgetSnapshots: vi.fn() },
          sessions: { revalidateEmailSessions: vi.fn() },
          browserCleanup: { hasPendingProfile: () => false, prepare: vi.fn(), abort: vi.fn(), commit: vi.fn(), ensure: vi.fn() },
          browserLive: { closeAll: vi.fn(), closeForSession: vi.fn() },
          browserRuntime: { heldBy: () => undefined },
          usedBrowserSessions: new Map(),
          decider: { testKey: vi.fn() },
          sharedComputers: { close: vi.fn() },
          sharedComputerControl: { close: vi.fn() },
          hostedModels: false,
          sharedMembership: () => false,
          lendingEnabled: () => false,
          providerConfigs: () => ({}),
          localVmIdleMs: () => 0,
          localVmIdles: new Map(),
          localVmActiveThreads: new Set(),
          localVmLifecycleBusy: new Set(),
          localVmImageBusy: { get: () => false },
          localVmModeChangeBusy: { set: vi.fn() },
          localVmModeChanging: () => () => {},
          providerConfigBusy: { get: () => false, set: vi.fn() },
          computerProviderConfigTransitions: new Set(),
          managedBoatOwners: () => [],
          providerOperationConflict: () => null,
          perBotLocalVmCountForModeChange: async () => 0,
          checkedModelSelection: vi.fn(),
          policyModelRefusal: () => undefined,
          browserSessionSpec: vi.fn(),
          configStatus: () => ({}),
          configForAccess: (s: unknown) => s,
          resyncOpenCodeProviderKeys: vi.fn(),
          revokeEngineCapabilities: vi.fn(),
          reloadProviders: vi.fn(async () => {}),
          broadcast: vi.fn(),
          drainQueuedSends: vi.fn(),
        } as unknown as ConfigRouteDeps);

        await route({
          req: {}, res: {}, url: new URL("http://127.0.0.1/api/config"), path: "/api/config", method: "PUT", auth,
          json: (_res: unknown, status: number, body: unknown) => { replies.push({ status, body }); },
          readBody: async () => ({
            fileLinks: { extraRoots },
            ...(options.expectedExtraFileLinkRoots !== undefined ? { expectedExtraFileLinkRoots: options.expectedExtraFileLinkRoots } : {}),
          }),
        } as unknown as Parameters<typeof route>[0]);
        return replies[0]!;
      };

      expect((await callRoute(true, ownerAuth, [docsDir])).status).toBe(403);
      expect((await callRoute(false, guestAuth, [docsDir])).status).toBe(403);
      expect((await callRoute(false, ownerAuth, ["relative/dir"])).status).toBe(400);
      expect((await callRoute(false, ownerAuth, [dataDir])).status).toBe(400);
      expect((await callRoute(false, ownerAuth, [dir])).status).toBe(400);
      expect((await callRoute(false, ownerAuth, [docsDir], { configured: [], expectedExtraFileLinkRoots: ["/stale/folder"] })).status).toBe(409);
      expect((await callRoute(false, ownerAuth, [docsDir], { configured: [], expectedExtraFileLinkRoots: [123] })).status).toBe(400);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
