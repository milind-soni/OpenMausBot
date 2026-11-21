import { describe, expect, it } from "vitest";
import { createComputerBrowsingRoutes, siteOf } from "./computer-browsing.ts";
import { PASS } from "./table.ts";

const bots = [
  { id: "ada", browserProfile: undefined },
  { id: "ben", browserProfile: "shared" },
  { id: "cy" },
  { id: "dee", hidden: true },
  { id: "eve" },
];
const pages: Record<string, string> = {
  ada: "https://www.github.com/acme/private-repo?token=secret#readme",
  ben: "http://localhost:5199/settings",
  cy: "about:blank",
  dee: "https://example.com/",
  eve: "https://news.example.org/",
};

async function request(handler: ReturnType<typeof createComputerBrowsingRoutes>, path = "/api/computers/browsing", method = "GET") {
  let body: unknown;
  const result = await handler({
    res: { setHeader: () => {} }, url: new URL(`http://127.0.0.1${path}`), path, method,
    json: (_res: unknown, _status: number, value: unknown) => { body = value; },
  } as any);
  return { result, body };
}

describe("the site each working bot's browser is on", () => {
  it("keeps only a web page's host, never its path, query or a non-web page", () => {
    expect(siteOf("https://www.github.com/acme/private-repo?token=secret#readme")).toBe("github.com");
    expect(siteOf("http://localhost:5199/settings")).toBe("localhost");
    expect(siteOf("about:blank")).toBeNull();
    expect(siteOf("chrome://newtab/")).toBeNull();
    expect(siteOf("file:///home/me/notes.txt")).toBeNull();
    expect(siteOf("not a url")).toBeNull();
    expect(siteOf(null)).toBeNull();
  });

  it("lists working, shown bots with a web page in front, by host only", async () => {
    const handler = createComputerBrowsingRoutes({
      store: { bots } as any,
      botHasActiveTurn: (botId) => botId !== "eve",
      browserPageUrl: (bot) => pages[bot.id] ?? null,
    });
    const { body } = await request(handler);
    expect(body).toEqual({ bots: [{ botId: "ada", site: "github.com" }, { botId: "ben", site: "localhost" }] });
  });

  it("asks no browser of a bot that is not working, and passes other requests on", async () => {
    const asked: string[] = [];
    const handler = createComputerBrowsingRoutes({
      store: { bots } as any,
      botHasActiveTurn: () => false,
      browserPageUrl: (bot) => { asked.push(bot.id); return null; },
    });
    expect((await request(handler)).body).toEqual({ bots: [] });
    expect(asked).toEqual([]);
    expect((await request(handler, "/api/computers/frames")).result).toBe(PASS);
    expect((await request(handler, "/api/computers/browsing", "POST")).result).toBe(PASS);
  });
});
