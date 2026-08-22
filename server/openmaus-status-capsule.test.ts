import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { openMausStatusSystemPrompt, readOpenMausStatus } from "./openmaus-status-capsule.ts";
import type { JsonObject, JsonValue } from "./schema.ts";

const NOW = new Date("2026-08-22T06:30:00Z");
const OLD_SINGLE_VIEW_SHA = `sha256:${"1".repeat(64)}`;
const DUAL_VIEW_SHA = `sha256:${"2".repeat(64)}`;
const roots: string[] = [];
const jsonObjectSchema = z.record(z.string(), z.custom<JsonValue>());
const posixOnly = describe.skipIf(process.getuid === undefined);

interface TestCapsule extends JsonObject {
  schema: string;
  observed_at: string;
  fresh_until: string;
  ttl_seconds: number;
  source_sha256: string | null;
  dual_view_sha256: string | null;
  refresh_status: string;
  runtime_state: string;
  mode: string;
  max_instances: number | null;
  ready_count: number;
  slots: JsonObject[];
  ui: JsonObject;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function canonicalValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalValue);
  const parsedObject = jsonObjectSchema.safeParse(value);
  if (!parsedObject.success) return value;
  const sorted: JsonObject = {};
  for (const key of Object.keys(parsedObject.data).sort()) {
    const child = parsedObject.data[key];
    if (child !== undefined) sorted[key] = canonicalValue(child);
  }
  return sorted;
}

function canonical(value: JsonValue): string {
  return JSON.stringify(canonicalValue(value));
}

function sign(value: TestCapsule): TestCapsule {
  const signed: TestCapsule = { ...value };
  delete signed.receipt_sha256;
  signed.receipt_sha256 = `sha256:${createHash("sha256").update(canonical(signed)).digest("hex")}`;
  return signed;
}

function ui(twoUp: boolean): JsonObject {
  return {
    two_up: twoUp,
    max_visible: twoUp ? 2 : 1,
    max_interactive: 1,
    default_watch_only: twoUp,
  };
}

function successCapsule(options: {
  source?: string | null;
  expected?: string | null;
  twoUp?: boolean;
} = {}): TestCapsule {
  const source = options.source === undefined ? DUAL_VIEW_SHA : options.source;
  const expected = options.expected === undefined ? DUAL_VIEW_SHA : options.expected;
  const twoUp = options.twoUp ?? (source !== null && source === expected);
  return sign({
    schema: "aos.openmausbot_status.v1",
    observed_at: "2026-08-22T06:30:00Z",
    fresh_until: "2026-08-22T06:35:00Z",
    ttl_seconds: 300,
    source_sha256: source,
    dual_view_sha256: expected,
    refresh_status: "success",
    runtime_state: "degraded",
    mode: "per-bot",
    max_instances: 2,
    ready_count: 0,
    slots: [
      {
        slot: "vm-1",
        container: "missing",
        readiness: "not_ready",
        network: "unknown",
        security: "unknown",
        persistence: "unknown",
      },
      {
        slot: "vm-2",
        container: "missing",
        readiness: "not_ready",
        network: "unknown",
        security: "unknown",
        persistence: "unknown",
      },
    ],
    ui: ui(twoUp),
  });
}

function failedCapsule(
  reason = "config_unavailable",
  source: string | null = DUAL_VIEW_SHA,
  expected: string | null = DUAL_VIEW_SHA,
): TestCapsule {
  return sign({
    schema: "aos.openmausbot_status.v1",
    observed_at: "2026-08-22T06:30:00Z",
    fresh_until: "2026-08-22T06:35:00Z",
    ttl_seconds: 300,
    source_sha256: source,
    dual_view_sha256: expected,
    refresh_status: "failed",
    failure_reason: reason,
    runtime_state: "unknown",
    mode: "unknown",
    max_instances: null,
    ready_count: 0,
    slots: [],
    ui: ui(false),
  });
}

function cachePath(capsule: TestCapsule): string {
  const root = mkdtempSync(join(tmpdir(), "openmaus-status-"));
  roots.push(root);
  const parent = join(root, "openmausbot");
  mkdirSync(parent, { mode: 0o700 });
  chmodSync(parent, 0o700);
  const path = join(parent, "latest.json");
  writeFileSync(path, `${canonical(capsule)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

posixOnly("readOpenMausStatus", () => {
  it("projects only fresh normalized two-VM capability data", () => {
    const capsule = successCapsule();
    // Cross-language receipt produced by scripts/aos_openmausbot_status.py
    // for this exact normalized fixture.
    expect(capsule.receipt_sha256).toBe(
      "sha256:2f76115fcbf37dfc5406d4a7a460c5e3016ff87184cd9e314bf4cc11022e2d7c",
    );
    const path = cachePath(capsule);

    const status = readOpenMausStatus({ cachePath: path, now: new Date(NOW.getTime() + 1_000) });

    expect(status).toMatchObject({
      freshness: "fresh",
      runtimeState: "degraded",
      mode: "per-bot",
      maxInstances: 2,
      readyCount: 0,
      sourceSha256: DUAL_VIEW_SHA,
      dualViewSha256: DUAL_VIEW_SHA,
      ui: {
        twoUp: true,
        maxVisible: 2,
        maxInteractive: 1,
        defaultWatchOnly: true,
        oneActiveController: true,
      },
    });
    expect(status.slots).toHaveLength(2);
    expect(Object.keys(status.slots[0]).sort()).toEqual(
      ["container", "network", "persistence", "readiness", "security", "slot"],
    );
    const prompt = openMausStatusSystemPrompt({ cachePath: path, now: new Date(NOW.getTime() + 1_000) });
    expect(prompt).toContain("freshness=fresh");
    expect(prompt).toContain("ui.two_up=true");
    expect(prompt).toContain(`source_sha256=${DUAL_VIEW_SHA}`);
    expect(prompt).toContain(`accepted_dual_view_sha256=${DUAL_VIEW_SHA}`);
    expect(prompt).toContain("source_match=true");
    expect(prompt).toContain("one_active_controller=true");
    expect(prompt).not.toMatch(/viewer_url|password|bot-alpha|Private VM Alpha|workspace_path|held=/);
  });

  it.each([
    ["old single-view per-bot app", OLD_SINGLE_VIEW_SHA, DUAL_VIEW_SHA, "source_hash_mismatch"],
    ["mismatched dual build", `sha256:${"3".repeat(64)}`, DUAL_VIEW_SHA, "source_hash_mismatch"],
    ["unavailable installed hash", null, DUAL_VIEW_SHA, "source_hash_unavailable"],
    ["unavailable expected hash", DUAL_VIEW_SHA, null, "source_hash_unavailable"],
  ])("turns %s state into unknown", (_label, source, expected, reason) => {
    const path = cachePath(failedCapsule(reason, source, expected));

    const status = readOpenMausStatus({ cachePath: path, now: new Date(NOW.getTime() + 1_000) });

    expect(status.freshness).toBe("fresh");
    expect(status.reason).toBe("refresh_failed");
    expect(status.runtimeState).toBe("unknown");
    expect(status.readyCount).toBe(0);
    expect(status.slots).toEqual([]);
    expect(status.ui).toMatchObject({ twoUp: false, maxVisible: 1, defaultWatchOnly: false });
  });

  it("rejects a signed success capsule whose installed and accepted hashes differ", () => {
    const path = cachePath(successCapsule({
      source: OLD_SINGLE_VIEW_SHA,
      expected: DUAL_VIEW_SHA,
      twoUp: false,
    }));

    expect(readOpenMausStatus({ cachePath: path, now: NOW })).toMatchObject({
      freshness: "unknown",
      reason: "invalid",
      runtimeState: "unknown",
      readyCount: 0,
      slots: [],
      ui: { twoUp: false },
    });
  });

  it("accepts more configured VM bots than the simultaneous instance limit", () => {
    const capsule = successCapsule({ twoUp: false });
    capsule.max_instances = 1;
    const path = cachePath(sign(capsule));

    const status = readOpenMausStatus({ cachePath: path, now: new Date(NOW.getTime() + 1_000) });

    expect(status).toMatchObject({
      freshness: "fresh",
      maxInstances: 1,
      readyCount: 0,
      ui: { twoUp: false, maxVisible: 1 },
    });
    expect(status.slots).toHaveLength(2);
  });

  it("turns stale, future-skewed, failed, and receipt-tampered state into unknown", () => {
    const path = cachePath(successCapsule());
    expect(readOpenMausStatus({ cachePath: path, now: new Date("2026-08-22T06:35:00Z") })).toMatchObject({
      freshness: "stale", reason: "stale", runtimeState: "unknown", readyCount: 0,
      ui: { twoUp: false },
    });
    expect(readOpenMausStatus({ cachePath: path, now: new Date("2026-08-22T06:29:59Z") })).toMatchObject({
      freshness: "unknown", reason: "clock_skew", runtimeState: "unknown", readyCount: 0,
    });

    const failurePath = cachePath(failedCapsule());
    expect(readOpenMausStatus({ cachePath: failurePath, now: new Date(NOW.getTime() + 1_000) })).toMatchObject({
      freshness: "fresh", reason: "refresh_failed", runtimeState: "unknown", readyCount: 0,
      ui: { twoUp: false },
    });

    const tampered = successCapsule();
    tampered.ready_count = 1;
    const tamperedPath = cachePath(tampered);
    expect(readOpenMausStatus({ cachePath: tamperedPath, now: new Date(NOW.getTime() + 1_000) })).toMatchObject({
      freshness: "unknown", reason: "invalid", runtimeState: "unknown", readyCount: 0,
    });
  });

  it("rejects signed extra fields, insecure modes, and same-path symlinks", () => {
    const extra = successCapsule();
    extra.viewer_url = "http://127.0.0.1:62001/private";
    const extraPath = cachePath(sign(extra));
    expect(readOpenMausStatus({ cachePath: extraPath, now: NOW }).reason).toBe("invalid");

    const insecurePath = cachePath(successCapsule());
    chmodSync(insecurePath, 0o644);
    expect(readOpenMausStatus({ cachePath: insecurePath, now: NOW }).reason).toBe("missing_or_insecure");

    const targetPath = cachePath(successCapsule());
    const linkPath = join(dirname(targetPath), "latest-link.json");
    symlinkSync(targetPath, linkPath);
    expect(readOpenMausStatus({ cachePath: linkPath, now: NOW }).reason).toBe("missing_or_insecure");
  });

  it("rejects a non-0700 parent and a symlinked parent", () => {
    const looseParentPath = cachePath(successCapsule());
    chmodSync(dirname(looseParentPath), 0o755);
    expect(readOpenMausStatus({ cachePath: looseParentPath, now: NOW }).reason).toBe("missing_or_insecure");

    const targetPath = cachePath(successCapsule());
    const linkRoot = mkdtempSync(join(tmpdir(), "openmaus-status-parent-link-"));
    roots.push(linkRoot);
    const linkedParent = join(linkRoot, "openmausbot");
    symlinkSync(dirname(targetPath), linkedParent, "dir");
    expect(
      readOpenMausStatus({ cachePath: join(linkedParent, "latest.json"), now: NOW }).reason,
    ).toBe("missing_or_insecure");
  });
});

it.skipIf(process.getuid !== undefined)(
  "fails closed when POSIX owner and mode checks are unavailable",
  () => {
    const path = cachePath(successCapsule());
    expect(readOpenMausStatus({ cachePath: path, now: NOW })).toMatchObject({
      freshness: "unknown",
      reason: "missing_or_insecure",
      runtimeState: "unknown",
      mode: "unknown",
      maxInstances: null,
      readyCount: 0,
      slots: [],
      ui: {
        twoUp: false,
        maxVisible: 1,
        defaultWatchOnly: false,
      },
    });
    expect(openMausStatusSystemPrompt({ cachePath: path, now: NOW })).toContain(
      "runtime_state=unknown",
    );
  },
);
