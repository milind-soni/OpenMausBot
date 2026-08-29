import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";

interface Rule {
  readonly id: string;
  readonly pattern: RegExp;
  readonly severity: "credential" | "privacy";
}

interface Finding {
  readonly rule: string;
  readonly severity: Rule["severity"];
  readonly file: string;
  readonly line: number;
  readonly preview: string;
}

const roots = [
  resolve("artifacts/centipede-0.2.0"),
  resolve("artifacts/agent-centipede-benchmark"),
];
const output = resolve("artifacts/centipede-0.2.0/privacy/public-artifact-scan.json");
const textExtensions = new Set([".json", ".md", ".txt", ".log", ".ndjson", ".xml"]);
const rules: readonly Rule[] = [
  { id: "private-key", severity: "credential", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u },
  { id: "bearer-token", severity: "credential", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/u },
  { id: "agent-pairing-token", severity: "credential", pattern: /\bomb_(?:device|pair)_[A-Za-z0-9_-]{16,}/u },
  { id: "provider-key-prefix", severity: "credential", pattern: /\b(?:sk-(?:live|proj)?-?|ghp_|github_pat_|xox[baprs]-|AIza)[A-Za-z0-9_-]{16,}/u },
  { id: "jwt", severity: "credential", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u },
  { id: "credential-field", severity: "credential", pattern: /["'](?:access[_-]?token|refresh[_-]?token|api[_-]?key|password|client[_-]?secret|private[_-]?key)["']\s*:\s*["'][^"']{8,}["']/iu },
  { id: "windows-user-path", severity: "privacy", pattern: /[A-Za-z]:\\Users\\[^\\\s"']+/iu },
  { id: "non-fixture-email", severity: "privacy", pattern: /\b[A-Z0-9._%+-]+@(?!example\.com\b)[A-Z0-9.-]+\.[A-Z]{2,}\b/iu },
  { id: "phone-number", severity: "privacy", pattern: /(?<!\d)(?:\+?1[ .-]?)?\(?[2-9]\d{2}\)?[ .-]\d{3}[ .-]\d{4}(?!\d)/u },
];

async function filesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(path));
    else if (entry.isFile() && textExtensions.has(extname(entry.name).toLowerCase())) files.push(path);
  }
  return files;
}

function safePreview(line: string): string {
  return line.trim().slice(0, 120).replaceAll(/(?:[A-Za-z0-9+/=_-]{20,})/gu, "<REDACTED-LONG-VALUE>");
}

const findings: Finding[] = [];
const files = (await Promise.all(roots.map(filesBelow))).flat().filter((file) => file !== output);
for (const file of files) {
  const lines = (await readFile(file, "utf8")).split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    for (const rule of rules) {
      if (rule.pattern.test(line)) {
        findings.push({
          rule: rule.id,
          severity: rule.severity,
          file: relative(process.cwd(), file).replaceAll("\\", "/"),
          line: index + 1,
          preview: safePreview(line),
        });
      }
    }
  }
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  scanner: "agent-centipede-proof-scanner/1",
  roots: roots.map((root) => relative(process.cwd(), root).replaceAll("\\", "/")),
  filesScanned: files.length,
  rules: rules.map(({ id, severity }) => ({ id, severity })),
  allowList: ["recipient@example.com", "synthetic fixture identifiers", "loopback addresses"],
  passed: findings.length === 0,
  findingCount: findings.length,
  findings,
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.passed) process.exitCode = 1;
