// A loopback stand-in for the connected-apps service's catalog and connected list. It counts what reaches it and can hold,
// fail or drop a catalog page, so a test asserts on requests made and on whether a read waited, never on time.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface FakeCatalogService {
  url: string;
  /** Toolkits per page, in order. */
  pages: number[];
  /** Renames every toolkit, so the next walk brings a different list. */
  edition: number;
  requests: { catalog: number; connected: number; status: number };
  /** The catalog page (from 1) answered with HTTP 500, or whose connection is dropped. */
  failPage: number;
  dropPage: number;
  /** The catalog page (from 1) answered HTTP 200 with a body that is not JSON. */
  garblePage: number;
  /** Whether pages report the catalog's totals; without them a walk can only end on a page with no cursor. */
  totals: boolean;
  /** Every request answers HTTP 503. */
  down: boolean;
  connected: Record<string, { connected: boolean; status: string }>;
  /** What the connected list says of itself; unset, it says nothing, as an older service does. */
  inventoryComplete?: boolean;
  /** Holds every answer until the returned function is called. */
  hold(): () => void;
  /** Resolves when the next request arrives. */
  arrival(): Promise<void>;
  close(): Promise<void>;
}

export async function startFakeCatalogService(): Promise<FakeCatalogService> {
  let gate: Promise<void> | null = null;
  let arrived = () => {};
  const fake: Omit<FakeCatalogService, "url" | "close"> = {
    pages: [3, 3, 2], edition: 0, requests: { catalog: 0, connected: 0, status: 0 }, failPage: 0, dropPage: 0, garblePage: 0, totals: true, down: false,
    connected: { gmail: { connected: true, status: "ACTIVE" } },
    hold() {
      let open = () => {};
      gate = new Promise<void>((resolve) => { open = () => { gate = null; resolve(); }; });
      return open;
    },
    arrival: () => new Promise<void>((resolve) => { arrived = resolve; }),
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    if (url.pathname === "/v1/catalog") fake.requests.catalog += 1;
    if (url.pathname === "/v1/connectors/connected") fake.requests.connected += 1;
    if (url.pathname === "/v1/connectors") fake.requests.status += 1;
    arrived();
    if (gate) await gate;
    res.setHeader("content-type", "application/json");
    if (fake.down) {
      res.statusCode = 503;
      return res.end(JSON.stringify({ error: "down" }));
    }
    if (url.pathname === "/v1/catalog") {
      const page = Number((url.searchParams.get("cursor") ?? "p1").slice(1));
      if (fake.failPage === page) {
        res.statusCode = 500;
        return res.end(JSON.stringify({ error: "page unavailable" }));
      }
      if (fake.dropPage === page) return void req.socket.destroy();
      if (fake.garblePage === page) return res.end("<html>bad gateway</html>");
      const start = fake.pages.slice(0, page - 1).reduce((sum, size) => sum + size, 0);
      const items = Array.from({ length: fake.pages[page - 1] ?? 0 }, (_, index) => ({ slug: `app${start + index}`, name: `App ${start + index} v${fake.edition}` }));
      return res.end(JSON.stringify({
        items,
        ...(fake.totals ? { total_items: fake.pages.reduce((sum, size) => sum + size, 0), current_page: page, total_pages: fake.pages.length } : {}),
        ...(page < fake.pages.length ? { next_cursor: `p${page + 1}` } : {}),
      }));
    }
    if (url.pathname === "/v1/connectors/connected") {
      return res.end(JSON.stringify({ services: fake.connected, ...(fake.inventoryComplete === undefined ? {} : { complete: fake.inventoryComplete }) }));
    }
    if (url.pathname === "/v1/connectors") {
      const asked = (url.searchParams.get("services") ?? "").split(",").filter(Boolean);
      return res.end(JSON.stringify({ services: Object.fromEntries(asked.map((slug) => [slug, fake.connected[slug] ?? { connected: false, status: "not_connected" }])) }));
    }
    if (req.method === "POST" && url.pathname.endsWith("/authorize")) return res.end(JSON.stringify({ url: "https://connect.composio.dev/fake" }));
    if (req.method === "DELETE") return res.end(JSON.stringify({ removed: 1 }));
    res.statusCode = 404;
    return res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return Object.assign(fake, {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  });
}

/** Whether `read` was still waiting once the stand-in held a request of its; the stand-in answers before this returns. */
export async function waitedOnService<T>(fake: FakeCatalogService, read: () => Promise<T>): Promise<{ waited: boolean; value: T }> {
  const open = fake.hold();
  const arrival = fake.arrival();
  let settled = false;
  const pending = read().then((value) => {
    settled = true;
    return value;
  });
  await Promise.race([pending, arrival]);
  for (let turn = 0; turn < 20; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  const waited = !settled;
  open();
  return { waited, value: await pending };
}
