import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import { readSkillLibraryIndex, skillsLibraryRoot } from "../skill-library.ts";
import type { Store } from "../store.ts";
import { fakeGitHub } from "../testing/fake-github.ts";
import { createSkillsRoutes } from "./skills.ts";
import { dispatchRoutes } from "./table.ts";

const SKILL = "---\nname: pdf-forms\ndescription: Fills PDF forms.\n---\n\n# PDF forms\nRead references/fields.md, then run scripts/fill.py.\n";

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve() {
  const store = { bot: () => undefined, bots: [] } as unknown as Store;
  const routes = [createSkillsRoutes({ store, listBotSkills: () => [], catalog: () => ({ bots: () => [], patchAssigned: () => {}, builtIns: () => [] }) })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("adding a skill from GitHub to the library", () => {
  it("keeps the whole folder and where it came from, for every bot, and says what came in and what was left out", async () => {
    const base = await serve();
    const github = fakeGitHub({ "acme/skills": {
      "skills/pdf-forms/SKILL.md": SKILL,
      "skills/pdf-forms/references/fields.md": "# Fields\n",
      "skills/pdf-forms/scripts/fill.py": { content: "print('fill')\n", executable: true },
      "skills/pdf-forms/assets/form.pdf": Buffer.from("%PDF-1.7\n\u0000ÿ"),
      "skills/pdf-forms/shortcut.md": { link: "references/fields.md" },
    } }, { passThrough: fetch });
    vi.stubGlobal("fetch", github.fetch);

    const response = await fetch(`${base}/api/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ link: "https://github.com/acme/skills/tree/main/skills/pdf-forms" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      added: ["pdf-forms"],
      imported: [{ name: "pdf-forms", files: 4, scripts: 1, skipped: [{ path: "shortcut.md", reason: "link" }], skippedCount: 1 }],
      errors: [],
    });
    const entry = readSkillLibraryIndex()["pdf-forms"]!;
    expect(entry).toMatchObject({
      everyBot: true, reviewState: "approved", skippedFiles: ["shortcut.md"],
      github: { owner: "acme", repo: "skills", ref: "main", commit: github.commitOf("acme/skills"), path: "skills/pdf-forms" },
    });
    expect([...entry.files ?? []].sort()).toEqual(["assets/form.pdf", "references/fields.md", "scripts/fill.py"]);
    const folder = join(skillsLibraryRoot(), "skills", "pdf-forms");
    expect(readFileSync(join(folder, "assets", "form.pdf"))).toEqual(Buffer.from("%PDF-1.7\n\u0000ÿ"));
    expect(existsSync(join(folder, "shortcut.md"))).toBe(false);

    const detail = await fetch(`${base}/api/skills/${encodeURIComponent("library:pdf-forms")}`);
    expect(await detail.json()).toEqual({
      instructions: "# PDF forms\nRead references/fields.md, then run scripts/fill.py.",
      files: ["assets/form.pdf", "references/fields.md", "scripts/fill.py"],
    });
  });
});
