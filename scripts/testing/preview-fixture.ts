// The one Vite preview every verify-* fixture mounts: an isolated page for a
// single entry module whose /api calls reach only the disposable fake-engine
// server. vite.config.ts is inherited on purpose (react, tailwind, the @ alias)
// so the page renders exactly what the app renders; only the host, the port
// and the /api target are pinned here.
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export interface PreviewRoute {
  /** Pathname to answer (the query string is ignored); a RegExp hands its match to the handler. */
  path: string | RegExp;
  /** Restrict to one HTTP method; any method when omitted. */
  method?: string;
  handler: (req: IncomingMessage, res: ServerResponse, match: RegExpExecArray | null) => void | Promise<void>;
}

export interface PreviewOptions {
  /** Root-relative URL of the module the page loads, e.g. "/scripts/testing/x.tsx". */
  entry: string;
  /** Pathname the isolated page is served at, e.g. "/__x.html". */
  route: string;
  title: string;
  /** Fixture-only endpoints beside the page: test pages, drift triggers, captured requests. */
  extraRoutes?: PreviewRoute[];
  /** Content of the viewport meta tag. */
  viewport?: string;
  /** Vite's log level. Its default prints port and dependency notes on stdout,
   * ahead of anything the fixture prints there. */
  logLevel?: "info" | "warn" | "error" | "silent";
}

export interface MountedPreview {
  previewUrl: string;
  close(): Promise<void>;
}

const escapeHtml = (text: string) =>
  text.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);

const matchRoute = (route: PreviewRoute, pathname: string, method: string | undefined) => {
  if (route.method !== undefined && route.method !== method) return undefined;
  if (typeof route.path === "string") return route.path === pathname ? { match: null } : undefined;
  const match = route.path.exec(pathname);
  return match ? { match } : undefined;
};

/** Serve `entry` in an isolated page whose /api requests are proxied to `fixture`. */
export async function mountPreview(
  fixture: { info: { url: string } },
  options: PreviewOptions,
): Promise<MountedPreview> {
  const { entry, route, title, extraRoutes = [], viewport = "width=device-width, initial-scale=1", logLevel } = options;
  const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="${escapeHtml(viewport)}"><title>${escapeHtml(title)}</title></head><body><div id="root"></div><script type="module" src="${escapeHtml(entry)}"></script></body></html>`;
  const ui = await createServer({
    root: REPO_ROOT,
    ...(logLevel ? { logLevel } : {}),
    server: { host: "127.0.0.1", port: 0, proxy: { "/api": { target: fixture.info.url } } },
    plugins: [{
      name: "isolated-preview",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const pathname = (req.url ?? "").split("?")[0]!;
          if (pathname === route) {
            void server.transformIndexHtml(route, page)
              .then((html) => { res.setHeader("content-type", "text/html"); res.end(html); })
              .catch(next);
            return;
          }
          for (const extra of extraRoutes) {
            const hit = matchRoute(extra, pathname, req.method);
            if (!hit) continue;
            void Promise.resolve().then(() => extra.handler(req, res, hit.match)).catch(next);
            return;
          }
          next();
        });
      },
    }],
  });
  await ui.listen();
  const base = ui.resolvedUrls?.local[0];
  if (!base) {
    await ui.close();
    throw new Error("the preview server did not report a local URL");
  }
  return {
    previewUrl: new URL(route, base).href,
    close: () => ui.close(),
  };
}

/** Resolve on the first SIGINT or SIGTERM: the "print the URL and wait" ending. */
export function parkUntilSignal(): Promise<void> {
  return new Promise<void>((resolve) => {
    const settle = () => {
      process.off("SIGINT", settle);
      process.off("SIGTERM", settle);
      resolve();
    };
    process.once("SIGINT", settle);
    process.once("SIGTERM", settle);
  });
}

export interface FixtureApiOptions {
  /** Sent with every call; `origin: fixture.info.url` marks a request as the app's own. */
  headers?: Record<string, string>;
  /** Sees every call that succeeded, e.g. to record mutation evidence. */
  observe?: (call: { method: string; path: string; status: number }) => void;
}

/** JSON fetch against the fixture server; a non-2xx status throws with the body. */
export function fixtureApi(baseUrl: string, options: FixtureApiOptions = {}) {
  return async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(`${baseUrl}${path}`, {
      method, headers: { "content-type": "application/json", ...options.headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(`${method} ${path}: ${JSON.stringify(result)}`);
    options.observe?.({ method, path, status: response.status });
    return result;
  };
}
