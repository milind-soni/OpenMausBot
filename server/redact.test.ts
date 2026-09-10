// The native log must keep the shape of a session-setup message and lose the
// credential values. These tests use the exact shapes the drivers actually
// write — the ACP `env: [{name,value}]` wire form and the claude mcpServers
// object form — so a change to either shape breaks the test, not the secret.
import { describe, expect, it } from "vitest";

import { redactSecrets } from "./redact.ts";

const flat = (value: unknown) => JSON.stringify(value);

describe("redactSecrets", () => {
  it("masks the tokens in an ACP session/new, keeping the shape", () => {
    const sessionNew = {
      jsonrpc: "2.0",
      id: 3,
      method: "session/new",
      params: {
        cwd: "/Users/someone",
        mcpServers: [
          {
            name: "agents",
            command: "/usr/bin/node",
            args: ["/app/agents-proxy.js"],
            env: [
              { name: "OMB_BOT_ID", value: "bot-123" },
              { name: "OMB_COMMS_TOKEN", value: "s3cret-comms-token-value" },
            ],
          },
          {
            name: "computer",
            command: "/usr/bin/node",
            args: ["/app/computer-proxy.js"],
            env: [
              { name: "OGB_BOX_ID", value: "box-9" },
              { name: "OGB_BOX_TOKEN", value: "box_live_abcdefghijklmnop" },
            ],
          },
        ],
      },
    };

    const out = flat(redactSecrets(sessionNew));

    expect(out).not.toContain("s3cret-comms-token-value");
    expect(out).not.toContain("box_live_abcdefghijklmnop");
    // shape survives: still the same method, servers, names and non-secret env
    expect(out).toContain("session/new");
    expect(out).toContain("OMB_COMMS_TOKEN");
    expect(out).toContain("OGB_BOX_TOKEN");
    expect(out).toContain("bot-123");
    expect(out).toContain("box-9");
    expect(out).toContain("/app/agents-proxy.js");
    // and it says how long the value was, which is what you debug with
    expect(out).toContain("«redacted 24 chars»");
  });

  it("masks a Composio key in an MCP header and an env object", () => {
    const config = {
      mcpServers: {
        composio: {
          type: "http",
          url: "https://app.composio.dev/tool_router/v3/trs_test/mcp",
          headers: { "x-api-key": "ak_live_supersecret" },
        },
        computer: { env: { ELECTRON_RUN_AS_NODE: "1", OGB_BOX_TOKEN: "box_live_zzz" } },
      },
    };

    const out = flat(redactSecrets(config));
    expect(out).not.toContain("ak_live_supersecret");
    expect(out).not.toContain("box_live_zzz");
    expect(out).toContain("app.composio.dev");
    expect(out).toContain("ELECTRON_RUN_AS_NODE");
    expect(out).toContain('"1"'); // a non-secret value is untouched
  });

  it("still content-redacts an ACP env entry whose name is not secret-shaped", () => {
    // A credential can land under an ordinary-looking variable name (a
    // custom env var, a feature flag someone repurposed) — the ACP
    // {name,value} shortcut must not skip the content pass just because
    // the NAME alone doesn't scream "secret".
    const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
    const leaked = `sk-ant-api03-${alpha}`;
    const sessionNew = {
      params: {
        mcpServers: [
          {
            name: "custom",
            env: [
              { name: "SESSION_CONFIG", value: leaked },
              { name: "FEATURE_FLAG", value: "enabled" },
            ],
          },
        ],
      },
    };

    const out = flat(redactSecrets(sessionNew));
    expect(out).not.toContain(leaked);
    expect(out).toContain("SESSION_CONFIG");
    expect(out).toContain("FEATURE_FLAG");
    expect(out).toContain("enabled");
    expect(out).toMatch(/«redacted \d+ chars»/);
  });

  it("leaves ordinary protocol traffic alone", () => {
    const update = {
      method: "session/update",
      params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "the key to this bug" } } },
    };
    expect(redactSecrets(update)).toEqual(update);
  });

  it("does not mangle words that merely contain 'key'", () => {
    const msg = { keyboard: "cmd+k", monkey: "business", keys: "SECRET-LIST", hotkey: "ctrl" };
    const out = redactSecrets(msg) as Record<string, string>;
    expect(out.keyboard).toBe("cmd+k");
    expect(out.monkey).toBe("business");
    expect(out.hotkey).toBe("ctrl");
    // `keys` standing alone IS treated as a credential holder
    expect(out.keys).toContain("redacted");
  });

  it("survives cycles-adjacent depth and non-objects", () => {
    expect(redactSecrets("plain")).toBe("plain");
    expect(redactSecrets(null)).toBe(null);
    expect(redactSecrets(42)).toBe(42);
    let deep: Record<string, unknown> = { token: "deep-secret" };
    for (let i = 0; i < 20; i++) deep = { nested: deep };
    expect(() => redactSecrets(deep)).not.toThrow();
  });
});

import { redactSecretsInText } from "./redact.ts";

// Content-shaped secrets: what a bot's own reply, a tool title, or a
// permission card can carry. High precision on purpose — a false positive
// here rewrites real code in the transcript.
describe("redactSecretsInText", () => {
  it("masks known key prefixes wherever they appear", () => {
    // fixtures are assembled at runtime so no token-shaped literal sits in
    // the source — GitHub's push protection (rightly) flags those
    const alpha = "abcdefghijklmnopqrstuvwxyz0123456789";
    const cases: Array<[string, RegExp]> = [
      [`set ANTHROPIC_API_KEY=sk-ant-api03-${alpha}`, /sk-ant/],
      [`OpenAI: sk-proj-${alpha}ABCD`, /sk-proj/],
      [`gh token ${"gh" + "p_"}${alpha}`, /ghp_/],
      [`fine-grained ${"github_" + "pat_"}11ABCDEFG0${alpha}`, /github_pat_/],
      [`slack ${"xox" + "b-"}${"123456789012"}-${"1234567890123"}-${alpha.slice(0, 24)}`, /xoxb-/],
      [`aws ${"AKIA" + "IOSFODNN7EXAMPLE"} and more`, /IOSFODNN7EXAMPLE/],
      [`google ${"AIza" + "SyA-"}${alpha.slice(0, 32)}`, /AIza/],
      [`npm ${"npm" + "_"}${alpha}`, /npm_[a-z]/],
      [`xai ${"xai-"}${alpha}`, /xai-/],
      [`groq ${"gsk_"}${alpha}ABCD`, /gsk_/],
      [`huggingface ${"hf_"}${alpha}`, /hf_/],
    ];
    for (const [input, leak] of cases) {
      const out = redactSecretsInText(input);
      expect(out, input).not.toMatch(leak);
      expect(out).toMatch(/«redacted \d+ chars»/);
    }
  });

  it.each([
    ["xai-", 20],
    ["gsk_", 40],
    ["hf_", 30],
  ] as const)("bounds %s masking without changing ordinary text", (prefix, minimum) => {
    const key = prefix + "a".repeat(minimum);
    const longer = key + "AB12";
    const text = `before "${key}", ${longer}; after ✓`;
    const expected = `before "«redacted ${key.length} chars»", «redacted ${longer.length} chars»; after ✓`;

    expect(redactSecretsInText(text)).toBe(expected);
    expect(redactSecretsInText(expected)).toBe(expected);
    expect(redactSecrets({ note: text })).toEqual({ note: expected });
    for (const ordinary of [prefix + "a".repeat(minimum - 1), `example_${key}`, `${prefix}example`]) {
      expect(redactSecretsInText(ordinary)).toBe(ordinary);
    }
  });

  it("masks JWTs, PEM private key blocks, and bearer tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(redactSecretsInText(`token ${jwt} ok`)).toBe(`token «redacted ${jwt.length} chars» ok`);
    const pem = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\n-----END OPENSSH PRIVATE KEY-----";
    const out = redactSecretsInText(`here:\n${pem}\ndone`);
    expect(out).not.toContain("b3BlbnNzaC1r");
    expect(out).toMatch(/BEGIN OPENSSH PRIVATE KEY[\s\S]*«redacted \d+ chars»[\s\S]*END OPENSSH PRIVATE KEY/);
    expect(redactSecretsInText('curl -H "Authorization: Bearer abc.def-ghi_jkl123456789"')).toBe('curl -H "Authorization: Bearer «redacted 24 chars»"');
  });

  it("is byte-for-byte idempotent for PEM blocks", () => {
    const privateKeyBody = "c3VwZXItc2VjcmV0LXByaXZhdGUta2V5LWJ5dGVz";
    const pem = [
      "-----BEGIN PRIVATE KEY-----",
      privateKeyBody,
      "-----END PRIVATE KEY-----",
    ].join("\n");
    const once = redactSecretsInText(`before\n${pem}\nafter`);

    expect(redactSecretsInText(once)).toBe(once);
    expect(once).toContain(`«redacted ${privateKeyBody.length} chars»`);
  });

  it("masks the value of a secret-shaped key=value or key: value, keeping the key", () => {
    expect(redactSecretsInText("export DATABASE_PASSWORD=hunter2hunter2")).toBe("export DATABASE_PASSWORD=«redacted 14 chars»");
    expect(redactSecretsInText('{"api_key": "abcd1234efgh5678"}')).toBe('{"api_key": "«redacted 16 chars»"}');
    expect(redactSecretsInText("client_secret: 'zzzz-yyyy-xxxx-1'")).toBe("client_secret: '«redacted 16 chars»'");
    expect(redactSecretsInText("--token=abc123def456")).toBe("--token=«redacted 12 chars»");
  });

  it("masks an assignment to any name ending in KEY, whatever the value looks like", () => {
    expect(redactSecretsInText(`OPENAI_API_KEY=sk-${"a".repeat(20)} pnpm test`)).toBe("OPENAI_API_KEY=«redacted 23 chars» pnpm test");
    expect(redactSecretsInText("X_KEY=value pnpm control:omb doctor")).toBe("X_KEY=«redacted 5 chars» pnpm control:omb doctor");
    expect(redactSecretsInText("export xai-key='abc.def'")).toBe("export xai-key='«redacted 7 chars»'");
  });

  it("masks the password in a URL's userinfo, keeping the user and the host", () => {
    expect(redactSecretsInText("psql postgres://maus:s3cret@db.internal:5432/app")).toBe("psql postgres://maus:«redacted 6 chars»@db.internal:5432/app");
    expect(redactSecretsInText("curl https://user:p%40ss@host/path")).toBe("curl https://user:«redacted 6 chars»@host/path");
  });

  it("masks the value of a secret-naming flag, in both spellings", () => {
    expect(redactSecretsInText("gh auth login --token abc123")).toBe("gh auth login --token «redacted 6 chars»");
    expect(redactSecretsInText("tool --password=hunter2 --api-key 'k1' --secret s")).toBe("tool --password=«redacted 7 chars» --api-key '«redacted 2 chars»' --secret «redacted 1 chars»");
    // a flag followed by another flag has no value to mask
    expect(redactSecretsInText("tool --token --verbose")).toBe("tool --token --verbose");
  });

  it("does not mask ordinary words near those rules", () => {
    for (const s of [
      "hotkey=cmd+k keyboard=qwerty monkey=business",
      "https://host:8080/path and user@host",
      "git log --tokens-are-not-a-flag --passwords",
      "the key: patience",
    ]) {
      expect(redactSecretsInText(s), s).toBe(s);
    }
  });

  it("leaves ordinary text, code, hashes and URLs alone", () => {
    for (const s of [
      "the keyboard shortcut is cmd-k",
      "git commit 3f2a9c1e7b4d5a6f8e9c0b1a2d3e4f5a6b7c8d9e",
      "https://example.com/path?page=2&sort=asc",
      "const token = await getToken(); // fetches later",
      "password: (leave blank to keep the current one)",
      "Bearer tokens are sent in the Authorization header",
      "sk-8", // too short to be a key
    ]) {
      expect(redactSecretsInText(s), s).toBe(s);
    }
  });

  it("is applied to string values inside redactSecrets too", () => {
    const out = redactSecrets({ command: "curl -H 'Authorization: Bearer abcdefghijklmnop'", note: "fine" }) as Record<string, string>;
    expect(out.command).toContain("«redacted");
    expect(out.note).toBe("fine");
  });

  it("is idempotent for structurally identified credentials", () => {
    const input = {
      apiKey: "abcdefgh12345678",
      env: [{ name: "OMB_COMMS_TOKEN", value: "abcdefghijklmnop" }],
    };
    const once = redactSecrets(input);

    expect(redactSecrets(once)).toEqual(once);
  });
});
