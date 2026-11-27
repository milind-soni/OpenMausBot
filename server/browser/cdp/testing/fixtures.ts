// Local pages for the driver's real-Chrome suites. The server answers on
// 127.0.0.1 and on localhost (::1 too), two sites, so a frame from the other
// one runs out of process.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface FixtureResponse {
  body: string | Buffer;
  type?: string;
  status?: number;
  headers?: Record<string, string>;
  delayMs?: number;
}

type Route = FixtureResponse | ((request: IncomingMessage, url: URL) => FixtureResponse);

export class FixtureServer {
  readonly #routes = new Map<string, Route>();
  readonly #servers: Server[] = [];
  readonly requests: string[] = [];
  port = 0;

  static async start(): Promise<FixtureServer> {
    const fixtures = new FixtureServer();
    await fixtures.#listen();
    return fixtures;
  }

  async #listen(): Promise<void> {
    const first = createServer((request, response) => this.#handle(request, response));
    await new Promise<void>((resolve) => first.listen(0, "127.0.0.1", resolve));
    this.port = (first.address() as AddressInfo).port;
    this.#servers.push(first);
    const second = createServer((request, response) => this.#handle(request, response));
    await new Promise<void>((resolve) => {
      second.once("error", () => resolve());
      second.listen(this.port, "::1", () => resolve());
    });
    if (second.listening) this.#servers.push(second);
  }

  /** http://127.0.0.1:<port><path> */
  url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`;
  }

  /** The same path on the other site. */
  crossSiteUrl(path: string): string {
    return `http://localhost:${this.port}${path}`;
  }

  route(path: string, route: Route): string {
    this.#routes.set(path, route);
    return this.url(path);
  }

  page(path: string, html: string): string {
    return this.route(path, { body: html });
  }

  #handle(request: IncomingMessage, response: ServerResponse): void {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    this.requests.push(`${request.method} ${url.host}${url.pathname}`);
    const route = this.#routes.get(url.pathname);
    if (!route) {
      response.writeHead(404, { "content-type": "text/plain" });
      response.end("not here");
      return;
    }
    const answer = typeof route === "function" ? route(request, url) : route;
    const send = () => {
      response.writeHead(answer.status ?? 200, { "content-type": answer.type ?? "text/html; charset=utf-8", "cache-control": "no-store", ...answer.headers });
      response.end(answer.body);
    };
    if (answer.delayMs) setTimeout(send, answer.delayMs);
    else send();
  }

  async close(): Promise<void> {
    await Promise.all(this.#servers.map((server) => new Promise<void>((resolve) => {
      server.closeAllConnections?.();
      server.close(() => resolve());
    })));
  }
}
