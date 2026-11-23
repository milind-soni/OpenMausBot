import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { planSync } from "../src/service.mjs";

test("planSync triggers T3 when primary instance token differs from toolbox current_account_id", () => {
  const currentAccountId = "acc-target-switch";
  const accounts = [
    {
      id: "acc-target-switch",
      email: "switch@example.com",
      disabled: false,
      proxy_disabled: false,
      token: { refresh_token: "refresh-token-switch" },
      quota: { subscription_tier: "PRO", models: [{ name: "gemini-3.8-flash-high", percentage: 95 }] }
    },
    {
      id: "acc-old-primary",
      email: "old@example.com",
      disabled: false,
      proxy_disabled: false,
      token: { refresh_token: "refresh-token-old" },
      quota: { subscription_tier: "PRO", models: [{ name: "gemini-3.8-flash-high", percentage: 50 }] }
    }
  ];

  const instances = [
    {
      instanceId: "antigravity",
      tokenPath: "C:/mock/providers/antigravity/hash/antigravity-acp/acp_token.json",
      currentToken: {
        refresh_token: "refresh-token-old",
        scopes: ["https://www.googleapis.com/auth/aicode"]
      },
      boundAccount: accounts[1]
    }
  ];

  const decisions = planSync({
    currentAccountId,
    accounts,
    instances,
    syncPolicy: "primary-and-unhealthy"
  });

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].instanceId, "antigravity");
  assert.equal(decisions[0].reason, "T3_MANUAL_SWITCH");
  assert.equal(decisions[0].toAccountId, "acc-target-switch");
});

test("planSync triggers T1 when an instance account hits 0% quota and preserves fleet diversity", () => {
  const accounts = [
    {
      id: "acc-healthy-1",
      email: "h1@example.com",
      disabled: false,
      proxy_disabled: false,
      token: { refresh_token: "token-h1" },
      quota: { subscription_tier: "PRO", models: [{ name: "gemini-3.8-flash-high", percentage: 90 }] }
    },
    {
      id: "acc-healthy-2",
      email: "h2@example.com",
      disabled: false,
      proxy_disabled: false,
      token: { refresh_token: "token-h2" },
      quota: { subscription_tier: "PRO", models: [{ name: "gemini-3.8-flash-high", percentage: 80 }] }
    },
    {
      id: "acc-exhausted",
      email: "ex@example.com",
      disabled: false,
      proxy_disabled: false,
      token: { refresh_token: "token-ex" },
      quota: { subscription_tier: "PRO", models: [{ name: "gemini-3.8-flash-high", percentage: 0 }] }
    }
  ];

  const instances = [
    {
      instanceId: "antigravity-1",
      tokenPath: "path1",
      currentToken: { refresh_token: "token-h1", scopes: ["https://www.googleapis.com/auth/aicode"] },
      boundAccount: accounts[0]
    },
    {
      instanceId: "antigravity-2",
      tokenPath: "path2",
      currentToken: { refresh_token: "token-ex", scopes: ["https://www.googleapis.com/auth/aicode"] },
      boundAccount: accounts[2]
    }
  ];

  const decisions = planSync({
    currentAccountId: "acc-healthy-1",
    accounts,
    instances,
    syncPolicy: "primary-and-unhealthy"
  });

  // Only antigravity-2 should be synced, and it should pick acc-healthy-2 (diversity: acc-healthy-1 is already on antigravity-1)
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].instanceId, "antigravity-2");
  assert.equal(decisions[0].reason, "T1_QUOTA_ZERO");
  assert.equal(decisions[0].toAccountId, "acc-healthy-2");
});

test("planSync triggers T4 when current token is corrupted or missing scopes", () => {
  const accounts = [
    {
      id: "acc-healthy",
      email: "h@example.com",
      disabled: false,
      proxy_disabled: false,
      token: { refresh_token: "token-healthy" },
      quota: { subscription_tier: "PRO", models: [{ name: "gemini-3.8-flash-high", percentage: 90 }] }
    }
  ];

  const instances = [
    {
      instanceId: "antigravity",
      tokenPath: "path",
      currentToken: null, // missing file or invalid json
      boundAccount: null
    }
  ];

  const decisions = planSync({
    currentAccountId: "acc-healthy",
    accounts,
    instances,
    syncPolicy: "primary-and-unhealthy"
  });

  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].instanceId, "antigravity");
  assert.equal(decisions[0].reason, "T4_TOKEN_REPAIR");
  assert.equal(decisions[0].toAccountId, "acc-healthy");
});
