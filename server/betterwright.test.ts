// What these tests pin about the built-in browser: which BetterWright profile
// a bot lands in (its own session, a shared named one, or the throwaway
// guest), that adapters reach the profile's one worker through the bridge and
// forwarder, and that erasing a profile can only ever delete inside
// BetterWright's own profiles folder.
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterAll, describe, expect, it } from "vitest";

import { removeTempDir } from "./testing/cleanup.ts";
import { DATA_DIR } from "./config.ts";
import { SPAWNED_PROXIES } from "./proxy-paths.ts";
import {
  betterwrightCliPath,
  browserIntegrationSpec,
  browserLiveViewUrl,
  browserPartitionBeingErased,
  browserProfileName,
  closeBrowserWorkers,
  createBrowserProvisioner,
  forgetBrowserProfile,
  proxyBrowserLiveViewPage,
  resumeBrowserProfileErasures,
  startBrowserBridge,
} from "./betterwright.ts";

const temporaryHomes: string[] = [];

function betterwrightHome(): string {
  const home = mkdtempSync(join(tmpdir(), "omb-betterwright-"));
  temporaryHomes.push(home);
  return home;
}

/** A stand-in `betterwright mcp`: a real stdio MCP server, hand-rolled so the
 * stub keeps working from a temp dir where npm packages don't resolve. Its
 * browser_handoff answers like the real one, with the URL the test plants. */
function stubMcpCli(viewerUrl: string): string {
  const stub = join(betterwrightHome(), "stub-mcp.js");
  writeFileSync(
    stub,
    `let buf = "";
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let newline;
  while ((newline = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, newline);
    buf = buf.slice(newline + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      reply(message.id, {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "stub-betterwright", version: "0.0.0" },
      });
    } else if (message.method === "tools/list") {
      reply(message.id, { tools: [
        { name: "browser", description: "stub", inputSchema: { type: "object" } },
        { name: "browser_handoff", description: "stub", inputSchema: { type: "object" } },
      ] });
    } else if (message.method === "tools/call") {
      const text = message.params.name === "browser_handoff"
        ? "Live view started: ${viewerUrl}"
        : JSON.stringify({ echoed: message.params.arguments ?? {} });
      reply(message.id, { content: [{ type: "text", text }] });
    } else if (message.id !== undefined) {
      reply(message.id, {});
    }
  }
});
`,
  );
  return stub;
}

afterAll(async () => {
  closeBrowserWorkers();
  for (const home of temporaryHomes) await removeTempDir(home);
});

describe("built-in browser profiles", () => {
  const cfg = {
    browserProfiles: [
      { id: "work", name: "Work" },
      { id: "shop", name: "Shop", partitionId: "Shop-2" },
    ],
  };

  it("gives a bot with no chosen profile its own session", () => {
    expect(browserProfileName("b1", undefined, cfg)).toBe("bot-b1");
    expect(browserProfileName("b1", "", cfg)).toBe("bot-b1");
  });

  it("routes a named profile to its durable partition, not its config id", () => {
    expect(browserProfileName("b1", "work", cfg)).toBe("work");
    expect(browserProfileName("b1", "shop", cfg)).toBe("Shop-2");
  });

  it("keeps guest a throwaway shared with nobody's account", () => {
    expect(browserProfileName("b1", "guest", cfg)).toBe("guest");
  });

  it("falls back to the bot's own session when the profile was deleted", () => {
    expect(browserProfileName("b1", "gone", cfg)).toBe("bot-b1");
    expect(browserProfileName("b1", "work", { browserProfiles: [] })).toBe("bot-b1");
  });
});

describe("built-in browser integration", () => {
  it("mounts the bridge forwarder, not a second profile-owning worker", async () => {
    expect(betterwrightCliPath()).toMatch(/betterwright\.js$/);
    // No bridge, no browser: the spec must vanish rather than point nowhere.
    closeBrowserWorkers();
    expect(browserIntegrationSpec("bot-b1")).toBeNull();
    const socket = await startBrowserBridge(null, [join(betterwrightHome(), "bridge.sock")]);
    expect(socket).toBeTruthy();
    try {
      expect(browserIntegrationSpec("bot-b1")).toEqual({
        command: process.execPath,
        args: [SPAWNED_PROXIES.browser, socket, "bot-b1"],
        env: { ELECTRON_RUN_AS_NODE: "1" },
      });
    } finally {
      closeBrowserWorkers();
    }
  });

  it("relays an adapter's MCP session to the profile worker end to end", async () => {
    closeBrowserWorkers();
    const cli = stubMcpCli("http://127.0.0.1:1/?t=unused");
    const socket = await startBrowserBridge(cli, [join(betterwrightHome(), "bridge-e2e.sock")]);
    expect(socket).toBeTruthy();
    const client = new Client({ name: "adapter-stand-in", version: "0" });
    try {
      // the exact process an adapter spawns from the integration spec
      await client.connect(
        new StdioClientTransport({
          command: process.execPath,
          args: [SPAWNED_PROXIES.browser, socket ?? "", "p-bridge"],
        }),
      );
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toContain("browser_handoff");
      const result = (await client.callTool({ name: "browser", arguments: { code: "1" } })) as {
        content: Array<{ type: string; text: string }>;
      };
      expect(result.content[0].text).toBe(JSON.stringify({ echoed: { code: "1" } }));
    } finally {
      await client.close().catch(() => {});
      closeBrowserWorkers();
    }
  });
});

describe("provisioning the managed browser", () => {
  // The suite-wide OMB_BETTERWRIGHT_PROVISION=off guard exists for harness
  // boots with the real runner; these tests inject fakes, so lift it.
  const withProvisioning = async (body: () => Promise<void>) => {
    const previous = process.env.OMB_BETTERWRIGHT_PROVISION;
    delete process.env.OMB_BETTERWRIGHT_PROVISION;
    try {
      await body();
    } finally {
      if (previous === undefined) delete process.env.OMB_BETTERWRIGHT_PROVISION;
      else process.env.OMB_BETTERWRIGHT_PROVISION = previous;
    }
  };

  it("does not run setup when the browser is already usable", () =>
    withProvisioning(async () => {
      const calls: string[][] = [];
      const provisioner = createBrowserProvisioner(async (args) => {
        calls.push(args);
        return { ok: true, stdout: "" };
      });
      await expect(provisioner.ensure()).resolves.toBe(true);
      expect(calls).toEqual([["mcp", "--check"]]);
    }));

  it("runs setup once on a clean machine and shares the attempt", () =>
    withProvisioning(async () => {
      const calls: string[][] = [];
      const provisioner = createBrowserProvisioner(async (args) => {
        calls.push(args);
        // first check fails (no browser); setup and the re-check succeed
        return { ok: !(args[1] === "--check" && calls.length === 1), stdout: "" };
      });
      const [first, second] = await Promise.all([provisioner.ensure(), provisioner.ensure()]);
      expect(first).toBe(true);
      expect(second).toBe(true);
      expect(calls).toEqual([["mcp", "--check"], ["setup"], ["mcp", "--check"]]);
      // a settled success is cached — no further processes
      await expect(provisioner.ensure()).resolves.toBe(true);
      expect(calls.length).toBe(3);
    }));

  it("retries a failed attempt instead of caching it", () =>
    withProvisioning(async () => {
      let attempts = 0;
      const provisioner = createBrowserProvisioner(async (args) => {
        if (args[0] === "setup") attempts += 1;
        // setup keeps failing (offline); the second attempt succeeds
        return { ok: attempts >= 2, stdout: "" };
      });
      await expect(provisioner.ensure()).resolves.toBe(false);
      await expect(provisioner.ensure()).resolves.toBe(true);
      expect(attempts).toBe(2);
    }));

  it("stays inert while the test-suite guard is set", async () => {
    process.env.OMB_BETTERWRIGHT_PROVISION = "off";
    const provisioner = createBrowserProvisioner(async () => {
      throw new Error("must not spawn");
    });
    await expect(provisioner.ensure()).resolves.toBe(false);
  });
});

describe("browser live view", () => {
  it("starts the view inside the profile worker and hands out its URL", async () => {
    const cli = stubMcpCli("http://127.0.0.1:1/?t=stub");
    try {
      const first = await browserLiveViewUrl("p1", cli);
      expect(first).toBe("http://127.0.0.1:1/?t=stub");
      // a second ask reuses the running view instead of stacking viewers
      await expect(browserLiveViewUrl("p1", cli)).resolves.toBe(first);
    } finally {
      closeBrowserWorkers();
    }
  });

  it("refuses an invalid profile name and a missing CLI", async () => {
    await expect(browserLiveViewUrl("../escape", "/unused")).resolves.toBeNull();
    await expect(browserLiveViewUrl("p2", null)).resolves.toBeNull();
  });

  it("re-serves the viewer page same-origin, tokenized, without its frame ban", async () => {
    // a stand-in for the viewer the worker serves from inside itself
    const viewer = createServer((req, res) => {
      if (new URL(req.url ?? "/", "http://placeholder").searchParams.get("t") !== "tok") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/html", "x-frame-options": "DENY" });
      res.end("<html>viewer</html>");
    });
    await new Promise<void>((ready) => viewer.listen(0, "127.0.0.1", ready));
    const viewerPort = (viewer.address() as AddressInfo).port;
    const cli = stubMcpCli(`http://127.0.0.1:${viewerPort}/?t=tok`);
    const front = createServer((req, res) => void proxyBrowserLiveViewPage("p-embed", req, res, cli));
    await new Promise<void>((ready) => front.listen(0, "127.0.0.1", ready));
    const frontPort = (front.address() as AddressInfo).port;
    try {
      // the page reads its token from location.search, so the iframe is sent
      // back around carrying it
      const redirect = await fetch(`http://127.0.0.1:${frontPort}/embed`, { redirect: "manual" });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get("location")).toBe("/embed?t=tok");
      const page = await fetch(`http://127.0.0.1:${frontPort}/embed?t=tok`);
      expect(page.status).toBe(200);
      expect(page.headers.get("x-frame-options")).toBeNull();
      expect(await page.text()).toBe("<html>viewer</html>");
    } finally {
      closeBrowserWorkers();
      viewer.close();
      front.close();
    }
  });
});

describe("forgetting a browser profile", () => {
  it("erases the profile directory and nothing above it", async () => {
    const home = betterwrightHome();
    const profiles = join(home, "browser", "profiles");
    mkdirSync(join(profiles, "bot-b1"), { recursive: true });
    writeFileSync(join(profiles, "bot-b1", "Cookies"), "session");
    mkdirSync(join(profiles, "bot-b1.betterwright-lock"), { recursive: true });
    const previousHome = process.env.BETTERWRIGHT_HOME;
    process.env.BETTERWRIGHT_HOME = home;
    try {
      await forgetBrowserProfile("bot-b1", [0]);
      expect(existsSync(join(profiles, "bot-b1"))).toBe(false);
      expect(existsSync(join(profiles, "bot-b1.betterwright-lock"))).toBe(false);
      expect(existsSync(profiles)).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.BETTERWRIGHT_HOME;
      else process.env.BETTERWRIGHT_HOME = previousHome;
    }
  });

  it("stops retrying once the erased state stays gone", async () => {
    const home = betterwrightHome();
    const profiles = join(home, "browser", "profiles");
    mkdirSync(join(profiles, "bot-b2"), { recursive: true });
    const previousHome = process.env.BETTERWRIGHT_HOME;
    process.env.BETTERWRIGHT_HOME = home;
    try {
      // A later pass whose delay never elapsed would hang this test; the
      // stability check must return right after the first clean re-check.
      await forgetBrowserProfile("bot-b2", [0, 0, 60_000]);
      expect(existsSync(join(profiles, "bot-b2"))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.BETTERWRIGHT_HOME;
      else process.env.BETTERWRIGHT_HOME = previousHome;
    }
  });

  it("blocks partition reuse until the erase ladder settles, then clears the journal", async () => {
    const home = betterwrightHome();
    const profiles = join(home, "browser", "profiles");
    mkdirSync(join(profiles, "Shop-2"), { recursive: true });
    const previousHome = process.env.BETTERWRIGHT_HOME;
    process.env.BETTERWRIGHT_HOME = home;
    try {
      const done = forgetBrowserProfile("Shop-2", [0, 300]);
      // registration happens before the first await, and folds case — the
      // config guard compares partition ids that never normalize case
      expect(browserPartitionBeingErased("shop-2")).toBe(true);
      expect(browserPartitionBeingErased("Shop-2")).toBe(true);
      await done;
      expect(browserPartitionBeingErased("Shop-2")).toBe(false);
      expect(existsSync(join(DATA_DIR, "browser-erase-journal.json"))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.BETTERWRIGHT_HOME;
      else process.env.BETTERWRIGHT_HOME = previousHome;
    }
  });

  it("returns without the ladder when no profile state exists", async () => {
    const home = betterwrightHome();
    mkdirSync(join(home, "browser", "profiles"), { recursive: true });
    const previousHome = process.env.BETTERWRIGHT_HOME;
    process.env.BETTERWRIGHT_HOME = home;
    try {
      // a 60s ladder entry would blow the test timeout if it ran
      await forgetBrowserProfile("bot-never-existed", [0, 60_000]);
      expect(browserPartitionBeingErased("bot-never-existed")).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.BETTERWRIGHT_HOME;
      else process.env.BETTERWRIGHT_HOME = previousHome;
    }
  });

  it("never blocks the guest throwaway on its boot wipe", async () => {
    const home = betterwrightHome();
    const profiles = join(home, "browser", "profiles");
    mkdirSync(join(profiles, "guest"), { recursive: true });
    const previousHome = process.env.BETTERWRIGHT_HOME;
    process.env.BETTERWRIGHT_HOME = home;
    try {
      const done = forgetBrowserProfile("guest", [0]);
      expect(browserPartitionBeingErased("guest")).toBe(false);
      await done;
      expect(existsSync(join(profiles, "guest"))).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.BETTERWRIGHT_HOME;
      else process.env.BETTERWRIGHT_HOME = previousHome;
    }
  });

  it("resumes a journaled erase that a shutdown interrupted", async () => {
    const home = betterwrightHome();
    const profiles = join(home, "browser", "profiles");
    mkdirSync(join(profiles, "bot-crashed"), { recursive: true });
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(join(DATA_DIR, "browser-erase-journal.json"), JSON.stringify({ profiles: ["bot-crashed"] }));
    const previousHome = process.env.BETTERWRIGHT_HOME;
    process.env.BETTERWRIGHT_HOME = home;
    try {
      resumeBrowserProfileErasures([0]);
      for (let waited = 0; waited < 5_000 && existsSync(join(profiles, "bot-crashed")); waited += 100) {
        await new Promise((tick) => setTimeout(tick, 100));
      }
      expect(existsSync(join(profiles, "bot-crashed"))).toBe(false);
      for (let waited = 0; waited < 2_000 && browserPartitionBeingErased("bot-crashed"); waited += 100) {
        await new Promise((tick) => setTimeout(tick, 100));
      }
      expect(browserPartitionBeingErased("bot-crashed")).toBe(false);
    } finally {
      if (previousHome === undefined) delete process.env.BETTERWRIGHT_HOME;
      else process.env.BETTERWRIGHT_HOME = previousHome;
    }
  });

  it("refuses a name that would escape the profiles directory", async () => {
    const home = betterwrightHome();
    const profiles = join(home, "browser", "profiles");
    const sibling = join(home, "browser", "keep");
    mkdirSync(profiles, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    const previousHome = process.env.BETTERWRIGHT_HOME;
    process.env.BETTERWRIGHT_HOME = home;
    try {
      await forgetBrowserProfile("../keep", [0]);
      await forgetBrowserProfile("..", [0]);
      expect(existsSync(sibling)).toBe(true);
      expect(existsSync(profiles)).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.BETTERWRIGHT_HOME;
      else process.env.BETTERWRIGHT_HOME = previousHome;
    }
  });
});
