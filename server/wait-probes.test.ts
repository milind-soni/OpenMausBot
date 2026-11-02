import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  expandHome,
  fetchPageText,
  fileChanged,
  fileStamp,
  listProcesses,
  PAGE_MAX_BYTES,
  pageSays,
  pageText,
  parsePs,
  parseTasklist,
  processRunning,
} from "./wait-probes.ts";

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "wait-probes-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("file and process probes", () => {
  it("expands ~ to the home folder and leaves other paths alone", () => {
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("~/a/b.txt", "/h")).toBe(join("/h", "a/b.txt"));
    expect(expandHome("/x/y", "/h")).toBe("/x/y");
    expect(expandHome("~bob/x", "/h")).toBe("~bob/x");
  });
  it("stamps a file with its size and modification time, and a missing one as null", async () => {
    writeFileSync(join(dir, "r.txt"), "abc");
    expect(await fileStamp(join(dir, "r.txt"))).toEqual({ size: 3, mtimeMs: expect.any(Number) });
    expect(await fileStamp(join(dir, "none.txt"))).toBeNull();
  });
  it("sees a change in size or modification time and a file that appears, never a missing file", () => {
    expect(fileChanged({ size: 3, mtimeMs: 1 }, { size: 4, mtimeMs: 1 })).toBe(true);
    expect(fileChanged({ size: 3, mtimeMs: 1 }, { size: 3, mtimeMs: 2 })).toBe(true);
    expect(fileChanged({ size: 3, mtimeMs: 1 }, { size: 3, mtimeMs: 1 })).toBe(false);
    expect(fileChanged(null, { size: 0, mtimeMs: 1 })).toBe(true);
    expect(fileChanged({ size: 3, mtimeMs: 1 }, null)).toBe(false);
  });
  it("reads ps and tasklist output", () => {
    expect(parsePs("    1 /sbin/launchd\n  812 /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n    9 node\n"))
      .toEqual([{ pid: 1, name: "launchd" }, { pid: 812, name: "Google Chrome" }, { pid: 9, name: "node" }]);
    expect(parseTasklist('"chrome.exe","1234","Console","1","123,456 K"\r\n"System","4","Services","0","1,000 K"\r\n'))
      .toEqual([{ pid: 1234, name: "chrome.exe" }, { pid: 4, name: "System" }]);
  });
  it("matches a program by name in any case, with or without .exe, by Linux's 15-character name, or by pid", () => {
    const entries = [{ pid: 812, name: "Google Chrome" }, { pid: 1234, name: "node.exe" }, { pid: 77, name: "gnome-shell-cal" }];
    for (const wanted of ["google chrome", "NODE", "node.exe", "gnome-shell-calendar-server", "812"]) expect(processRunning(entries, wanted), wanted).toBe(true);
    for (const wanted of ["google", "813", "gnome-shell"]) expect(processRunning(entries, wanted), wanted).toBe(false);
  });
  it("runs ps on macOS and Linux and tasklist on Windows, without a shell", async () => {
    const calls: unknown[] = [];
    const run = async (file: string, args: string[]) => { calls.push([file, args]); return ""; };
    await listProcesses("darwin", run); await listProcesses("linux", run); await listProcesses("win32", run);
    expect(calls).toEqual([["ps", ["-axo", "pid=,comm="]], ["ps", ["-axo", "pid=,comm="]], ["tasklist", ["/fo", "csv", "/nh"]]]);
  });
  it("lists this machine's processes, this one included", async () => {
    expect((await listProcesses()).some((entry) => entry.pid === process.pid)).toBe(true);
  });
  it("reads a page as words: tags, scripts and styles out, entities decoded, spaces collapsed", () => {
    const text = pageText("<html><head><style>p{}</style><script>var shipped=1</script></head><body><p>Status:&nbsp;<b>Shipped</b> &amp; done</p></body></html>");
    expect(text).toBe("Status: Shipped & done");
    expect(pageSays(text, "status:   SHIPPED")).toBe(true);
    expect(pageSays(text, "shipped=1")).toBe(false);
  });
  it("keeps a < with no > after it as text, and hides a script or comment left open as a browser does", () => {
    expect(pageText("a < b")).toBe("a < b");
    expect(pageText("<p>In stock</p><script>if (a < b) x = '<b>Sold out</b>'</script><SCRIPT>y</SCRIPT ><p>today</p>")).toBe("In stock today");
    expect(pageText("<!-- <p>Sold out</p> -->In stock<!-->!<script>never closed <p>Sold out</p>")).toBe("In stock !");
    expect(pageText("In stock<!-- never closed <p>Sold out</p>")).toBe("In stock");
  });
  it("reads a hostile 2 MB page in well under a second", () => {
    // 64 KB first, so a reader that backtracks fails here in a second or two instead of running for minutes at 2 MB.
    for (const [size, budgetMs] of [[64 * 1024, 250], [PAGE_MAX_BYTES, 1000]] as const) {
      for (const unit of ["<", "<a ", "<!--", "<script>", "<style ", "<<>", "&lt;"]) {
        const page = unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
        const started = performance.now();
        pageText(page);
        expect(performance.now() - started, `${size} bytes of ${unit}`).toBeLessThan(budgetMs);
      }
    }
  });
});

describe("fetchPageText", () => {
  let server: Server;
  let port = 0;
  const seen: Array<{ host?: string; cookie?: string }> = [];
  const test = {
    lookup: async (host: string) => (host === "status.test" ? [{ address: "127.0.0.1", family: 4 }] : []),
    allow: ({ host }: { host: string }) => host === "status.test",
  };
  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = req.url ?? "/";
      if (path === "/") {
        seen.push({ host: req.headers.host, cookie: req.headers.cookie });
        res.setHeader("content-type", "text/html");
        res.end("<p>Build: Shipped</p>");
      } else if (path === "/hop") {
        res.writeHead(302, { location: "/" }).end();
      } else if (path === "/away") {
        res.writeHead(302, { location: `http://127.0.0.1:${port}/` }).end();
      } else if (path === "/loop") {
        res.writeHead(302, { location: "/loop" }).end();
      } else if (path === "/big") {
        res.write("a".repeat(3 * 1024 * 1024));
        res.end("needle");
      } else if (path === "/404") {
        res.writeHead(404).end();
      }
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });

  it("reads a page through the address it checked, under its own name, with no cookie", async () => {
    expect(await fetchPageText(`http://status.test:${port}/`, test)).toEqual({ ok: true, text: "Build: Shipped" });
    expect(seen.at(-1)).toEqual({ host: `status.test:${port}`, cookie: undefined });
  });
  it("follows a redirect only to an address it may reach, and at most three", async () => {
    expect(await fetchPageText(`http://status.test:${port}/hop`, test)).toEqual({ ok: true, text: "Build: Shipped" });
    expect(await fetchPageText(`http://status.test:${port}/away`, test)).toMatchObject({ ok: false, refused: true });
    expect(await fetchPageText(`http://status.test:${port}/loop`, test)).toEqual({ ok: false, refused: false, error: "The page redirected too many times." });
  });
  it("refuses loopback, private and mixed answers with the real egress check", async () => {
    const mixed = { lookup: async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }] };
    expect(await fetchPageText("http://mixed.test/", mixed)).toMatchObject({ ok: false, refused: true });
    for (const url of [`http://127.0.0.1:${port}/`, `http://localhost:${port}/`, `http://[::1]:${port}/`, `http://2130706433:${port}/`, `http://[::ffff:127.0.0.1]:${port}/`, "http://169.254.169.254/"]) {
      expect(await fetchPageText(url), url).toMatchObject({ ok: false, refused: true });
    }
  });
  it("takes only http and https, with no sign-in in the address", async () => {
    for (const url of ["file:///etc/passwd", "ftp://example.com/", "https://user:pass@example.com/"]) {
      expect(await fetchPageText(url), url).toMatchObject({ ok: false, refused: true });
    }
  });
  it("reads at most 2 MB, and gives up after its timeout", async () => {
    const big = await fetchPageText(`http://status.test:${port}/big`, test);
    expect(big).toMatchObject({ ok: true });
    expect(big.ok && big.text.length).toBe(PAGE_MAX_BYTES);
    expect(big.ok && big.text.includes("needle")).toBe(false);
    expect(await fetchPageText(`http://status.test:${port}/slow`, { ...test, timeoutMs: 200 })).toEqual({ ok: false, refused: false, error: "The page took too long to answer." });
  });
  it("gives up on a lookup that never answers within its timeout", async () => {
    const started = Date.now();
    const result = await fetchPageText("http://stuck.test/", { lookup: () => new Promise(() => {}), timeoutMs: 200 });
    expect(result).toEqual({ ok: false, refused: false, error: "The page took too long to answer." });
    expect(Date.now() - started).toBeLessThan(1000);
  });
  it("counts an answer that is not 2xx as a failed check", async () => {
    expect(await fetchPageText(`http://status.test:${port}/404`, test)).toEqual({ ok: false, refused: false, error: "The page answered 404." });
  });
});
