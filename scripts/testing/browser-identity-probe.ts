// A loopback site that reports what a browser says it is from four places: the page, a dedicated worker, a service worker and
// a cross-site frame (localhost against 127.0.0.1, so Chrome puts it in a process of its own), plus the request headers.
import { createServer, type IncomingMessage, type Server } from "node:http";

import { HIGH_ENTROPY_HINTS } from "../../server/browser/chrome/identity.ts";

export interface ReportedIdentity {
  ua: string;
  brands: Array<{ brand: string; version: string }> | null;
  high: Record<string, unknown> | null;
}

export interface PageReport extends ReportedIdentity {
  webdriver: boolean;
  plugins: number;
  windowChrome: string;
  inner: [number, number];
  outer: [number, number];
  screen: [number, number];
  dpr: number;
  languages: string[];
  timeZone: string;
  scrollbarWidth: number;
  /** How often the page's own Error.name getter ran per console.log: more than 1 means a CDP client enabled Runtime. */
  errorNameReadsPerLog: number;
}

export interface ProbeReports {
  page?: PageReport;
  worker?: ReportedIdentity;
  serviceworker?: ReportedIdentity;
  frame?: ReportedIdentity;
  headers: Record<string, Record<string, string | undefined>>;
}

const READ = `async () => ({ ua: navigator.userAgent, brands: navigator.userAgentData ? navigator.userAgentData.brands : null,
  high: navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(${JSON.stringify(HIGH_ENTROPY_HINTS)}) : null })`;
const ACCEPT_CH = "Sec-CH-UA-Full-Version-List, Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Model, Sec-CH-UA-Bitness";

const page = (crossOrigin: string) => `<!doctype html><meta charset="utf-8"><title>identity probe</title>
<body style="margin:0"><p>identity probe</p><iframe src="${crossOrigin}/frame" style="width:200px;height:60px;border:0"></iframe>
<script>
const read = ${READ};
const post = (name, body) => fetch('/report/' + name, { method: 'POST', body: JSON.stringify(body) });
function errorNameReads() {
  let reads = 0;
  const rounds = 20;
  for (let i = 0; i < rounds; i++) {
    const error = new Error('probe');
    Object.defineProperty(error, 'name', { configurable: true, get() { reads++; return 'Error'; } });
    console.log(error);
  }
  return reads / rounds;
}
function scrollbarWidth() {
  const box = document.createElement('div');
  box.style.cssText = 'width:100px;height:100px;overflow:scroll;position:absolute;top:-999px';
  document.body.appendChild(box);
  const width = box.offsetWidth - box.clientWidth;
  box.remove();
  return width;
}
(async () => {
  const report = await read();
  Object.assign(report, {
    webdriver: navigator.webdriver, plugins: navigator.plugins.length, windowChrome: typeof window.chrome,
    inner: [innerWidth, innerHeight], outer: [outerWidth, outerHeight], screen: [screen.width, screen.height], dpr: devicePixelRatio,
    languages: [...navigator.languages], timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    scrollbarWidth: scrollbarWidth(), errorNameReadsPerLog: errorNameReads(),
  });
  await fetch('/headers/fetch');
  await post('page', report);
  const worker = new Worker('/worker.js');
  worker.onmessage = (event) => post('worker', event.data);
  const registration = await navigator.serviceWorker.register('/sw.js');
  const active = registration.active || await new Promise((resolve) => {
    const installing = registration.installing || registration.waiting;
    installing.addEventListener('statechange', () => { if (installing.state === 'activated') resolve(installing); });
  });
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => post('serviceworker', event.data);
  active.postMessage('read', [channel.port2]);
})();
</script>`;

const frame = `<!doctype html><meta charset="utf-8"><title>frame</title><script>
(${READ})().then((report) => fetch('/report/frame', { method: 'POST', body: JSON.stringify(report) }));
</script>`;

const worker = `(${READ})().then((report) => postMessage(report));`;

const serviceWorker = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => event.waitUntil((async () => {
  const report = await (${READ})();
  await fetch('/headers/serviceworker');
  event.ports[0].postMessage(report);
})()));`;

const HEADERS = ["user-agent", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-ch-ua-platform-version", "sec-ch-ua-arch", "sec-ch-ua-bitness", "sec-ch-ua-full-version-list", "accept-language"];
const picked = (request: IncomingMessage) => Object.fromEntries(HEADERS.map((name) => [name, request.headers[name] as string | undefined]));

export interface IdentityProbe {
  url: string;
  reports: ProbeReports;
  /** Resolves once all four places have reported, or rejects after `timeoutMs`. */
  complete(timeoutMs: number): Promise<ProbeReports>;
  close(): Promise<void>;
}

export async function startIdentityProbe(): Promise<IdentityProbe> {
  const reports: ProbeReports = { headers: {} };
  let port = 0;
  const handler = (request: IncomingMessage, response: import("node:http").ServerResponse) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const send = (type: string, body: string, extra: Record<string, string> = {}) => {
      response.writeHead(200, { "content-type": type, "cache-control": "no-store", ...extra });
      response.end(body);
    };
    if (path === "/probe") {
      reports.headers.document = picked(request);
      return send("text/html; charset=utf-8", page(`http://localhost:${port}`), { "accept-ch": ACCEPT_CH });
    }
    if (path === "/frame") {
      reports.headers.frame = picked(request);
      return send("text/html; charset=utf-8", frame, { "accept-ch": ACCEPT_CH });
    }
    if (path === "/worker.js") return send("text/javascript", worker);
    if (path === "/sw.js") return send("text/javascript", serviceWorker);
    if (path.startsWith("/headers/")) {
      reports.headers[path.slice("/headers/".length)] = picked(request);
      return send("application/json", "{}");
    }
    const report = /^\/report\/(page|worker|serviceworker|frame)$/u.exec(path);
    if (report && request.method === "POST") {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { if (body.length < 1_000_000) body += chunk; });
      request.on("end", () => {
        try { (reports as unknown as Record<string, unknown>)[report[1]!] = JSON.parse(body); } catch {}
        response.writeHead(204);
        response.end();
      });
      return;
    }
    response.writeHead(404);
    response.end();
  };
  const servers: Server[] = [];
  const primary = createServer(handler);
  await new Promise<void>((resolve, reject) => { primary.once("error", reject); primary.listen(0, "127.0.0.1", resolve); });
  port = (primary.address() as { port: number }).port;
  servers.push(primary);
  // Chrome may reach "localhost" over IPv6 first.
  const v6 = createServer(handler);
  await new Promise<void>((resolve) => { v6.once("error", () => resolve()); v6.listen(port, "::1", () => { servers.push(v6); resolve(); }); });
  return {
    url: `http://127.0.0.1:${port}/probe`,
    reports,
    async complete(timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (!(reports.page && reports.worker && reports.serviceworker && reports.frame && reports.headers.serviceworker)) {
        if (Date.now() > deadline) {
          const missing = ["page", "worker", "serviceworker", "frame"].filter((name) => !(reports as unknown as Record<string, unknown>)[name]);
          throw new Error(`the probe page did not report from: ${missing.join(", ") || "the service worker's fetch"}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return reports;
    },
    close: async () => { await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve)))); },
  };
}

const PLATFORM_TOKENS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "Macintosh; Intel Mac OS X 10_15_7",
  win32: "Windows NT 10.0; Win64; x64",
  linux: "X11; Linux x86_64",
};

/** Chrome's reduced user agent for a major version, which is what a headed Chrome sends; written out here, not read from the
 * browser, so the check does not grade the browser against itself. */
export function expectedUserAgent(major: string, platform: NodeJS.Platform = process.platform): string {
  return `Mozilla/5.0 (${PLATFORM_TOKENS[platform] ?? "X11; Linux x86_64"}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
