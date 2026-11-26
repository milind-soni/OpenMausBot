import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { Agent, type Socket } from "../src/agent.ts";
import { clearSecrets, errorText, redact, redactError } from "../src/log.ts";
import type { JobReply } from "../src/protocol.ts";
import { StateStore } from "../src/state.ts";

describe("connector secret redaction", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "omb-connector-redaction-"));
    clearSecrets();
  });

  afterEach(() => {
    clearSecrets();
    rmSync(dir, { recursive: true, force: true });
  });

  it("restores redaction for persisted secrets on state load after restart", () => {
    const sentinelSecret = "SENTINEL_BOOTSTRAP_SECRET_12345";
    const sentinelToken = "SENTINEL_TOKEN_ABCDEF_98765";

    // First process run: saves home environment with secrets
    const firstState = new StateStore(dir);
    firstState.saveHomeEnv({
      OMB_CLOUD_IMAGE: "example/image:v1",
      OMB_CLOUD_BOOTSTRAP_SECRET: sentinelSecret,
      OMB_AGENT_TOKEN: sentinelToken,
    });

    // Simulate restart: clear in-memory secrets registry
    clearSecrets();
    expect(redact(`failure with ${sentinelSecret}`)).toContain(sentinelSecret);

    // Second process run: loads persisted state from disk
    const reloadedState = new StateStore(dir);
    const loadedEnv = reloadedState.homeEnv();
    expect(loadedEnv).not.toBeNull();

    // After loading, all secrets from persisted env must be redacted
    const testLog = `Failed to start container with ${sentinelSecret} and token ${sentinelToken}`;
    const redacted = redact(testLog);
    expect(redacted).not.toContain(sentinelSecret);
    expect(redacted).not.toContain(sentinelToken);
    expect(redacted).toContain("[secret]");
  });

  it("redacts encoded variants (URL-encoded and JSON-escaped)", () => {
    const complexSecret = "SECRET_WITH/SLASH+PLUS&AMP=123";
    const state = new StateStore(dir);
    state.saveHomeEnv({
      OMB_TEST_SECRET: complexSecret,
    });

    // Raw
    expect(redact(`Error: ${complexSecret}`)).not.toContain(complexSecret);
    // URL-encoded
    const urlEncoded = encodeURIComponent(complexSecret);
    expect(redact(`Error: ${urlEncoded}`)).not.toContain(urlEncoded);
    // JSON-escaped
    const jsonEscaped = JSON.stringify(complexSecret).slice(1, -1);
    expect(redact(`Error: ${jsonEscaped}`)).not.toContain(jsonEscaped);
  });

  it("does not over-redact non-secret keys or values shorter than 8 characters", () => {
    const state = new StateStore(dir);
    state.saveHomeEnv({
      SHORT_SECRET: "short",
      PORT: "8080",
      PUBLIC_HOST: "home.example.com",
    });

    const output = redact("listening on home.example.com:8080");
    expect(output).toBe("listening on home.example.com:8080");
  });

  it("redactError sanitizes error message, stack, and strips raw config", () => {
    const secret = "SECRET_KEY_FOR_DOCKER_CONTAINER_12345";
    const state = new StateStore(dir);
    state.saveHomeEnv({ OMB_CLOUD_BOOTSTRAP_SECRET: secret });

    const err = new Error(`Connection failed with secret=${secret}`);
    (err as unknown as { config: { secretKey: string } }).config = { secretKey: secret };

    const sanitized = redactError(err);
    expect(sanitized.message).not.toContain(secret);
    expect(sanitized.message).toContain("[secret]");
    expect((sanitized as unknown as { config?: unknown }).config).toBeUndefined();
  });

  it("redacts secrets at the Agent.reply boundary when sending error replies", () => {
    const secret = "SENTINEL_OUTPUT_SECRET_54321";
    const state = new StateStore(dir);
    state.saveHomeEnv({ OMB_CLOUD_BOOTSTRAP_SECRET: secret });

    const mockSocket: Socket = {
      readyState: 1,
      bufferedAmount: 0,
      binaryType: "arraybuffer",
      send() {},
      close() {},
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };

    const agent = new Agent({
      socket: () => mockSocket,
      nextCount: () => 1,
      identity: () => ({
        version: 2,
        admin: "admin.example.com",
        boxId: "box1",
        teamId: "team1",
        publicKey: "pub",
        privateKey: "priv",
        adminKeys: {},
        enrolledAt: 1234,
      }),
      log: () => {},
      handle: async () => null,
      heartbeat: async () => ({ heartbeat: { host: {} as never, home: {} as never, connector: {} as never } }),
    });

    // Directly invoke reply
    const reply: JobReply = {
      id: "job-1",
      ok: false,
      error: {
        code: "docker",
        message: `Internal failure exposing raw secret: ${secret}`,
      },
    };

    agent.reply(reply);

    // The reply in agent's internal store should be redacted
    const internal = agent as unknown as { replies: Map<string, JobReply>; unacked: Map<string, { text: string }> };
    const stored = internal.replies.get("job-1");
    expect(stored && !stored.ok && stored.error.message).not.toContain(secret);
    expect(stored && !stored.ok && stored.error.message).toContain("[secret]");

    // The unacked message should also be redacted
    const unacked = internal.unacked.get("job-1");
    expect(unacked?.text).not.toContain(secret);
    expect(unacked?.text).toContain("[secret]");
  });

  it("covers update/rollback error paths when errors carry secrets", () => {
    const rollbackSecret = "SENTINEL_ROLLBACK_SECRET_99999";
    const state = new StateStore(dir);
    state.saveHomeEnv({ OMB_CLOUD_BOOTSTRAP_SECRET: rollbackSecret });

    const error = new Error(`Docker error during rollback with secret=${rollbackSecret}`);
    const logged = errorText(error);

    expect(logged).not.toContain(rollbackSecret);
    expect(logged).toContain("[secret]");
  });
});
