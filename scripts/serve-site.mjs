import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const root = resolve("dist");
const port = Number.parseInt(process.env.PORT ?? "4173", 10);

const contentTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function publicPath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl ?? "/", "http://localhost").pathname);
  const requested = normalize(join(root, pathname));
  return requested.startsWith(root) ? requested : null;
}

createServer((request, response) => {
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.writeHead(405, { Allow: "GET, HEAD" });
    response.end();
    return;
  }

  let target = publicPath(request.url);
  if (target && existsSync(target) && statSync(target).isDirectory()) {
    target = join(target, "index.html");
  }
  if (!target || !existsSync(target) || !statSync(target).isFile()) {
    target = join(root, "index.html");
  }

  response.writeHead(200, {
    "Cache-Control": extname(target) === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    "Content-Type": contentTypes[extname(target)] ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  createReadStream(target).pipe(response);
}).listen(port, "0.0.0.0", () => {
  process.stdout.write(`Agent Centipede site listening on ${port}\n`);
});
