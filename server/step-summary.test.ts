import { describe, expect, it } from "vitest";

import { commandTarget, maskAssignments, STEP_TARGET_MAX, toolStep } from "./step-summary.ts";
import { commandSummary, toolDetailPreview } from "./tool-summary.ts";

const claudeBash = (command: string) => ({ title: "Bash", summary: commandSummary({ command }), input: toolDetailPreview({ command }) });

describe("commandTarget", () => {
  it.each([
    ["python3 scrape.py --pages 40", "scrape.py"],
    ["cd ~/projects/biber && python3 scrape.py --pages 40 --out leads.csv", "scrape.py"],
    ["pnpm test", "pnpm test"],
    ["npm run build", "npm run build"],
    ["uv run scripts/report.py", "uv run report.py"],
    ["python -m pytest tests/unit -x", "pytest"],
    ["node ./scripts/build.mjs --prod", "build.mjs"],
    ["bash scripts/deploy.sh staging", "deploy.sh"],
    ["./scrape.py", "scrape.py"],
    ["/bin/zsh -lc 'cd /work && make -j 8 build'", "make build"],
    ["git -C /work/repo status --short", "git status"],
    ["sudo -u www-data python3 /srv/app/migrate.py", "migrate.py"],
    ["timeout -s KILL 300 node crawl.js", "crawl.js"],
    ["cat leads.csv | python analyze.py", "analyze.py"],
    ["curl -sS -H 'Accept: application/json' https://api.github.com/repos/x/y", "curl api.github.com"],
    ["sleep 600", "sleep 600"],
    ["ls -la", "ls"],
    ["(cd web && pnpm build)", "pnpm build"],
    ["powershell.exe -Command \"python C:\\work\\scrape.py\"", "scrape.py"],
    ["python app.py 2>&1 | tee run.log", "app.py"],
  ])("%s → %s", (command, target) => {
    expect(commandTarget(command)).toBe(target);
  });

  it("never names an environment value, even one with no credential shape", () => {
    expect(commandTarget("DATABASE_URL=postgres://ada:hunter2@db/leads REGION=eu python3 scrape.py")).toBe("scrape.py");
    expect(commandTarget("export API_HOST=internal.example && env -i FOO=bar node run.js")).toBe("run.js");
    expect(commandTarget("make deploy STAGE=prod")).toBe("make deploy");
  });

  it("keeps a long name to the cap", () => {
    const target = commandTarget(`python3 ${"very_long_script_name_".repeat(6)}.py`)!;
    expect(target.length).toBeLessThanOrEqual(STEP_TARGET_MAX);
    expect(target.endsWith("…")).toBe(true);
  });
});

describe("maskAssignments", () => {
  it("keeps each name and drops its value", () => {
    expect(maskAssignments("FOO=bar BAZ=\"two words\" python x.py --flag=keep")).toBe("FOO=… BAZ=… python x.py --flag=keep");
    expect(maskAssignments("export TOKEN=abc && make PROFILE=release")).toBe("export TOKEN=… && make PROFILE=…");
  });
});

describe("toolStep", () => {
  it("names a command by its program and target, with the whole command for the hover", () => {
    expect(toolStep(claudeBash("cd ~/projects/biber && python3 scrape.py --pages 40"))).toEqual({
      activity: "command", target: "scrape.py", detail: "cd ~/projects/biber && python3 scrape.py --pages 40",
    });
    expect(toolStep(claudeBash("pnpm test"))).toEqual({ activity: "command", target: "pnpm test" });
  });

  it("sends no secret and no environment value, only redacted text", () => {
    const step = toolStep(claudeBash("OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123 SECRET=hunter2 curl -H 'Authorization: Bearer abcdefghijklmnop123456' https://api.example.com/v1/run?token=abcdefgh12345678"));
    const shown = JSON.stringify(step);
    expect(step?.target).toBe("curl api.example.com");
    for (const secret of ["sk-proj-abcdefghijklmnopqrstuvwxyz0123", "hunter2", "abcdefghijklmnop123456", "abcdefgh12345678"]) {
      expect(shown).not.toContain(secret);
    }
    expect(step?.detail).toContain("OPENAI_API_KEY=… SECRET=… curl");
  });

  it("redacts again whatever reaches it, a query and a page too", () => {
    const raw = "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456' https://api.example.com/run";
    expect(JSON.stringify(toolStep({ title: "Bash", summary: raw }))).not.toContain("abcdefghijklmnopqrstuvwxyz123456");
    expect(JSON.stringify(toolStep({ title: "WebSearch", input: JSON.stringify({ query: "token sk-ant-abcdefghijklmnopqrstuvwx leaked" }) }))).not.toContain("sk-ant-abcdefghijklmnopqrstuvwx");
    expect(JSON.stringify(toolStep({ title: "WebFetch", input: JSON.stringify({ url: "https://ada:hunter2secret@example.org/a?token=abcdefgh12345678" }) })))
      .not.toMatch(/hunter2secret|abcdefgh12345678/);
  });

  it("caps the hover text", () => {
    const step = toolStep(claudeBash(`python3 scrape.py ${"--page 1 ".repeat(80)}`))!;
    expect(step.detail!.length).toBeLessThanOrEqual(200);
  });

  it("reads every engine's call the same way", () => {
    const codexCommand = "/bin/zsh -lc 'python3 scrape.py --pages 40'";
    expect(toolStep({ title: codexCommand, summary: commandSummary({ command: codexCommand }), input: toolDetailPreview({ command: codexCommand, cwd: "/w" }) })?.target).toBe("scrape.py");
    const acp = { command: "python3 scrape.py", description: "Scrape" };
    expect(toolStep({ title: "python3 scrape.py", summary: commandSummary(acp), input: toolDetailPreview(acp) })?.target).toBe("scrape.py");
    expect(toolStep({ title: "WebSearch", input: toolDetailPreview({ query: "Biber Dammbau" }) })).toEqual({ activity: "web", target: "Biber Dammbau" });
    expect(toolStep({ title: "web_search", input: toolDetailPreview("Biber Dammbau") })).toEqual({ activity: "web", target: "Biber Dammbau" });
    expect(toolStep({ title: "google_web_search", input: toolDetailPreview({ query: "Biber Dammbau" }) })?.target).toBe("Biber Dammbau");
    expect(toolStep({ title: "WebFetch", input: toolDetailPreview({ url: "https://www.linkedin.com/company/biber/about?trk=x", prompt: "Summarise" }) }))
      .toEqual({ activity: "fetch", target: "linkedin.com", detail: "linkedin.com/company/biber/about" });
    expect(toolStep({ title: "web_fetch", input: toolDetailPreview({ url: "https://ada:pw@example.org/" }) })).toEqual({ activity: "fetch", target: "example.org" });
    expect(toolStep({ title: "Write", input: toolDetailPreview({ file_path: "/work/report.md", content: "x" }) })).toEqual({ activity: "write", target: "report.md" });
    expect(toolStep({ title: "edit", input: toolDetailPreview([{ path: "/w/web/index.html", kind: { type: "update" }, diff: "-a\n+b" }]) }))
      .toEqual({ activity: "edit", target: "index.html" });
  });

  it("cuts a long query to the cap and keeps the rest for the hover", () => {
    const query = "Biber Dammbau Genehmigung Niedersachsen Landkreis Wolfsburg Bauantrag Fristen 2026";
    const step = toolStep({ title: "WebSearch", input: toolDetailPreview({ query }) })!;
    expect(step.target.length).toBeLessThanOrEqual(STEP_TARGET_MAX);
    expect(step.detail).toBe(query);
  });

  it("says nothing it cannot read", () => {
    expect(toolStep({ title: "mcp__agents__ask_bot", input: toolDetailPreview({ bot: "Kai" }) })).toBeUndefined();
    expect(toolStep({ title: "WebFetch", input: toolDetailPreview({ url: "file:///etc/passwd" }) })).toBeUndefined();
    expect(toolStep({ title: "WebSearch" })).toBeUndefined();
  });
});
