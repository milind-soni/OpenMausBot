import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../config.ts";
import { json, readBody } from "../harness/http.ts";
import type { RequestAuth } from "../request-auth.ts";
import type { Store } from "../store.ts";
import { fakeGitHub } from "../testing/fake-github.ts";
import { workspaceDir } from "../workspace.ts";
import { createBotSkillsRoutes } from "./bot-skills.ts";
import { dispatchRoutes } from "./table.ts";

const SKILL = "---\nname: pdf-forms\ndescription: Fills PDF forms.\n---\n\n# PDF forms\nRead references/fields.md, then run scripts/fill.py.\n";

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise((done) => server.close(done))));
});

async function serve(botId: string) {
  const store = { bot: (id: string) => (id === botId ? { id } : undefined), bots: [] } as unknown as Store;
  const routes = [createBotSkillsRoutes({
    store,
    cfg: {} as AppConfig,
    listBotSkills: () => [],
    readBotSkillFile: () => null,
    stagedSkillListing: (staged) => staged,
  })];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const auth = { kind: "loopback", scopes: ["admin"] } as unknown as RequestAuth;
    if (!await dispatchRoutes(routes, { req, res, url, path: url.pathname, method: req.method ?? "GET", auth, json, readBody })) json(res, 404, {});
  });
  servers.push(server);
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe("importing a skill from GitHub into a bot", () => {
  it("stores the whole folder with its origin and says what arrived and what was left out", async () => {
    const botId = `route-bot-${Math.random().toString(36).slice(2, 10)}`;
    const base = await serve(botId);
    const github = fakeGitHub({ "acme/skills": {
      "skills/pdf-forms/SKILL.md": SKILL,
      "skills/pdf-forms/references/fields.md": "# Fields\n",
      "skills/pdf-forms/scripts/fill.py": { content: "print('fill')\n", executable: true },
      "skills/pdf-forms/assets/form.pdf": Buffer.from("%PDF-1.7\n\u0000ÿ"),
      "skills/pdf-forms/shortcut.md": { link: "references/fields.md" },
    } }, { passThrough: fetch });
    vi.stubGlobal("fetch", github.fetch);

    const response = await fetch(`${base}/api/bots/${botId}/skills`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ source: "https://github.com/acme/skills/tree/main/skills/pdf-forms" }),
    });
    expect(response.status).toBe(201);
    const body = await response.json() as { imported: unknown; installed: unknown };
    const commit = github.commitOf("acme/skills");
    expect(body.imported).toEqual([
      { name: "pdf-forms", files: 4, scripts: 1, skipped: [{ path: "shortcut.md", reason: "link" }], skippedCount: 1 },
    ]);
    expect(body.installed).toEqual([expect.objectContaining({
      name: "pdf-forms",
      enabled: false,
      files: ["assets/form.pdf", "references/fields.md", "scripts/fill.py"],
      github: { owner: "acme", repo: "skills", ref: "main", commit, path: "skills/pdf-forms" },
    })]);
    const folder = join(workspaceDir(botId), "skills", "pdf-forms");
    expect(readFileSync(join(folder, "references", "fields.md"), "utf8")).toBe("# Fields\n");
    expect(readFileSync(join(folder, "assets", "form.pdf"))).toEqual(Buffer.from("%PDF-1.7\n\u0000ÿ"));
    expect(existsSync(join(folder, "shortcut.md"))).toBe(false);
  });
});
