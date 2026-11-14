import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { FIXTURE_STARTER_BOT_NAME, launchVerificationServer } from "../scripts/control-omb.ts";

it("pins the fixture starter bot's name deterministically (#1257)", async () => {
  // The first-run seed draws a random name from server/names.ts, which includes "Quill": both launches must see the pinned name.
  for (let launch = 0; launch < 2; launch++) {
    const fixture = await launchVerificationServer({});
    try {
      const response = await fetch(fixture.info.url + "/api/bots", {
        headers: { origin: fixture.info.url },
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.ok).toBe(true);
      const bots = ((await response.json()) as { bots: Array<{ name: string }> }).bots;
      expect(bots).toHaveLength(1);
      expect(bots[0].name).toBe(FIXTURE_STARTER_BOT_NAME);
    } finally {
      await fixture.close();
    }
  }
});

/** Installed outside anything the fixture is granted (node's own directory is its whole PATH). */
function machineInstalledCli(): string | undefined {
  const granted = dirname(process.execPath);
  for (const dir of ["/opt/homebrew/bin", "/usr/local/bin"]) {
    if (dir === granted || !existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (!/^[\w.-]+$/.test(name) || existsSync(join(granted, name))) continue;
      try {
        const stat = statSync(join(dir, name));
        if (stat.isFile() && stat.mode & 0o111) return name;
      } catch {}
    }
  }
  return undefined;
}

it("keeps the fixture blind to this machine's installed CLIs (#2035)", async () => {
  const cli = machineInstalledCli();
  const fixture = await launchVerificationServer({});
  try {
    const get = async (path: string) => {
      const response = await fetch(fixture.info.url + path, {
        headers: { origin: fixture.info.url },
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.ok).toBe(true);
      return response.json() as Promise<Record<string, any>>;
    };
    const { instances } = await get("/api/instances") as { instances: Array<{ instanceId: string; snapshot: { state: string } }> };
    expect(instances.find((instance) => instance.instanceId === "chatgpt")?.snapshot.state).toBe("unavailable");
    expect(instances.filter((instance) => instance.snapshot.state === "available").map((instance) => instance.instanceId))
      .toEqual(["claude"]);
    if (cli) {
      // Each lookup restarts the login-shell PATH probe, whose result lands a moment later: ask again after it would have.
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt) await new Promise((resolve) => setTimeout(resolve, 500));
        expect((await get(`/api/cli-candidates?name=${encodeURIComponent(cli)}`)).candidates).toEqual([]);
      }
    }
  } finally {
    await fixture.close();
  }
});
