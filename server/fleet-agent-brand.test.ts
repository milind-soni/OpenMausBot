import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { startFleetAgent } from "./fleet-agent.ts";
import { fleetRequest } from "./fleet-client.ts";
import { defaultBrandPath, overrideBrandPath, workspaceBrandPath } from "./fleet-brand.ts";
import { fleetLayout } from "./fleet.ts";
import { removeTempDir } from "./testing/cleanup.ts";
import { dataUri, ICO, PNG, resellerRegistry, SVG, workspace } from "./testing/fleet-brand-fixtures.ts";
import { fleetMachine } from "./testing/fleet-machine.ts";

describe.skipIf(process.platform === "win32")("fleet agent brand routes over their socket", () => {
  let root: string;
  let socketPath: string;
  let auditFile: string;
  let stop: (() => Promise<void>) | null = null;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "omb-fleet-brand-"));
    socketPath = join(root, "fleet.sock");
    auditFile = join(root, "audit.jsonl");
  });

  afterEach(async () => {
    await stop?.();
    stop = null;
    await removeTempDir(root);
  });

  async function boot(registry = resellerRegistry([workspace("acme"), workspace("beta", "retained", 1)])) {
    const layout = fleetLayout(root);
    const machine = fleetMachine(root);
    machine.files.set(layout.registryFile, JSON.stringify(registry));
    const server = await startFleetAgent({ socketPath, node: "/usr/bin/node", script: "/usr/lib/node_modules/openmausbot/cli.js", root, deps: machine.deps, auditFile, now: () => new Date("2026-09-10T12:00:00Z") }, { log: () => {} });
    stop = () => new Promise((resolve) => server.close(() => resolve()));
    return { layout, machine };
  }

  const audit = () => readFileSync(auditFile, "utf8");

  it("saves the default and a workspace override from data URIs, and the next read of the merged file shows them", async () => {
    const { layout, machine } = await boot();
    const logo = dataUri("image/png", PNG);
    const saved = await fleetRequest(socketPath, "PUT", "/brand", { name: "Acme Assistant", accent: "#C2510A", logo, favicon: dataUri("image/x-icon", ICO) });
    expect(saved.status).toBe(200);
    expect(JSON.parse(machine.files.get(defaultBrandPath(layout))!)).toMatchObject({ name: "Acme Assistant", logo });
    expect(JSON.parse(machine.files.get(workspaceBrandPath(layout, "acme"))!)).toMatchObject({ name: "Acme Assistant", logo });
    expect(machine.files.has(workspaceBrandPath(layout, "beta"))).toBe(false);

    const own = await fleetRequest(socketPath, "POST", "/workspaces/acme/brand", { name: "Blue Team", accent: "#112233" });
    expect(own.status).toBe(200);
    expect(JSON.parse(machine.files.get(overrideBrandPath(layout, "acme"))!)).toEqual({ name: "Blue Team", accent: "#112233" });
    expect(JSON.parse(machine.files.get(workspaceBrandPath(layout, "acme"))!)).toMatchObject({ name: "Blue Team", accent: "#112233", logo });
    expect((await fleetRequest(socketPath, "POST", "/workspaces/acme/brand", { clear: ["accent"] })).status).toBe(200);
    expect(JSON.parse(machine.files.get(workspaceBrandPath(layout, "acme"))!).accent).toBe("#C2510A");
  });

  it("answers 400 for a bad accent, a hostile image, a path, an address and an unknown field, and writes nothing", async () => {
    const { machine } = await boot();
    const before = new Map(machine.files);
    const hostile = dataUri("image/svg+xml", Uint8Array.from(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')));
    const lying = dataUri("image/png", SVG);
    const attempts: [string, Record<string, unknown>, string][] = [
      ["PUT", { accent: "blue" }, "accent must be a 6-digit hex colour"],
      ["PUT", { supportUrl: "http://help.acme.test" }, "supportUrl must be an https:// URL"],
      ["PUT", { logo: hostile }, "<script"],
      ["PUT", { logo: lying }, "says image/png"],
      ["PUT", { logo: "/etc/passwd" }, "inline data:image/"],
      ["PUT", { logo: "https://cdn.acme.test/logo.png" }, "inline data:image/"],
      ["PUT", { favicon: dataUri("image/png", Uint8Array.from(Buffer.from("<html>"))) }, "not a PNG"],
      ["PUT", { colour: "red" }, 'unknown brand field "colour"'],
      ["PUT", { clear: ["colour"] }, "clear must list"],
      ["PUT", { name: 7 }, "name must be a string"],
    ];
    for (const [method, body, message] of attempts) {
      const reply = await fleetRequest(socketPath, method, "/brand", body);
      expect(reply.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect((reply.body as { error: string }).error).toContain(message);
    }
    expect((await fleetRequest(socketPath, "POST", "/workspaces/beta/brand", { name: "X" })).status).toBe(400);
    expect((await fleetRequest(socketPath, "POST", "/workspaces/ghost/brand", { name: "X" })).status).toBe(400);
    expect(machine.files).toEqual(before);
  });

  it("accepts a brand body up to the larger limit and refuses beyond it", async () => {
    await boot();
    const big = dataUri("image/png", Uint8Array.from([...PNG, ...new Uint8Array(200_000)]));
    expect(big.length).toBeGreaterThan(256 * 1024);
    expect((await fleetRequest(socketPath, "PUT", "/brand", { logo: big })).status).toBe(200);
    expect((await fleetRequest(socketPath, "PUT", "/brand", { tagline: "x".repeat(600 * 1024) })).status).toBe(413);
  });

  it("audits which fields changed and never an image", async () => {
    await boot();
    const logo = dataUri("image/png", PNG);
    await fleetRequest(socketPath, "PUT", "/brand", { name: "Acme Assistant", logo, clear: ["tagline"] });
    await fleetRequest(socketPath, "PUT", "/brand", { accent: "blue", logo });
    const lines = audit().trim().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ action: "brand", ok: true, brand: ["name", "logo", "-tagline"] });
    expect(lines[1]).toMatchObject({ action: "brand", ok: false });
    expect(audit()).not.toContain(Buffer.from(PNG).toString("base64"));
    expect(audit()).not.toContain("data:image");
  });

  it("lists workspaces with their brand but without logos or favicons", async () => {
    await boot();
    const logo = dataUri("image/png", PNG);
    await fleetRequest(socketPath, "PUT", "/brand", { name: "Acme Assistant", tagline: "Ask us", logo, favicon: dataUri("image/x-icon", ICO) });
    const reply = await fleetRequest(socketPath, "GET", "/workspaces");
    expect(reply.status).toBe(200);
    const acme = (reply.body as { workspaces: { slug: string; brand?: Record<string, unknown> }[] }).workspaces.find((entry) => entry.slug === "acme")!;
    expect(acme.brand).toEqual({ name: "Acme Assistant", tagline: "Ask us" });
    const text = JSON.stringify(reply.body);
    expect(text).not.toContain("data:image");
    expect(text).not.toContain(Buffer.from(PNG).toString("base64"));
    const beta = (reply.body as { workspaces: { slug: string; brand?: unknown }[] }).workspaces.find((entry) => entry.slug === "beta")!;
    expect(beta).not.toHaveProperty("brand");
  });
});
