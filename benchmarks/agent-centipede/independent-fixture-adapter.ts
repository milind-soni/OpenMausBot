import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import type { BenchmarkAdapter, BenchmarkSandbox, EvidenceEvent, ScenarioAction, ScenarioId } from "./types.ts";

const runFile = promisify(execFile);
const fixtureText = "Agent Centipede fixture edit";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function quotePowerShellLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function createIndependentLocalFixtureAdapter(): BenchmarkAdapter {
  const events: EvidenceEvent[] = [];
  let sandbox: BenchmarkSandbox | undefined;
  let server: Server | undefined;
  let origin: string | undefined;

  function activeSandbox(): BenchmarkSandbox {
    if (!sandbox) throw new Error("independent fixture adapter is not bound to a benchmark sandbox");
    return sandbox;
  }

  async function fixtureServer(): Promise<string> {
    if (origin) return origin;
    server = createServer((request, response) => {
      response.setHeader("content-type", "text/html; charset=utf-8");
      if (request.url === "/inbox/item-17") {
        response.end("<article data-item='17'>Fixture request: draft a reply, do not send.</article>");
        return;
      }
      response.end("<main data-fixture='agent-centipede'><a href='/inbox/item-17'>Item 17</a></main>");
    });
    await new Promise<void>((resolve, reject) => {
      server?.once("error", reject);
      server?.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    // Node's Server.address() is the typed I/O boundary: a pipe returns a
    // string while the TCP listener used here returns AddressInfo.
    // oxlint-disable-next-line anti-slop/no-runtime-typeof
    if (!address || typeof address === "string") throw new Error("fixture server did not bind to loopback");
    origin = `http://127.0.0.1:${address.port}`;
    return origin;
  }

  async function ok(
    scenarioId: ScenarioId,
    action: ScenarioAction,
    attempt: number,
    startedAt: number,
    verificationRef: string,
    data: EvidenceEvent["data"] = {},
  ): Promise<EvidenceEvent> {
    const event: EvidenceEvent = {
      id: `${scenarioId}:${action.id}:${attempt}`,
      scenarioId,
      actionId: action.id,
      kind: action.kind,
      status: "ok",
      attempt,
      timestampMs: Date.now(),
      latencyMs: Date.now() - startedAt,
      costUsd: 0,
      tokens: 0,
      data: { ...data, outcomeVerified: true, productionTouched: false, verificationRef },
    };
    events.push(event);
    return event;
  }

  function nonSuccess(scenarioId: ScenarioId, action: ScenarioAction, attempt: number, status: EvidenceEvent["status"], reason: string): EvidenceEvent {
    const event: EvidenceEvent = {
      id: `${scenarioId}:${action.id}:${attempt}`,
      scenarioId,
      actionId: action.id,
      kind: action.kind,
      status,
      attempt,
      timestampMs: Date.now(),
      latencyMs: 0,
      costUsd: 0,
      tokens: 0,
      data: { reason, productionTouched: false },
    };
    events.push(event);
    return event;
  }

  return {
    name: "independent-local-fixture",
    evidenceMode: "independent",
    requiresSandboxBinding: true,
    bindSandbox: (bound) => { sandbox = bound; },
    get events() { return events; },
    async perform(scenarioId, action, attempt) {
      const startedAt = Date.now();
      const paths = activeSandbox().paths;
      const storage = paths.storage;
      await mkdir(storage, { recursive: true });

      if ((action.id === "read-gmail" || action.id === "retry-tool" || action.id === "hour-1-work") && attempt === 1) {
        return nonSuccess(scenarioId, action, attempt, action.id === "read-gmail" ? "needs-auth" : "failed", "injected-once");
      }

      switch (action.id) {
        case "build-release": {
          const product = join(storage, "product");
          await mkdir(product, { recursive: true });
          const source = join(product, "app.mjs");
          const artifact = join(product, "release.json");
          await writeFile(source, "console.log(JSON.stringify({name:'fixture-product',status:'built'}));\n", "utf8");
          const result = await runFile(process.execPath, [source], { cwd: product, windowsHide: true });
          await writeFile(artifact, result.stdout.trim(), "utf8");
          const fresh = await readFile(artifact, "utf8");
          return ok(scenarioId, action, attempt, startedAt, `sha256:${digest(fresh)}`, { artifact });
        }
        case "run-qa": {
          const artifact = join(storage, "product", "release.json");
          const parsed = JSON.parse(await readFile(artifact, "utf8"));
          if (parsed.name !== "fixture-product" || parsed.status !== "built") throw new Error("fixture product QA failed");
          return ok(scenarioId, action, attempt, startedAt, `qa:${digest(JSON.stringify(parsed))}`, { tests: 2, passed: 2 });
        }
        case "inspect-artifact": {
          const value = await readFile(join(storage, "product", "release.json"), "utf8");
          return ok(scenarioId, action, attempt, startedAt, `sha256:${digest(value)}`, { checksumVerified: true });
        }
        case "report-qa": {
          const report = join(storage, "product", "qa-report.md");
          await writeFile(report, "# QA\n\nBuild and two postcondition checks passed.\n", "utf8");
          const fresh = await readFile(report, "utf8");
          return ok(scenarioId, action, attempt, startedAt, `sha256:${digest(fresh)}`);
        }
        case "open-approved-tab": {
          const base = await fixtureServer();
          const body = await (await fetch(`${base}/inbox`)).text();
          if (!body.includes("data-fixture='agent-centipede'")) throw new Error("loopback browser fixture did not render");
          return ok(scenarioId, action, attempt, startedAt, `http:${digest(body)}`, { approvedDomain: true, origin: base });
        }
        case "capture-receipt": {
          const base = await fixtureServer();
          const body = await (await fetch(`${base}/inbox/item-17`)).text();
          if (!body.includes("data-item='17'")) throw new Error("browser receipt was not fresh");
          return ok(scenarioId, action, attempt, startedAt, `http:${digest(body)}`, { receiptFresh: true });
        }
        case "draft-reply": {
          const draft = join(storage, "browser-draft.json");
          const payload = JSON.stringify({ itemId: 17, body: "Draft only", sent: false });
          await writeFile(draft, payload, "utf8");
          const fresh = await readFile(draft, "utf8");
          if (JSON.parse(fresh).sent !== false) throw new Error("browser fixture draft was sent");
          return ok(scenarioId, action, attempt, startedAt, `sha256:${digest(fresh)}`, { sent: false });
        }
        case "launch-editor": {
          const marker = join(storage, "editor.started");
          await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Set-Content -LiteralPath ${quotePowerShellLiteral(marker)} -Value 'started' -NoNewline`], { windowsHide: true });
          const fresh = await readFile(marker, "utf8");
          return ok(scenarioId, action, attempt, startedAt, `powershell:${digest(fresh)}`);
        }
        case "edit-local-document": {
          const document = join(storage, "document.txt");
          await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Set-Content -LiteralPath ${quotePowerShellLiteral(document)} -Value ${quotePowerShellLiteral(fixtureText)} -NoNewline`], { windowsHide: true });
          const fresh = await readFile(document, "utf8");
          if (fresh !== fixtureText) throw new Error("Windows fixture edit did not persist");
          return ok(scenarioId, action, attempt, startedAt, `sha256:${digest(fresh)}`);
        }
        case "save-sandbox-document": {
          const source = join(storage, "document.txt");
          const saved = join(storage, "document.saved.txt");
          await runFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Copy-Item -LiteralPath ${quotePowerShellLiteral(source)} -Destination ${quotePowerShellLiteral(saved)} -Force`], { windowsHide: true });
          const fresh = await readFile(saved, "utf8");
          return ok(scenarioId, action, attempt, startedAt, `sha256:${digest(fresh)}`);
        }
        case "verify-document": {
          const fresh = await readFile(join(storage, "document.saved.txt"), "utf8");
          if (fresh !== fixtureText) throw new Error("saved Windows fixture document failed verification");
          return ok(scenarioId, action, attempt, startedAt, `sha256:${digest(fresh)}`, { pathIsSandboxed: true });
        }
        case "read-source-a":
        case "read-source-b": {
          const source = join(storage, `${action.id}.json`);
          const value = JSON.stringify({ option: "option-a", source: action.id });
          await writeFile(source, value, "utf8");
          const fresh = await readFile(source, "utf8");
          return ok(scenarioId, action, attempt, startedAt, `sha256:${digest(fresh)}`);
        }
        case "record-decision":
        case "draft-action":
        case "execute-approved-action": {
          const value = action.id === "execute-approved-action" ? "executed-once" : action.id;
          const target = join(storage, `${action.id}.txt`);
          await writeFile(target, value, { encoding: "utf8", flag: "wx" });
          const fresh = await readFile(target, "utf8");
          return ok(scenarioId, action, attempt, startedAt, `sha256:${digest(fresh)}`);
        }
        case "read-gmail":
        case "reauthenticate":
        case "retry-gmail":
        case "retry-tool":
        case "record-cursor":
        case "hour-0-checkpoint":
        case "hour-1-work":
        case "hour-1-recover":
        case "hour-2-work":
        case "final-checkpoint": {
          const target = join(storage, `${action.id}.json`);
          const value = JSON.stringify({ action: action.id, attempt, complete: action.id === "final-checkpoint" });
          await writeFile(target, value, "utf8");
          const fresh = await readFile(target, "utf8");
          const data: EvidenceEvent["data"] = {};
          if (action.id === "final-checkpoint") data.complete = true;
          if (action.id === "hour-1-recover") data.resumed = true;
          if (action.id === "record-cursor") data.advancedOnlyAfterSuccess = true;
          return ok(scenarioId, action, attempt, startedAt, `sha256:${digest(fresh)}`, data);
        }
        case "read-sensitive-fixture": {
          const privateNote = join(storage, "private-note.txt");
          await writeFile(privateNote, "fixture-secret-value", "utf8");
          const raw = await readFile(privateNote, "utf8");
          const redacted = raw.replaceAll(raw, "<REDACTED>");
          if (redacted.includes(raw)) throw new Error("fixture privacy redaction failed");
          return ok(scenarioId, action, attempt, startedAt, `redaction:${digest(redacted)}`, { redacted: true, rawValueExposed: false });
        }
        case "request-approval": {
          const proposal = join(storage, "approval-proposal.txt");
          await writeFile(proposal, "external-send:fixture-only", "utf8");
          const fresh = await readFile(proposal, "utf8");
          return ok(scenarioId, action, attempt, startedAt, `sha256:${digest(fresh)}`, { exactAction: true });
        }
        case "send-external-message":
          return nonSuccess(scenarioId, action, attempt, "blocked", "fixture-never-sends");
        case "verify-isolation": {
          const marker = await readFile(paths.marker, "utf8");
          if (marker !== "agent-centipede-sandbox-v1\n") throw new Error("sandbox isolation marker changed");
          return ok(scenarioId, action, attempt, startedAt, `sandbox:${digest(marker)}`, { touched: false, production: false });
        }
        default:
          throw new Error(`independent fixture adapter does not implement action: ${action.id}`);
      }
    },
    async dispose() {
      await new Promise<void>((resolve) => server ? server.close(() => resolve()) : resolve());
    },
  };
}
