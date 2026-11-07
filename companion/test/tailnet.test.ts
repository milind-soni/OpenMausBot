import { afterEach, describe, expect, it } from "vitest";

import { forgetTailnetName } from "../src/listener.ts";
import { createTailnet, serveOwner, TAILNET_HTTPS_PORT, type TailscaleRunner } from "../src/tailnet.ts";

const NAME = "laptop.tail1234.ts.net";
const OURS = "http://127.0.0.1:8810";

/** A fake Tailscale CLI with its own serve configuration; `name: null` plays one that is not installed or signed in. */
function fakeTailscale({ name = NAME as string | null, serveStatus = "{}", serveOk = true } = {}) {
  const calls: string[][] = [];
  let status = serveStatus;
  const run: TailscaleRunner = async (cli, args) => {
    calls.push([cli, ...args]);
    if (args[0] === "serve" && args[1] === "status") return { ok: true, stdout: status };
    if (args[0] === "serve" && args.includes("off")) {
      status = "{}";
      return { ok: true, stdout: "" };
    }
    if (args[0] === "serve" && serveOk) {
      status = JSON.stringify({ TCP: { [TAILNET_HTTPS_PORT]: { HTTPS: true } }, Web: { [`${NAME}:${TAILNET_HTTPS_PORT}`]: { Handlers: { "/": { Proxy: OURS } } } } });
      return { ok: true, stdout: "" };
    }
    return { ok: false, stdout: "" };
  };
  const lookup = async () => {
    calls.push(["status"]);
    return name ? { name, cli: "/usr/bin/tailscale" } : null;
  };
  return { calls, tailnet: (extra = {}) => createTailnet({ companionPort: 8810, run, lookup, forget: () => {}, ...extra }) };
}

afterEach(() => forgetTailnetName());

describe("serveOwner", () => {
  it("tells our handler from the person's own and from none", () => {
    expect(serveOwner("{}", NAME, 8813, OURS)).toBe("none");
    const ours = JSON.stringify({ TCP: { 8813: { HTTPS: true } }, Web: { [`${NAME}:8813`]: { Handlers: { "/": { Proxy: OURS } } } } });
    expect(serveOwner(ours, NAME, 8813, OURS)).toBe("ours");
    const theirs = JSON.stringify({ TCP: { 8813: { HTTPS: true } }, Web: { [`${NAME}:8813`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } });
    expect(serveOwner(theirs, NAME, 8813, OURS)).toBe("theirs");
    expect(serveOwner(JSON.stringify({ TCP: { 8813: { TCPForward: "127.0.0.1:22" } } }), NAME, 8813, OURS)).toBe("theirs");
    expect(serveOwner("not json", NAME, 8813, OURS)).toBe("theirs");
    expect(serveOwner(JSON.stringify({ TCP: { 443: { HTTPS: true } } }), NAME, 8813, OURS)).toBe("none");
  });
});

describe("the phone link's Tailscale switch", () => {
  it("runs nothing while off", () => {
    const fake = fakeTailscale();
    expect(fake.tailnet().state()).toEqual({ on: false, httpsOrigin: null, problem: null });
    expect(fake.calls).toEqual([]);
  });

  it("on: serves the phone link at an HTTPS address on the tailnet", async () => {
    const fake = fakeTailscale();
    expect(await fake.tailnet().on()).toEqual({ on: true, httpsOrigin: `https://${NAME}:8813`, problem: null });
    expect(fake.calls).toContainEqual(["/usr/bin/tailscale", "serve", "--bg", "--https=8813", OURS]);
  });

  it("on again: keeps its own handler rather than adding a second", async () => {
    const fake = fakeTailscale();
    const tailnet = fake.tailnet();
    await tailnet.on();
    await tailnet.on();
    expect(fake.calls.filter((call) => call.includes("--bg"))).toHaveLength(1);
  });

  it("off: removes only the handler it created", async () => {
    const fake = fakeTailscale();
    const tailnet = fake.tailnet();
    await tailnet.on();
    fake.calls.length = 0;
    expect(await tailnet.off()).toEqual({ on: false, httpsOrigin: null, problem: null });
    expect(fake.calls).toContainEqual(["/usr/bin/tailscale", "serve", "--https=8813", "off"]);
  });

  it("never touches a port the person serves something else on", async () => {
    const theirs = JSON.stringify({ TCP: { 8813: { HTTPS: true } }, Web: { [`${NAME}:8813`]: { Handlers: { "/": { Proxy: "http://127.0.0.1:3000" } } } } });
    const fake = fakeTailscale({ serveStatus: theirs });
    const tailnet = fake.tailnet();
    expect(await tailnet.on()).toEqual({ on: true, httpsOrigin: null, problem: "port-taken" });
    await tailnet.off();
    expect(fake.calls.filter((call) => call.includes("--bg") || call.includes("off"))).toEqual([]);
  });

  it("says what is missing when Tailscale is not found or refuses to serve", async () => {
    expect(await fakeTailscale({ name: null }).tailnet().on()).toEqual({ on: true, httpsOrigin: null, problem: "not-found" });
    expect(await fakeTailscale({ serveOk: false }).tailnet().on()).toEqual({ on: true, httpsOrigin: null, problem: "serve-refused" });
  });
});
