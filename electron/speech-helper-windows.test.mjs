// The Windows speech helpers run in Windows PowerShell 5.1 (powershell.exe): on Windows these tests use it, elsewhere
// PowerShell 7 (pwsh) when it is installed.
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
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

// What a Windows runner can check without a microphone or a speech pack: the newer speech's types load in Windows
// PowerShell 5.1, the desktop helper hands over in the same session, and the newer helper never hangs or writes when it
// cannot listen.
describe.skipIf(!found || process.platform !== "win32")("Windows speech helpers in Windows PowerShell", () => {
  it("the newer speech finds both task helpers wherever its Windows types load", () => {
    const answer = run([
      `$errors = $null; $ast = ${parse(ONECORE)}`,
      "try { Add-Type -AssemblyName System.Runtime.WindowsRuntime; $null = [Windows.Media.SpeechRecognition.SpeechRecognizer, Windows.Media.SpeechRecognition, ContentType = WindowsRuntime] } catch { 'no-winrt'; exit 0 }",
      "foreach ($name in 'asTask', 'asTaskAction', 'asTaskOperation') { $stmt = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.AssignmentStatementAst] -and $node.Left.VariablePath.UserPath -eq $name }, $true); . ([ScriptBlock]::Create($stmt.Extent.Text)) }",
      "\"$($null -ne $asTaskAction) $($null -ne $asTaskOperation)\"",
    ].join("; "));
    expect(["True True", "no-winrt"]).toContain(answer);
  }, 60_000);

  it("the desktop helper hands a language it has no recognizer for to the newer speech in its own session", () => {
    const has = run([
      "Add-Type -AssemblyName System.Speech",
      "try { $installed = @([System.Speech.Recognition.SpeechRecognitionEngine]::InstalledRecognizers()) } catch { $installed = @() }",
      "$culture = [System.Globalization.CultureInfo]::CurrentUICulture",
      "$match = @($installed | Where-Object { $_.Culture.TwoLetterISOLanguageName -eq $culture.TwoLetterISOLanguageName })",
      "\"$($match.Count) $($installed.Count)\"",
    ].join("; "));
    const [matching, installed] = has.split(" ").map(Number);
    if (matching > 0) return; // this runner's display language has a desktop recognizer: the hand-over never happens
    const dir = mkdtempSync(path.join(os.tmpdir(), "omb-speech-"));
    try {
      copyFileSync(CLASSIC, path.join(dir, "speech-helper.ps1"));
      const helper = (stub) => {
        writeFileSync(path.join(dir, "speech-helper-onecore.ps1"), stub);
        return spawnSync(shell, [...ARGS, "-ExecutionPolicy", "Bypass", "-File", path.join(dir, "speech-helper.ps1")], { encoding: "utf8", input: "", timeout: 60_000 });
      };
      const heard = helper("param([int]$EndpointMs = 0)\nSend-Line @{ partial = $false; text = (Join-Text 'from' 'onecore') }\nexit 0\n");
      expect(heard.status).toBe(0);
      expect(JSON.parse(heard.stdout.trim())).toEqual({ partial: false, text: "from onecore" });
      if (installed === 0) {
        const missing = helper("param([int]$EndpointMs = 0)\nexit 3\n");
        expect(missing.status).toBe(1);
        expect(JSON.parse(missing.stdout.trim())).toEqual({ error: "speech-language-missing" });
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it("the newer speech ends by itself with nothing written when it cannot listen or its input closes", () => {
    const result = spawnSync(shell, [...ARGS, "-ExecutionPolicy", "Bypass", "-File", ONECORE], { encoding: "utf8", input: "", timeout: 90_000 });
    expect(result.error).toBeUndefined();
    expect([0, 3]).toContain(result.status);
    expect(result.stdout).toBe("");
  }, 120_000);
});
