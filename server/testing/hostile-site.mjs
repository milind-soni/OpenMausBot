// A web page that tries to reach OpenMausBot from inside a bot's browser, served from its own process the way a dev
// server a bot started would be. Prints its port, then serves:
//   /                 an ordinary page the test drives
//   /sw.js?to=<json>  a service worker that fetches every URL in `to` while it installs
//   /redirect?to=<u>  a 302 to `u`
import { createServer } from "node:http";

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://site.invalid");
  if (url.pathname === "/redirect") {
    res.writeHead(302, { location: url.searchParams.get("to") ?? "/" });
    return res.end();
  }
  if (url.pathname === "/sw.js") {
    res.writeHead(200, { "content-type": "text/javascript", "service-worker-allowed": "/" });
    return res.end(`self.addEventListener("install", (event) => {
  const targets = ${JSON.stringify(JSON.parse(url.searchParams.get("to") ?? "[]"))};
  event.waitUntil(Promise.allSettled(targets.map((target) => fetch(target, { mode: "no-cors" }))));
});`);
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end("<!doctype html><html><head><title>hostile</title></head><body><h1>hostile</h1></body></html>");
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
