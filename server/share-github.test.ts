import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalJson, parsePackageDocument } from "../shared/package-format.ts";
import { writeShareFolder } from "../shared/share-folder.ts";
import { fetchGithubTemplate, githubTemplateSource } from "./share-github.ts";
import { fetchLibraryTeam, TEAM_LIBRARY_RAW_ROOT } from "./team-library.ts";

const RAW = "https://raw.githubusercontent.com";
const team = parsePackageDocument(JSON.parse(readFileSync(join(import.meta.dirname, "..", "shared", "package-fixtures", "full-team.v2.json"), "utf8")));

/** A stand-in for raw.githubusercontent.com: the files of one folder, and the requests it was sent. */
function stubGithub(base: string, files: Record<string, string | Uint8Array>) {
  const asked: Array<{ url: string; redirect?: RequestInit["redirect"] }> = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    asked.push({ url, redirect: init?.redirect });
    const path = url.startsWith(`${base}/`) ? url.slice(base.length + 1) : null;
    const body = path === null ? undefined : files[path];
    if (body === undefined) return new Response("Not Found", { status: 404 });
    return new Response(typeof body === "string" ? body : new Uint8Array(body), { status: 200 });
  }) as typeof fetch;
  return { fetcher, asked };
}

describe("GitHub template links", () => {
  it("reads repositories, folder links, bot.md and team.md links and older single files", () => {
    expect(githubTemplateSource("https://github.com/acme/teams/tree/3f81576/teams/sales-desk")).toEqual({
      kind: "folders", folders: [{ base: `${RAW}/acme/teams/3f81576/teams/sales-desk`, names: ["bot.md", "team.md"] }],
    });
    expect(githubTemplateSource("https://github.com/acme/teams")).toMatchObject({ kind: "folders", folders: [{ base: `${RAW}/acme/teams/main` }, { base: `${RAW}/acme/teams/master` }] });
    expect(githubTemplateSource("https://github.com/acme/teams/blob/main/teams/helper/bot.md")).toEqual({
      kind: "folders", folders: [{ base: `${RAW}/acme/teams/main/teams/helper`, names: ["bot.md"] }],
    });
    expect(githubTemplateSource(`${RAW}/acme/teams/main/packages/sales.md`)).toEqual({ kind: "file", url: `${RAW}/acme/teams/main/packages/sales.md`, name: "sales.md" });
  });

  it("refuses links that aren't public https GitHub, or that climb out of the repository", () => {
    for (const link of ["http://github.com/acme/teams", "https://user:pw@github.com/acme/teams", "https://github.com:8443/acme/teams",
      "https://gitlab.com/acme/teams", "https://github.com/acme/teams/tree/main/a%2F..%2Fb", "https://github.com/acme/teams/blob/main/run.sh", "not a link"]) {
      expect(() => githubTemplateSource(link), link).toThrow();
    }
  });

  it("fetches the manifest, then only the skills and pictures it names, without following redirects", async () => {
    const base = `${RAW}/acme/teams/abc123/teams/sales-desk`;
    const { fetcher, asked } = stubGithub(base, { ...writeShareFolder(team, "department"), "skills/extra/SKILL.md": "never asked for" });
    const folder = await fetchGithubTemplate("https://github.com/acme/teams/tree/abc123/teams/sales-desk", fetcher);
    expect(folder.kind === "package" && folder.scope).toBe("department");
    expect(folder.kind === "package" && folder.document.package.skills?.entries.map((skill) => skill.name)).toEqual(["pricing-policy", "research-brief", "objection-handling"]);
    expect(asked.map((call) => call.url.slice(base.length + 1))).toEqual(["bot.md", "team.md", "skills/pricing-policy/SKILL.md", "skills/research-brief/SKILL.md", "skills/objection-handling/SKILL.md", "avatars/lead.png"]);
    expect(asked.every((call) => call.redirect === "error")).toBe(true);
  });

  it.each(["references/C# examples.md", "references/URL%20encoding.md", "references/space in name.md", "references/中文指南.md"])("imports the complete template over HTTP when a skill file is named %s", async (path) => {
    const input = structuredClone(team);
    input.package.skills!.entries[0]!.files = [{ path, content: `# Reference\nRead ${path}.\n` }];
    const document = parsePackageDocument(input);
    const files = writeShareFolder(document, "department");
    const prefix = "/acme/teams/main/teams/helper/";
    const requested: string[] = [];
    const server = createServer((request, response) => {
      const pathname = decodeURIComponent(new URL(request.url!, "http://localhost").pathname);
      const relative = pathname.startsWith(prefix) ? pathname.slice(prefix.length) : "";
      requested.push(relative);
      const body = files[relative];
      if (body === undefined) { response.writeHead(404); response.end("Not Found"); return; }
      response.end(typeof body === "string" ? body : Buffer.from(body));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No fixture port");
      const origin = `http://127.0.0.1:${address.port}`;
      const fetcher = ((url: string, init?: RequestInit) => {
        expect(url.startsWith(`${RAW}/`)).toBe(true);
        return fetch(`${origin}${url.slice(RAW.length)}`, init);
      }) as typeof fetch;
      const folder = await fetchGithubTemplate("https://github.com/acme/teams/tree/main/teams/helper", fetcher);
      expect(folder.kind).toBe("package");
      if (folder.kind !== "package") throw new Error("Not a package");
      expect(canonicalJson(folder.document)).toBe(canonicalJson(document));
      expect(requested).toContain(`skills/pricing-policy/${path}`);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("falls back from main to master for a repository link and says so when nothing is there", async () => {
    const base = `${RAW}/acme/helper/master`;
    const { fetcher } = stubGithub(base, writeShareFolder(team, "department"));
    expect((await fetchGithubTemplate("https://github.com/acme/helper", fetcher)).kind).toBe("package");
    await expect(fetchGithubTemplate("https://github.com/acme/empty", stubGithub(`${RAW}/x`, {}).fetcher)).rejects.toThrow(/No bot.md or team.md/);
  });

  it("refuses a file larger than the cap even when GitHub doesn't say its size", async () => {
    const { fetcher } = stubGithub(`${RAW}/acme/big/main`, { "team.md": "x".repeat(1_100_000) });
    await expect(fetchGithubTemplate("https://github.com/acme/big/blob/main/team.md", fetcher)).rejects.toThrow(/larger than 4 MB/);
  });

  it("reads a gallery team from its template folder when the catalog names one", async () => {
    const folder = writeShareFolder(team, "department");
    const catalog = { format: "openmaus.catalog", version: 1, teams: [{ slug: "sales-desk", name: "Sales desk", summary: "Sales.", category: "Sales",
      manifest: "teams/sales-desk/team.mausteam.json", readme: "teams/sales-desk/README.md", members: 3, skills: [], requires: { apps: [] },
      folder: "teams/sales-desk", kind: "department", main: "teams/sales-desk/team.md" }] };
    const fetcher = (async (url: string) => {
      if (url === `${TEAM_LIBRARY_RAW_ROOT}/catalog.json`) return Response.json(catalog);
      const path = url.slice(`${TEAM_LIBRARY_RAW_ROOT}/teams/sales-desk/`.length);
      const body = url.startsWith(`${TEAM_LIBRARY_RAW_ROOT}/teams/sales-desk/`) ? folder[path] : undefined;
      return body === undefined ? new Response("", { status: 404 }) : new Response(typeof body === "string" ? body : new Uint8Array(body));
    }) as typeof fetch;
    const loaded = await fetchLibraryTeam("sales-desk", fetcher);
    expect("package" in loaded && loaded.package.skills?.entries).toHaveLength(3);
  });
});
