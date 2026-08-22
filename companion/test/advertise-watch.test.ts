// The re-advertise contract. What matters is *when* the watcher moves — on a
// change to the address set and never otherwise — because every advertise is
// a socket rebind plus a network-wide announcement, and every missed one is a
// phone holding stale A records. No sockets here: the watcher takes its
// addresses and its two moves as functions, and these tests hand it fakes.
import { describe, expect, it } from "vitest";

import { createAddressWatcher, type AddressWatchOptions } from "../src/advertise-watch.ts";

function rig(initial: string[], overrides: Partial<AddressWatchOptions> = {}) {
  let addresses = initial;
  const calls: string[] = [];
  const logs: string[] = [];
  const watcher = createAddressWatcher({
    addresses: () => addresses,
    advertise: async () => {
      calls.push(`advertise ${[...addresses].sort().join(",")}`);
      return true;
    },
    withdraw: async () => {
      calls.push("withdraw");
    },
    log: (line) => logs.push(line),
    ...overrides,
  });
  return {
    watcher,
    calls,
    logs,
    set: (next: string[]) => {
      addresses = next;
    },
  };
}

describe("address watcher", () => {
  it("advertises when the network appears after startup", async () => {
    const { watcher, calls, logs, set } = rig([]);
    await watcher.check();
    // The original bug was silence here: no addresses meant no advertise and
    // no record of why. The first check must say so out loud.
    expect(calls).toEqual(["withdraw"]);
    expect(logs.join("\n")).toMatch(/no LAN addresses/);

    set(["192.168.1.42"]);
    await watcher.check();
    expect(calls).toEqual(["withdraw", "advertise 192.168.1.42"]);
  });

  it("does nothing while the address set holds still", async () => {
    const { watcher, calls } = rig(["192.168.1.42"]);
    await watcher.check();
    await watcher.check();
    await watcher.check();
    expect(calls).toEqual(["advertise 192.168.1.42"]);
  });

  it("re-advertises when DHCP moves the machine", async () => {
    const { watcher, calls, set } = rig(["192.168.1.42"]);
    await watcher.check();
    set(["10.0.0.7"]);
    await watcher.check();
    expect(calls).toEqual(["advertise 192.168.1.42", "advertise 10.0.0.7"]);
  });

  it("treats a reordered address list as unchanged", async () => {
    const { watcher, calls, set } = rig(["10.0.0.7", "192.168.1.42"]);
    await watcher.check();
    set(["192.168.1.42", "10.0.0.7"]);
    await watcher.check();
    expect(calls).toHaveLength(1);
  });

  it("withdraws when the last address disappears, and comes back with it", async () => {
    const { watcher, calls, set } = rig(["192.168.1.42"]);
    await watcher.check();
    set([]);
    await watcher.check();
    // withdrawn, not left rotting in caches pointing at a dead address
    expect(calls).toEqual(["advertise 192.168.1.42", "withdraw"]);
    set(["192.168.1.42"]);
    await watcher.check();
    expect(calls).toEqual(["advertise 192.168.1.42", "withdraw", "advertise 192.168.1.42"]);
  });

  it("does not retry a failed advertise until the network changes", async () => {
    const { watcher, calls, logs, set } = rig(["192.168.1.42"], {
      advertise: async () => {
        calls.push("advertise");
        return false;
      },
    });
    await watcher.check();
    await watcher.check();
    // Port 5353 busy is tied to this network state — one attempt per state,
    // or the log repeats the same sentence every five seconds forever.
    expect(calls).toEqual(["advertise"]);
    expect(logs.join("\n")).toMatch(/could not advertise/);
    set(["10.0.0.7"]);
    await watcher.check();
    expect(calls).toEqual(["advertise", "advertise"]);
  });

  it("survives an advertise that throws, and tries again next tick", async () => {
    let attempts = 0;
    const { watcher, calls, logs } = rig(["192.168.1.42"], {
      advertise: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("label longer than 63 bytes");
        calls.push("advertise");
        return true;
      },
    });
    await watcher.check();
    expect(logs.join("\n")).toMatch(/label longer than 63 bytes/);
    // a throw is not recorded as acted-on, so the same set is retried
    await watcher.check();
    expect(calls).toEqual(["advertise"]);
  });

  it("never overlaps a check with one still in flight", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let advertises = 0;
    const { watcher } = rig(["192.168.1.42"], {
      advertise: async () => {
        advertises += 1;
        await gate;
        return true;
      },
    });
    const first = watcher.check();
    // lands while the first advertise is mid-rebind; must not fork a second
    const second = watcher.check();
    release();
    await Promise.all([first, second]);
    expect(advertises).toBe(1);
  });
});
