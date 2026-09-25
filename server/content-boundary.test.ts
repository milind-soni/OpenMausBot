import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyContentClasses,
  bindContentBoundaryAuditSink,
  bindWorkspaceContentPolicy,
  redactForContentPolicy,
  redactWorkspaceText,
} from "./content-boundary.ts";
import { readThreadEvents } from "./thread-events.ts";
import { redactSecretsInText } from "../shared/redact.ts";

const audit = { botId: "bot-1", threadId: "11111111-1111-4111-8111-111111111111", funnel: "tool-result" } as const;

describe("content-class boundary", () => {
  afterEach(() => {
    bindContentBoundaryAuditSink(undefined);
    bindWorkspaceContentPolicy(() => null);
  });

  it("keeps an unconfigured bot byte-identical to the credential-only scrub, with no events", () => {
    const text = "reachable at jane@example.com from 10.0.0.5 with sk-ant-" + "a".repeat(90);
    const events: unknown[] = [];
    bindContentBoundaryAuditSink((event) => events.push(event));
    expect(redactForContentPolicy(text, undefined, audit)).toBe(redactSecretsInText(text));
    expect(applyContentClasses(text, undefined, audit)).toBe(text);
    expect(events).toEqual([]);
  });

  it("redacts credentials even when every class is loosened, and audits the pass", () => {
    const key = "sk-ant-" + "k".repeat(40);
    const text = "email jane@example.com host db.internal key " + key;
    const events: unknown[] = [];
    bindContentBoundaryAuditSink((event) => events.push(event));
    const out = redactForContentPolicy(text, [], audit);
    expect(out).toContain("jane@example.com");
    expect(out).toContain("db.internal");
    expect(out).not.toContain(key);
    expect(out).toContain("«redacted");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "content.class-passed",
      classes: ["personal", "internal"],
      funnel: "tool-result",
      botId: "bot-1",
      threadId: audit.threadId,
    });
  });

  it("emits audit events the thread log validator accepts", () => {
    const dir = mkdtempSync(join(tmpdir(), "omb-content-audit-"));
    try {
      bindContentBoundaryAuditSink((event) => {
        writeFileSync(join(dir, event.threadId + ".ndjson"), JSON.stringify(event) + "\n");
      });
      redactForContentPolicy("call jane@example.com", [], audit);
      const page = readThreadEvents({ eventsDir: dir, nativeDir: dir, threadId: audit.threadId });
      expect(JSON.stringify(page)).toContain("content.class-passed");
      expect(JSON.stringify(page)).toContain(audit.threadId);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces a loosened class when the audit write fails", () => {
    bindContentBoundaryAuditSink(() => {
      throw new Error("audit disk full");
    });
    // personal is configured, internal is loosened; the failed audit must
    // fail closed by masking the loosened class instead of passing it.
    const out = redactForContentPolicy("mail jane@example.com host corp.internal", ["personal"], audit);
    expect(out).not.toContain("jane@example.com");
    expect(out).not.toContain("corp.internal");
  });

  it("applies the bound workspace policy and audits to the policy thread", () => {
    const events: unknown[] = [];
    bindContentBoundaryAuditSink((event) => events.push(event));
    bindWorkspaceContentPolicy(() => ({ classes: ["personal"], threadId: "t-workspace" }));
    expect(redactWorkspaceText("bot-1", "mail jane@example.com")).not.toContain("jane@example.com");
    expect(redactWorkspaceText("bot-1", "host 10.0.0.5 db.internal")).toBe("host 10.0.0.5 db.internal");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ threadId: "t-workspace", funnel: "memory", classes: ["internal"] });
    bindWorkspaceContentPolicy(() => null);
    expect(redactWorkspaceText("bot-1", "mail jane@example.com")).toBe("mail jane@example.com");
  });
});
