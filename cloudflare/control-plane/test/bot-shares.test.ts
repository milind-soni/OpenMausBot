import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { stringify as stringifyYaml } from "yaml";

import { createAuth } from "../src/auth";
import {
  BOT_SHARE_MAX_PER_OWNER,
  BOT_SHARE_MAX_VERSIONS,
  BOT_SHARE_PACKAGE_MAX_BYTES,
} from "../src/bot-shares";
import { readConfig } from "../src/config";
import worker from "../src/index";

const BASE_URL = "https://auth.openmausbot.test";

async function call(path: string, options: { method?: string; bearer?: string; body?: unknown } = {}) {
  const headers = new Headers();
  if (options.bearer) headers.set("authorization", `Bearer ${options.bearer}`);
  let body: string | undefined;
  if (options.body !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.body);
  }
  const request = new Request(`${BASE_URL}${path}`, { method: options.method ?? "GET", headers, body });
  const ctx = createExecutionContext();
  const response = await worker.fetch(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

async function signIn(email: string) {
  const ctx = createExecutionContext();
  const auth = createAuth(env, ctx, readConfig(env), crypto.randomUUID());
  const otp = await auth.api.createVerificationOTP({ body: { email, type: "sign-in" } });
  await waitOnExecutionContext(ctx);
  const response = await call("/api/auth/sign-in/email-otp", {
    method: "POST",
    body: { email, otp, name: email.split("@", 1)[0] },
  });
  expect(response.status).toBe(200);
  const bearer = response.headers.get("set-auth-token");
  if (!bearer) throw new Error("missing account bearer");
  return bearer;
}

function packageMarkdown(name = "Research Team", summary = "A safe portable team.") {
  const frontmatter = stringifyYaml({
    botmrr: 1,
    id: "research-team",
    release: "1.0.0",
    name,
    tagline: "Research with a small focused team.",
    summary,
    category: "Research",
    author: { name: "OpenMausBot user" },
    license: "Unspecified",
    outcomes: ["Produce a reviewed brief."],
    setupMinutes: 3,
    requirements: { apps: [], capabilities: [] },
    agents: [{
      key: "researcher",
      name: "Researcher",
      title: "Research lead",
      description: "Find and synthesize evidence.",
      appearance: { color: "blue", mascotBody: "star" },
    }],
    chiefOfStaff: "researcher",
  }, { lineWidth: 0 }).trim();
  return `---\n${frontmatter}\n---\n\n## Activation\n\nActivate.\n\n## Mission\n\n${summary}\n\n## Outcomes\n\n- Brief\n\n## Connections\n\n- None\n\n## Team\n\nResearcher\n\n## Chief of Staff\n\nresearcher\n\n## Completion rule\n\nReturn a brief.\n`;
}

async function createShare(bearer: string, markdown = packageMarkdown()) {
  const response = await call("/v1/bot-shares", {
    method: "POST",
    bearer,
    body: { packageMarkdown: markdown },
  });
  expect(response.status).toBe(201);
  return response.json<{ share: { id: string; activeVersion: number; sha256: string; packageUrl: string } }>();
}

describe("managed bot shares", () => {
  it("requires account ownership and keeps local package metadata canonical", async () => {
    const owner = await signIn("share-owner@example.com");
    const other = await signIn("share-other@example.com");
    expect((await call("/v1/bot-shares", { method: "POST", body: { packageMarkdown: packageMarkdown() } })).status).toBe(401);

    const { share } = await createShare(owner, packageMarkdown("UTF-8 мышь"));
    expect(share.id).toMatch(/^[A-Za-z0-9_-]{21}$/);
    expect(share.activeVersion).toBe(1);
    expect(share.packageUrl).toBe(`https://accounts.openmausbot.com/v1/bot-shares/${share.id}/package`);
    expect((await call("/v1/bot-shares", { bearer: other }).then((response) => response.json<{ shares: unknown[] }>())))
      .toEqual({ shares: [] });

    const smuggled = packageMarkdown().replace("botmrr: 1", "botmrr: 1\naccountToken: secret-value") + "\n<!-- private runtime memory -->"; // secret-scan: allow-test-fixture
    const sanitized = await createShare(owner, smuggled);
    const stored = await call(`/v1/bot-shares/${sanitized.share.id}/package`);
    const storedMarkdown = await stored.text();
    expect(storedMarkdown).not.toContain("accountToken");
    expect(storedMarkdown).toContain("mascotBody: star");
    expect(await call(`/v1/bot-shares/${share.id}/visibility`, { method: "POST", bearer: other, body: { visibility: "private" } })).toMatchObject({ status: 404 });
  });

  it("uses immutable versions with compare-and-swap conflict handling and tombstone delete", async () => {
    const bearer = await signIn("share-lifecycle@example.com");
    const { share: created } = await createShare(bearer, packageMarkdown("First"));
    const updated = await call(`/v1/bot-shares/${created.id}/versions`, {
      method: "POST", bearer,
      body: { packageMarkdown: packageMarkdown("Second"), expectedActiveVersion: 1 },
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toMatchObject({ share: { activeVersion: 2, name: "Second" } });

    const stale = await call(`/v1/bot-shares/${created.id}/versions`, {
      method: "POST", bearer,
      body: { packageMarkdown: packageMarkdown("Lost update"), expectedActiveVersion: 1 },
    });
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ error: "version_conflict" });

    expect((await call(`/v1/bot-shares/${created.id}`, { method: "DELETE", bearer })).status).toBe(204);
    expect((await call(`/v1/bot-shares/${created.id}/package`)).status).toBe(404);
    const versions = await env.DB.prepare("SELECT version FROM bot_share_versions WHERE share_id = ? ORDER BY version")
      .bind(created.id).all<{ version: number }>();
    expect(versions.results.map((row) => row.version)).toEqual([1, 2]);
  });

  it("serves only public active packages and escapes the landing page", async () => {
    const bearer = await signIn("share-public@example.com");
    const { share } = await createShare(bearer, packageMarkdown("<Unsafe & Bot>", "<img src=x onerror=alert(1)>"));
    const pkg = await call(`/v1/bot-shares/${share.id}/package`);
    expect(pkg.status).toBe(200);
    expect(pkg.headers.get("content-type")).toContain("text/markdown");
    expect(pkg.headers.get("x-content-sha256")).toBe(share.sha256);
    const landing = await call(`/s/${share.id}`);
    expect(landing.status).toBe(200);
    const html = await landing.text();
    expect(html).toContain("&lt;Unsafe &amp; Bot&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<script");
    expect(html).toContain("Download BotMRR package");
    expect(html).not.toContain("openmausbot://");
    expect(pkg.headers.get("cache-control")).toBe("no-store");
    expect(landing.headers.get("cache-control")).toBe("no-store");
  });

  it("enforces per-account share and immutable-version quotas in D1", async () => {
    const ownerEmail = "share-quota@example.com";
    const bearer = await signIn(ownerEmail);
    const owner = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
      .bind(ownerEmail).first<{ id: string }>();
    if (!owner) throw new Error("missing quota owner");
    const now = Date.now();
    await env.DB.batch(Array.from({ length: BOT_SHARE_MAX_PER_OWNER }, (_, index) => {
      const id = `quota-${String(index).padStart(15, "0")}`;
      return env.DB.prepare("INSERT INTO bot_shares (id, owner_user_id, visibility, active_version, created_at, updated_at) VALUES (?, ?, 'private', 1, ?, ?)")
        .bind(id, owner.id, now, now);
    }));
    const shareLimit = await call("/v1/bot-shares", {
      method: "POST", bearer, body: { packageMarkdown: packageMarkdown() },
    });
    expect(shareLimit.status).toBe(409);
    await expect(shareLimit.json()).resolves.toEqual({ error: "share_limit_reached" });

    const versionToken = await signIn("version-quota@example.com");
    const { share } = await createShare(versionToken);
    await env.DB.batch(Array.from({ length: BOT_SHARE_MAX_VERSIONS - 1 }, (_, index) => {
      const version = index + 2;
      return env.DB.prepare("INSERT INTO bot_share_versions (share_id, version, name, summary, package_markdown, package_sha256, package_bytes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(share.id, version, `Version ${version}`, "Quota fixture", packageMarkdown(), "0".repeat(64), 1, now + version);
    }));
    const versionLimit = await call(`/v1/bot-shares/${share.id}/versions`, {
      method: "POST", bearer: versionToken,
      body: { packageMarkdown: packageMarkdown("Too many"), expectedActiveVersion: BOT_SHARE_MAX_VERSIONS },
    });
    expect(versionLimit.status).toBe(409);
    await expect(versionLimit.json()).resolves.toEqual({ error: "version_limit_reached" });
  });

  it("allows worst-case JSON escaping within the transport budget", async () => {
    const bearer = await signIn("share-json-budget@example.com");
    const response = await call("/v1/bot-shares", {
      method: "POST",
      bearer,
      body: {
        packageMarkdown: "\u0000".repeat(BOT_SHARE_PACKAGE_MAX_BYTES),
        visibility: "private",
      },
    });
    // The package itself is invalid, but it must reach package validation
    // rather than being rejected by the transport envelope first.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_package" });
  });
});
