// The Windows speech helpers run in Windows PowerShell 5.1 (powershell.exe): on Windows these tests use it, elsewhere
// PowerShell 7 (pwsh) when it is installed.
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const resources = path.join(path.dirname(fileURLToPath(import.meta.url)), "resources");
const CLASSIC = path.join(resources, "speech-helper-windows.ps1");
const ONECORE = path.join(resources, "speech-helper-windows-onecore.ps1");
const shell = process.platform === "win32" ? "powershell.exe" : "pwsh";
const ARGS = ["-NoLogo", "-NoProfile", "-NonInteractive"];
const found = spawnSync(shell, [...ARGS, "-Command", "exit 0"], { stdio: "ignore" }).status === 0;

const quoted = (text) => `'${text.replaceAll("'", "''")}'`;
const run = (command) => execFileSync(shell, [...ARGS, "-Command", command], { encoding: "utf8" }).trim();
const parse = (file) => `[System.Management.Automation.Language.Parser]::ParseFile(${quoted(file)}, [ref]$null, [ref]$errors)`;

describe.skipIf(!found)("Windows speech helper scripts", () => {
  it("parse without errors", () => {
    for (const file of [CLASSIC, ONECORE]) {
      expect(run(`$errors = $null; $null = ${parse(file)}; $errors.Count`)).toBe("0");
    }
  }, 30_000);

  it("the newer speech picks the display language, then the same language in another region, else none", () => {
    const pick = (tags, name) => run([
      `$errors = $null; $ast = ${parse(ONECORE)}`,
      "$fn = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Select-SpeechLanguage' }, $true)",
      ". ([ScriptBlock]::Create($fn.Extent.Text))",
      `$picked = Select-SpeechLanguage @(${tags.map(quoted).join(", ")}) ${quoted(name)}`,
      "if ($null -eq $picked) { '<none>' } else { $picked }",
    ].join("; "));
    expect(pick(["en-US", "pt-PT", "pt-BR"], "pt-BR")).toBe("pt-BR");
    expect(pick(["en-US", "pt-BR"], "pt-PT")).toBe("pt-BR");
    expect(pick(["en-US", "de-DE"], "pt-BR")).toBe("<none>");
    expect(pick([], "pt-BR")).toBe("<none>");
  }, 30_000);

  it.skipIf(process.platform === "win32")("the newer speech exits 3 and writes nothing where Windows speech is missing", () => {
    const result = spawnSync(shell, [...ARGS, "-File", ONECORE], { encoding: "utf8", input: "" });
    expect(result.status).toBe(3);
    expect(result.stdout).toBe("");
  }, 30_000);
});
