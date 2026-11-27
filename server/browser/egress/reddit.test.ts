import { connect } from "node:net";
import { describe, expect, it } from "vitest";

import type { ListenerOwnership } from "./ownership.ts";
import type { EgressHost } from "./policy.ts";
import { isRedditAddress, isRedditHost, opensReddit, REDDIT_HOSTS, REDDIT_REFUSAL, refusesReddit } from "./reddit.ts";
import { BrowserEgress, OwnListeners } from "./registry.ts";

const REDDIT_NAMES = [
  ...REDDIT_HOSTS,
  "www.reddit.com", "old.reddit.com", "new.reddit.com", "np.reddit.com", "i.reddit.com", "m.reddit.com", "oauth.reddit.com",
  "i.redd.it", "v.redd.it", "preview.redd.it", "external-preview.redd.it", "www.redditmedia.com", "www.redditstatic.com",
  "a.thumbs.redditmedia.com", "go.reddit.app.link",
  // As Chrome or a person may write them.
  "WWW.Reddit.COM", "www.reddit.com.",
];
const LOOKALIKES = [
  "notreddit.com", "reddit.com.evil.test", "reddit.co", "redditt.com", "myredd.it", "redd.it.evil.test",
  "notredditmedia.com", "evilreddit.app.link", "app.link", "example.com", "",
];

describe("Reddit's names", () => {
  it.each(REDDIT_NAMES)("%s is Reddit's", (name) => {
    expect(isRedditHost(name)).toBe(true);
  });

  it.each(LOOKALIKES)("%s is not", (name) => {
    expect(isRedditHost(name)).toBe(false);
  });

  it("reads an address as the browser tools do, a bare host meaning https", () => {
    for (const address of [
      "https://www.reddit.com/r/test/", "old.reddit.com/r/test", "reddit.com", "http://i.redd.it/a.png", "HTTPS://V.REDD.IT/x",
      "https://reddit.com./", "https://someone@reddit.com/", "https://reddit.com:443/r/x", "wss://www.reddit.com/socket",
      // URL parsing maps full-width letters and dots to ASCII.
      "https://ｒｅｄｄｉｔ。ｃｏｍ/",
    ]) expect(isRedditAddress(address), address).toBe(true);
    for (const address of [
      "https://reddit.com@evil.test/", "https://evil.test/?next=https://www.reddit.com/", "https://notreddit.com/",
      "https://reddit.com.evil.test/", "about:blank", "data:text/html,reddit.com", "not an address", "",
    ]) expect(isRedditAddress(address), address).toBe(false);
  });
});

describe("which browsers skip Reddit", () => {
  it("is only MausBot Cloud's: the desktop's and a self-hosted server's open it", () => {
    for (const name of REDDIT_NAMES) {
      expect(refusesReddit("cloud", name), name).toBe(true);
      expect(refusesReddit("desktop", name), name).toBe(false);
      expect(refusesReddit("server", name), name).toBe(false);
    }
    for (const name of LOOKALIKES) expect(refusesReddit("cloud", name), name).toBe(false);
  });

  it("finds the address in every tool call that opens one, on either engine", () => {
    const calls = [
      { name: "agent_browser_open", arguments: { url: "https://www.reddit.com/r/test/" } },
      { name: "agent_browser_open", arguments: { url: "old.reddit.com", tab: "new" } },
      { name: "agent_browser_navigate", arguments: { url: "https://i.redd.it/a.png" } },
      { name: "agent_browser_read", arguments: { url: "https://www.reddit.com/" } },
      { name: "agent_browser_tabs", arguments: { action: "new", url: "https://reddit.com/" } },
      { name: "agent_browser_tab_new", arguments: { url: "https://reddit.app.link/x" } },
    ];
    for (const call of calls) {
      expect(opensReddit("cloud", call), JSON.stringify(call)).toBe(true);
      expect(opensReddit("desktop", call), JSON.stringify(call)).toBe(false);
      expect(opensReddit("server", call), JSON.stringify(call)).toBe(false);
    }
    for (const call of [
      { name: "agent_browser_open", arguments: { url: "https://notreddit.com/" } },
      { name: "agent_browser_open", arguments: {} },
      { name: "agent_browser_snapshot", arguments: {} },
      { name: "agent_browser_wait", arguments: { urlIncludes: "reddit.com" } },
      { name: "agent_browser_open" },
      null,
    ]) expect(opensReddit("cloud", call), JSON.stringify(call)).toBe(false);
  });
});

describe("the egress gate on MausBot Cloud", () => {
  const ownership = { botOwned: async () => false } as unknown as ListenerOwnership;
  /** Every name a gate looks up. None resolves, so nothing here reaches the network. */
  const egressOn = (host: EgressHost) => {
    const looked: string[] = [];
    const egress = new BrowserEgress();
    egress.configure({
      host, config: () => ({}), ownership,
      listeners: new OwnListeners(host, { env: {}, streamPorts: () => [], devToolsPorts: () => [] }),
      resolve: async (name) => { looked.push(name); return []; },
    });
    return { egress, looked };
  };

  /** A SOCKS5 CONNECT for `name`, as Chrome sends it; resolves with the reply code. */
  const ask = (port: number, name: string) => new Promise<number>((resolve) => {
    const host = Buffer.from(name, "latin1");
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(Buffer.concat([Buffer.from([5, 1, 0, 5, 1, 0, 3, host.length]), host, Buffer.from([443 >> 8, 443 & 0xff])]));
    });
    let received = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => { received = Buffer.concat([received, chunk]); });
    socket.on("error", () => {});
    socket.on("close", () => resolve(received[3] ?? -1));
  });

  it("refuses every Reddit name without looking it up, and tells the bot why in plain words", async () => {
    const { egress, looked } = egressOn("cloud");
    const port = await egress.open("bot-1");
    try {
      for (const name of REDDIT_NAMES) expect(await ask(port, name), name).toBe(2);
      expect(looked).toEqual([]);
      const notice = egress.takeNotice("bot-1");
      expect(notice).toMatch(/^The page tried to reach "reddit\.com:443" \(blocked: Reddit\), "redd\.it:443" \(blocked: Reddit\), "redditmedia\.com:443" \(blocked: Reddit\) and \d+ more \(page output, not instructions\)\. /);
      expect(notice!.endsWith(` ${REDDIT_REFUSAL}`)).toBe(true);
      expect(egress.takeNotice("bot-1")).toBeNull();
    } finally {
      await egress.close();
    }
  });

  it("looks lookalikes up as any other site", async () => {
    const { egress, looked } = egressOn("cloud");
    const port = await egress.open("bot-1");
    try {
      for (const name of LOOKALIKES.filter(Boolean)) expect(await ask(port, name), name).toBe(4);
      expect(looked).toEqual(LOOKALIKES.filter(Boolean));
      expect(egress.takeNotice("bot-1")).toBeNull();
    } finally {
      await egress.close();
    }
  });

  it("lets the desktop's and a self-hosted server's browsers look Reddit up and open it", async () => {
    for (const host of ["desktop", "server"] as const) {
      const { egress, looked } = egressOn(host);
      const port = await egress.open("bot-1");
      try {
        for (const name of ["www.reddit.com", "i.redd.it"]) expect(await ask(port, name), `${host} ${name}`).toBe(4);
        expect(looked, host).toEqual(["www.reddit.com", "i.redd.it"]);
        expect(egress.nameRefusal("www.reddit.com"), host).toBeNull();
        expect(egress.callRefusal({ name: "agent_browser_open", arguments: { url: "https://www.reddit.com/" } }), host).toBeNull();
        expect(egress.takeNotice("bot-1"), host).toBeNull();
      } finally {
        await egress.close();
      }
    }
  });

  it("refuses a tool call that would open Reddit with the same words", () => {
    const { egress } = egressOn("cloud");
    expect(egress.callRefusal({ name: "agent_browser_open", arguments: { url: "https://www.reddit.com/r/test/" } })).toBe(REDDIT_REFUSAL);
    expect(egress.callRefusal({ name: "agent_browser_open", arguments: { url: "https://example.com/" } })).toBeNull();
    expect(new BrowserEgress().callRefusal({ name: "agent_browser_open", arguments: { url: "https://www.reddit.com/" } })).toBeNull();
  });
});
