import { describe, expect, it } from "vitest";

import { importedSkillRequest } from "./skill-request-card.ts";
import { fakeGitHub } from "./testing/fake-github.ts";

const SKILL = (name: string) => `---\nname: ${name}\ndescription: Does ${name} things.\n---\n\n# ${name}\n`;
const github = fakeGitHub({
  "acme/skills": {
    "skills/pdf/SKILL.md": SKILL("pdf"),
    "skills/pdf/references/forms.md": "# Forms\n",
    "skills/pdf/scripts/fill.py": { content: "print('fill')\n", executable: true },
    "skills/docx/SKILL.md": SKILL("docx"),
  },
  "acme/notes": { "references/forms.md": "# Forms\n" },
});
const importing = (source?: string) => importedSkillRequest({ action: "import", skill_name: "ignored", ...(source ? { source } : {}) }, github.fetch);

describe("importedSkillRequest", () => {
  it("leaves every action but import as it came", async () => {
    const body = { action: "create", skill_md: SKILL("pdf"), source: "conversation" };
    expect(await importedSkillRequest(body, github.fetch)).toBe(body);
    expect(github.requests).toEqual([]);
  });

  it("turns an import into a create with the fetched SKILL.md, its references and its source, and says what was left behind", async () => {
    const body = await importing("https://github.com/acme/skills/tree/main/skills/pdf");
    expect(body).toMatchObject({
      action: "create",
      skill_name: undefined,
      skill_md: SKILL("pdf"),
      references: [{ path: "references/forms.md", content: "# Forms\n" }],
      source: "github.com/acme/skills@main/skills/pdf",
      gist: expect.stringMatching(/Not brought in \(only SKILL\.md and references\/\*\.md are\): scripts\/fill\.py$/),
    });
  });

  it("refuses with a clear error when the source is missing, wrong, has several skills or none", async () => {
    expect(await importing()).toEqual({ importError: expect.stringContaining("needs source") });
    expect(await importing("not a link")).toEqual({ importError: expect.stringMatching(/^Could not import a skill from not a link: /) });
    expect(await importing("acme/skills")).toEqual({ importError: expect.stringContaining("acme/skills has 2 skills (") });
    expect(await importing("acme/notes")).toEqual({ importError: expect.stringMatching(/^Could not import a skill from acme\/notes: /) });
  });

  it("stops fetching once the turn's signal aborts", async () => {
    const turnEnded = new AbortController();
    turnEnded.abort();
    const before = github.requests.length;
    const body = await importedSkillRequest({ action: "import", source: "https://github.com/acme/skills/tree/main/skills/pdf" }, github.fetch, turnEnded.signal);
    expect(body).toEqual({ importError: expect.stringMatching(/^Could not import a skill from /) });
    expect(github.requests.length).toBe(before);
  });

  it("cancels a fetch that is still running when the turn ends", async () => {
    const turnEnded = new AbortController();
    let calls = 0;
    const slowGitHub: typeof fetch = (_input, init) => {
      calls += 1;
      queueMicrotask(() => turnEnded.abort());
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
      });
    };
    const body = await importedSkillRequest({ action: "import", source: "https://github.com/acme/skills/tree/main/skills/pdf" }, slowGitHub, turnEnded.signal);
    expect(body).toEqual({ importError: expect.stringMatching(/^Could not import a skill from /) });
    expect(calls).toBe(1);
  });

  it("forwards a sign-in getter onto GitHub API requests and leaves raw downloads anonymous", async () => {
    const token = "gho_syntheticSkillImportToken";
    const calls: Array<{ url: string; headers: Headers }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), headers: new Headers(init?.headers) });
      return github.fetch(input, init);
    };
    const body = await importedSkillRequest(
      { action: "import", source: "https://github.com/acme/skills/tree/main/skills/pdf" },
      fetcher,
      undefined,
      async () => ({ token }),
    );
    expect(body).toMatchObject({ action: "create", skill_md: SKILL("pdf") });
    const api = calls.filter((call) => call.url.startsWith("https://api.github.com/"));
    const raw = calls.filter((call) => call.url.startsWith("https://raw.githubusercontent.com/"));
    expect(api.length).toBeGreaterThan(0);
    expect(raw.length).toBeGreaterThan(0);
    expect(api.every((call) => call.headers.get("authorization") === `Bearer ${token}`)).toBe(true);
    expect(raw.every((call) => call.headers.get("authorization") === null)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(token);
    expect(calls.every((call) => !call.url.includes(token))).toBe(true);
  });
});
